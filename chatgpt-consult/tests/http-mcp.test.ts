import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ContextService } from "../src/context/selection";
import { ConsultationService } from "../src/core/service";
import { RequestStore } from "../src/core/store";
import {
  closeHttpResources,
  requireLoopbackBinding,
  startChatgptHttp,
  type RunningHttpServer,
} from "../src/mcp/http";
import { resolveProject } from "../src/security/project";
import { main } from "../src/cli/main";

const temporaryPaths: string[] = [];
const runningServers: RunningHttpServer[] = [];
const absoluteBin = join(dirname(import.meta.dir), "bin", "chatgpt-consult.ts");
const mainModuleUrl = new URL("../src/cli/main.ts", import.meta.url).href;

interface Fixture {
  root: string;
  store: RequestStore;
  context: ContextService;
  service: ConsultationService;
}

const makeFixture = async (prefix = "chatgpt-consult-http-"): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "queue.ts"), "export const queue = [];\n");
  const project = await resolveProject(root);
  const store = await RequestStore.init(project);
  const context = new ContextService(project, store);
  const service = new ConsultationService(project, store, context);
  return { root, store, context, service };
};

const startServer = async (
  fixture: Fixture,
  bodyLimitBytes?: number,
): Promise<RunningHttpServer> => {
  const server = await startChatgptHttp({
    store: fixture.store,
    context: fixture.context,
    hostname: "127.0.0.1",
    port: 0,
    ...(bodyLimitBytes === undefined ? {} : { bodyLimitBytes }),
  });
  runningServers.push(server);
  return server;
};

const reservePort = (): number => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("TCP probe did not expose a port");
  return port;
};

const streamedBody = (chunks: string[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
    controller.close();
  },
});

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const waitForHealth = async (url: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // The child has not bound its listener yet.
    }
    await Bun.sleep(20);
  }
  throw new Error("HTTP MCP did not become healthy");
};

afterEach(async () => {
  await Promise.allSettled(runningServers.splice(0).map((server) => server.stop()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("guarded ChatGPT Streamable HTTP MCP", () => {
  test("binds loopback and exposes only the exact compact health route", async () => {
    const fixture = await makeFixture();
    const server = await startServer(fixture);

    expect(server.hostname).toBe("127.0.0.1");
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    expect(server.mcpUrl).toBe(`${server.url}/mcp`);
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toContain("application/json");
    expect(await health.json()).toEqual({
      status: "ok",
      surface: "chatgpt",
      schemaVersion: 1,
    });
    for (const [path, method] of [
      ["/other", "GET"],
      ["/health/", "GET"],
      ["/health", "POST"],
      ["/mcp/", "GET"],
    ] as const) {
      expect((await fetch(`${server.url}${path}`, { method })).status).toBe(404);
    }
    for (const method of ["GET", "DELETE"] as const) {
      expect((await fetch(server.mcpUrl, {
        method,
        headers: { Accept: "text/event-stream" },
      })).status).toBe(405);
    }
  });

  test("rejects hostile Host before a valid request_get can claim its request", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({
      goal: "Review queue policy",
      profile: "lean",
      files: ["src/queue.ts"],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
    });
    const server = await startServer(fixture, 4_096);
    expect((await fetch(server.mcpUrl, {
      method: "POST",
      headers: { Host: "evil.example", "Content-Type": "application/json" },
      body: "x".repeat(4_097),
    })).status).toBe(403);
    let hostile = false;
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (hostile) headers.set("Host", "evil.example");
        return fetch(input, { ...init, headers });
      },
    });
    const client = new Client({ name: "host-guard-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      hostile = true;
      await expect(client.callTool({
        name: "request_get",
        arguments: {
          request_id: started.requestId,
          claim_token: started.claimToken,
        },
      })).rejects.toThrow();
      expect((await fixture.store.get(started.requestId)).state).toBe("pending");
    } finally {
      await client.close();
    }
  });

  test("rejects hostile Origin before a valid request_get can claim its request", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({
      goal: "Review queue policy",
      profile: "lean",
      files: ["src/queue.ts"],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
    });
    const server = await startServer(fixture, 4_096);
    expect((await fetch(server.mcpUrl, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "x".repeat(4_097),
    })).status).toBe(403);
    let hostile = false;
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (hostile) headers.set("Origin", "https://evil.example");
        return fetch(input, { ...init, headers });
      },
    });
    const client = new Client({ name: "origin-guard-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      hostile = true;
      await expect(client.callTool({
        name: "request_get",
        arguments: {
          request_id: started.requestId,
          claim_token: started.claimToken,
        },
      })).rejects.toThrow();
      expect((await fixture.store.get(started.requestId)).state).toBe("pending");
    } finally {
      await client.close();
    }
  });

  test("rejects unsafe listener and body-limit options before binding", async () => {
    const fixture = await makeFixture();
    const port = reservePort();
    for (const hostname of ["", "localhost", "0.0.0.0", "::1", "192.0.2.1"]) {
      await expect(startChatgptHttp({
        store: fixture.store,
        context: fixture.context,
        hostname,
        port,
      })).rejects.toThrow();
    }
    for (const bodyLimitBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(startChatgptHttp({
        store: fixture.store,
        context: fixture.context,
        hostname: "127.0.0.1",
        port,
        bodyLimitBytes,
      })).rejects.toThrow();
    }
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test("rejects declared and streamed oversized bodies before MCP parsing", async () => {
    const fixture = await makeFixture();
    const controlStarted = await fixture.service.start({
      goal: "Review queue policy",
      profile: "lean",
      files: ["src/queue.ts"],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
    });
    const understatedStarted = await fixture.service.start({
      goal: "Review queue policy",
      profile: "lean",
      files: ["src/queue.ts"],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
    });
    const server = await startServer(fixture, 256);
    const declared = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(257),
    });
    expect(declared.status).toBe(413);

    const missingLength = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: streamedBody(["x".repeat(200), "y".repeat(200)]),
    });
    expect(missingLength.status).toBe(413);

    const sideEffectingBody = (requestId: string, claimToken: string): string => JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "request_get",
        arguments: {
          request_id: requestId,
          claim_token: claimToken,
        },
      },
    });
    const control = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: sideEffectingBody(controlStarted.requestId, controlStarted.claimToken),
    });
    expect(control.status).toBe(200);
    expect((await fixture.store.get(controlStarted.requestId)).state).toBe("claimed");

    const paddedBody = sideEffectingBody(
      understatedStarted.requestId,
      understatedStarted.claimToken,
    ).padEnd(400, " ");
    const understated = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Content-Length": "1",
      },
      body: streamedBody([paddedBody]),
    });
    expect(understated.status).toBeGreaterThanOrEqual(400);
    expect(understated.status).toBeLessThan(500);
    expect((await fixture.store.get(understatedStarted.requestId)).state).toBe("pending");
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  test("leaves content-type and protocol failures to the SDK without crashing", async () => {
    const fixture = await makeFixture();
    const server = await startServer(fixture);
    const contentType = await fetch(server.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(contentType.status).toBe(415);

    const protocol = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "1900-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    expect(protocol.status).toBeGreaterThanOrEqual(400);
    expect(protocol.status).toBeLessThan(500);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  test("serves the exact six tools and a real pending request over the SDK transport", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({
      goal: "Review queue policy",
      profile: "lean",
      files: ["src/queue.ts"],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
    });
    const server = await startServer(fixture);
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
    const client = new Client({ name: "http-mcp-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "request_get",
        "context_search",
        "context_read",
        "diff_get",
        "attachment_get",
        "request_complete",
      ]);
      const claimed = await client.callTool({
        name: "request_get",
        arguments: {
          request_id: started.requestId,
          claim_token: started.claimToken,
        },
      });
      expect(claimed.isError).not.toBeTrue();
      expect(claimed.structuredContent).toMatchObject({
        request: {
          requestId: started.requestId,
          state: "claimed",
          revision: 1,
        },
      });
    } finally {
      await client.close();
    }
  });

  test("stops idempotently and closes the listening port", async () => {
    const fixture = await makeFixture();
    const server = await startServer(fixture);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);

    await Promise.all([server.stop(), server.stop()]);
    await server.stop();

    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  test("attempts listener shutdown when handler close fails", async () => {
    const closed: string[] = [];
    await expect(closeHttpResources(
      async () => {
        closed.push("handler");
        throw new Error("handler close failed");
      },
      () => { closed.push("listener"); },
    )).rejects.toThrow("handler close failed");
    expect(closed).toEqual(["handler", "listener"]);
  });

  test("attempts handler close when listener shutdown fails", async () => {
    const closed: string[] = [];
    await expect(closeHttpResources(
      async () => { closed.push("handler"); },
      () => {
        closed.push("listener");
        throw new Error("listener close failed");
      },
    )).rejects.toThrow("listener close failed");
    expect(closed).toEqual(["handler", "listener"]);
  });

  test("attempts both cleanup paths when the actual listener identity is unsafe", async () => {
    const closed: string[] = [];
    await expect(requireLoopbackBinding(
      "0.0.0.0",
      async () => {
        closed.push("handler");
      },
      () => {
        closed.push("listener");
        throw new Error("sensitive listener failure");
      },
    )).rejects.toThrow("HTTP listener cleanup failed");
    expect(closed).toEqual(["handler", "listener"]);

    await expect(requireLoopbackBinding(
      "0.0.0.0",
      async () => {},
      () => {},
    )).rejects.toThrow("HTTP listener did not bind to the required loopback address");
  });
});

describe("serve chatgpt CLI", () => {
  test("rejects every invalid option form with compact protocol-clean errors", async () => {
    const fixture = await makeFixture();
    for (const argv of [
      ["serve"],
      ["serve", "unknown"],
      ["serve", "local", "--root", fixture.root],
      ["serve", "chatgpt", "positional"],
      ["serve", "chatgpt", "--unknown", "value"],
      ["serve", "chatgpt", "--host"],
      ["serve", "chatgpt", "--host", "0.0.0.0"],
      ["serve", "chatgpt", "--host", "127.0.0.1", "--host", "127.0.0.1"],
      ["serve", "chatgpt", "--port"],
      ["serve", "chatgpt", "--port", "0"],
      ["serve", "chatgpt", "--port", "65536"],
      ["serve", "chatgpt", "--port", "12.5"],
      ["serve", "chatgpt", "--port", "43891", "--port", "43892"],
      ["serve", "chatgpt", "--root"],
      ["serve", "chatgpt", "--root", fixture.root, "--root", fixture.root],
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await main(argv, {
        cwd: fixture.root,
        write: (message) => stdout.push(message),
        writeError: (message) => stderr.push(message),
      });
      expect(exitCode).toBe(2);
      expect(stdout).toEqual([]);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toStartWith("INVALID_INPUT:");
      expect(stderr.join("\n")).not.toContain("jsonrpc");
    }
  });

  test("settles SIGINT and SIGTERM with empty stdout, safe URLs, and closed ports", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chatgpt-consult-http-cli-"));
    temporaryPaths.push(parent);
    const claim = "c".repeat(43);
    const explicitRoot = join(parent, `project-${claim}`);
    const defaultRoot = join(parent, "default-project");
    await mkdir(explicitRoot);
    await mkdir(defaultRoot);

    for (const [signal, root, explicit] of [
      ["SIGINT", defaultRoot, false],
      ["SIGTERM", explicitRoot, true],
    ] as const) {
      const port = reservePort();
      const args = [
        "bun",
        absoluteBin,
        "serve",
        "chatgpt",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        ...(explicit ? ["--root", root] : []),
      ];
      const child = Bun.spawn(args, {
        cwd: explicit ? parent : root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const healthUrl = `http://127.0.0.1:${port}/health`;
      try {
        await waitForHealth(healthUrl);
        child.kill(signal);
        const exitCode = await Promise.race([
          child.exited,
          Bun.sleep(3_000).then(() => null),
        ]);
        expect(exitCode).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      const stdoutText = await stdout;
      const stderrText = await stderr;
      expect(stdoutText).toBe("");
      expect(stderrText).toContain(`Health: ${healthUrl}`);
      expect(stderrText).toContain(`MCP: http://127.0.0.1:${port}/mcp`);
      expect(stderrText).not.toContain(root);
      expect(stderrText).not.toContain(claim);
      expect(stderrText).not.toContain("claim_token");
      await expect(fetch(healthUrl)).rejects.toThrow();
      expect(await directoryExists(join(root, ".chatgpt-consult"))).toBeTrue();
    }
    expect(await directoryExists(join(parent, ".chatgpt-consult"))).toBeFalse();
  });

  test("closes the real listener when initial diagnostic output throws", async () => {
    const fixture = await makeFixture();
    const port = reservePort();
    const script = `
      const { main } = await import(process.env.TEST_MAIN_MODULE_URL);
      let writes = 0;
      process.exitCode = await main(
        ["serve", "chatgpt", "--port", process.env.TEST_HTTP_PORT],
        {
          cwd: process.env.TEST_PROJECT_ROOT,
          write: () => {},
          writeError(message) {
            writes += 1;
            if (writes === 1) throw new Error("diagnostic sink failed");
            console.error(message);
          },
        },
      );
    `;
    const child = Bun.spawn(["bun", "-e", script], {
      env: {
        ...process.env,
        TEST_HTTP_PORT: String(port),
        TEST_MAIN_MODULE_URL: mainModuleUrl,
        TEST_PROJECT_ROOT: fixture.root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(1_000).then(() => null),
      ]);
      expect(exitCode).toBe(1);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    expect(await stdout).toBe("");
    const diagnostic = await stderr;
    expect(diagnostic).toContain("INTERNAL: The operation failed");
    expect(diagnostic).not.toContain(fixture.root);
  });
});
