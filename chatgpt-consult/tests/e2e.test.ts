import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { BrowserJob } from "../src/browser/worker";
import {
  BROWSER_RESULT_BEGIN,
  BROWSER_RESULT_END,
} from "../src/browser/protocol";
import { ContextService } from "../src/context/selection";
import {
  DEFAULT_BUDGET,
  HARD_BUDGET,
  type ConsultationCompletion,
} from "../src/core/schema";
import {
  ConsultationService,
  initializeProject,
  type BrowserWorkerLauncher,
} from "../src/core/service";
import { RequestStore } from "../src/core/store";
import { startChatgptHttp, type RunningHttpServer } from "../src/mcp/http";
import { createLocalMcp } from "../src/mcp/local";
import { resolveProject } from "../src/security/project";

const fixtureSource = fileURLToPath(new URL("./fixtures/project", import.meta.url));
const baseTime = new Date("2026-08-31T08:00:00.000Z");
const temporaryPaths: string[] = [];
const runningServers: RunningHttpServer[] = [];

const completion = (answer = "Add bounded jitter to queue retries."): ConsultationCompletion => ({
  summary: "Retry policy review",
  answer,
  evidence: ["src/queue.ts", "src/queue.test.ts"],
  assumptions: ["Workers may retry concurrently."],
  risks: ["Synchronized retries can amplify load."],
  recommendations: ["Use capped exponential backoff with jitter."],
  followUpQuestions: ["What is the retry ceiling?"],
});

const runGit = (root: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const detectMime = async (path: string): Promise<string> => {
  const content = await readFile(path);
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  const text = content.toString("utf8");
  if (text.startsWith("<svg")) return "image/svg+xml";
  if (text.startsWith("<html")) return "text/html";
  return "text/plain";
};

interface Fixture {
  root: string;
  store: RequestStore;
  context: ContextService;
  service: ConsultationService;
  setNow(value: Date): void;
}

const makeFixture = async (workerLauncher?: BrowserWorkerLauncher): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-e2e-"));
  temporaryPaths.push(root);
  await cp(fixtureSource, root, { recursive: true });
  runGit(root, "init", "-q");
  runGit(root, "config", "user.email", "fixture@example.invalid");
  runGit(root, "config", "user.name", "Fixture");
  const project = await resolveProject(root);
  await initializeProject(project, {});
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "fixture");

  await appendFile(
    join(root, "src", "queue.ts"),
    "\nexport const retryJitter = (attempt: number) => attempt * 10;\n",
  );
  await writeFile(
    join(root, "review.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  let now = baseTime;
  let randomCall = 0;
  const store = await RequestStore.init(project, {
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 41 + randomCall++),
  });
  const context = new ContextService(project, store, { detectMime });
  const service = new ConsultationService(project, store, context, {
    now: () => now,
    ...(workerLauncher ? { workerLauncher } : {}),
  });
  return {
    root,
    store,
    context,
    service,
    setNow: (value) => { now = value; },
  };
};

const startServer = async (fixture: Fixture): Promise<RunningHttpServer> => {
  const server = await startChatgptHttp({
    store: fixture.store,
    context: fixture.context,
    hostname: "127.0.0.1",
    port: 0,
  });
  runningServers.push(server);
  return server;
};

const connectLocal = async (fixture: Fixture) => {
  const server = createLocalMcp(fixture.service);
  const client = new Client({ name: "chatgpt-consult-browser-e2e", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
};

const connect = async (server: RunningHttpServer): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
  const client = new Client({ name: "chatgpt-consult-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
};

const structured = (result: { structuredContent?: unknown }): Record<string, unknown> => {
  expect(result.structuredContent).toBeObject();
  return result.structuredContent as Record<string, unknown>;
};

const startInput = (overrides: Record<string, unknown> = {}) => ({
  goal: "Decide whether queue retries need jitter",
  profile: "analysis" as const,
  files: ["src/queue.ts"],
  smart: false,
  attachments: [] as string[],
  diff: "none" as const,
  open: false,
  allowSensitive: false,
  connectors: [] as string[],
  ...overrides,
});

afterEach(async () => {
  await Promise.allSettled(runningServers.splice(0).map((server) => server.stop()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("no-account end-to-end consultation", () => {
  test("runs the automatic browser lifecycle through only the six local MCP tools", async () => {
    const configuredProjectUrl = "https://chatgpt.com/g/g-p-browser-e2e/project";
    const conversationUrl = "https://chatgpt.com/g/g-p-browser-e2e/c/browser-e2e-conversation";
    const automationCalls: Array<{
      requestId: string;
      targetUrl: string;
      uploadCount: number;
    }> = [];
    let runBrowser = async (_requestId: string): Promise<void> => {
      throw new Error("browser job is not configured");
    };
    const fixture = await makeFixture({ start: (requestId) => runBrowser(requestId) });
    const project = await resolveProject(fixture.root);
    const session = {
      pid: 100,
      port: 9_222,
      webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/e2e",
      profileDir: null,
      ownership: "external" as const,
      visibility: "external" as const,
      reused: true,
    };
    const job = new BrowserJob({
      project,
      store: fixture.store,
      projectUrl: configuredProjectUrl,
      sessionManager: {
        ensureRunning: async () => session,
        switchOwnedToHeaded: async () => session,
      },
      automation: {
        run: async (input, hooks) => {
          automationCalls.push({
            requestId: input.requestId,
            targetUrl: input.targetUrl,
            uploadCount: input.uploadPaths.length,
          });
          for (const path of input.uploadPaths) {
            expect(await lstat(path).then((value) => value.isFile())).toBeTrue();
          }
          await hooks.beforeSubmission();
          await hooks.submissionConfirmed(conversationUrl);
          const request = await fixture.store.get(input.requestId);
          return {
            kind: "completed" as const,
            conversationUrl,
            responseText: [
              BROWSER_RESULT_BEGIN,
              JSON.stringify({
                schemaVersion: 1,
                requestId: input.requestId,
                expectedRevision: request.revision,
                completion: completion(`Browser result for ${input.requestId}.`),
              }),
              BROWSER_RESULT_END,
            ].join("\n"),
          };
        },
        waitForAuthenticatedProject: async () => "authenticated" as const,
      },
    });
    let ownerSequence = 0;
    runBrowser = async (requestId) => {
      ownerSequence += 1;
      expect(await job.run(requestId, ownerSequence.toString(16).padStart(32, "0")))
        .toEqual({ kind: "completed", requestId });
    };

    const { client, server } = await connectLocal(fixture);
    const forbiddenHttpListener = spyOn(Bun, "serve").mockImplementation(() => {
      throw new Error("The simulated local lifecycle invoked the HTTP MCP listener");
    });
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "consult_start",
        "consult_status",
        "consult_show",
        "consult_followup",
        "consult_cancel",
        "consult_publish",
      ]);
      const startedResult = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Review browser-backed queue retries",
          profile: "lean",
          files: ["src/queue.ts"],
          open: true,
          idempotency_key: "browser-e2e-root",
        },
      });
      const started = structured(startedResult);
      const requestId = started.requestId as string;
      expect(startedResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("consult_show"),
      });
      let statusResult = await client.callTool({
        name: "consult_status",
        arguments: { request_id: requestId },
      });
      let status = structured(statusResult);
      for (let poll = 0; status.state !== "completed" && poll < 4; poll += 1) {
        statusResult = await client.callTool({
          name: "consult_status",
          arguments: { request_id: requestId },
        });
        status = structured(statusResult);
      }
      expect(status).toMatchObject({
        state: "completed",
        completionSource: "browser",
        browser: {
          phase: "completed",
          submissionCertainty: "submitted",
          conversationUrl,
        },
      });
      expect(statusResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("consult_show"),
      });
      const shown = structured(await client.callTool({
        name: "consult_show",
        arguments: { request_id: requestId },
      }));
      expect(shown).toMatchObject({
        completionSource: "browser",
        completion: { answer: expect.stringContaining(requestId) },
      });

      const followed = structured(await client.callTool({
        name: "consult_followup",
        arguments: {
          parent_id: requestId,
          goal: "Check the same-chat attachment path",
          profile: "lean",
          attachments: ["review.png"],
          open: true,
          idempotency_key: "browser-e2e-followup",
        },
      }));
      const childId = followed.requestId as string;
      expect(structured(await client.callTool({
        name: "consult_status",
        arguments: { request_id: childId },
      }))).toMatchObject({
        state: "completed",
        completionSource: "browser",
        browser: { conversationUrl },
      });
      expect(automationCalls).toEqual([
        { requestId, targetUrl: configuredProjectUrl, uploadCount: 0 },
        { requestId: childId, targetUrl: conversationUrl, uploadCount: 1 },
      ]);

      const pending = structured(await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Cancel this separate pending consultation",
          profile: "lean",
          open: false,
          idempotency_key: "browser-e2e-cancel",
        },
      }));
      expect(structured(await client.callTool({
        name: "consult_cancel",
        arguments: { request_id: pending.requestId },
      }))).toMatchObject({ state: "cancelled" });

      expect(await exists(join(fixture.root, "docs", "consultations"))).toBeFalse();
      const published = structured(await client.callTool({
        name: "consult_publish",
        arguments: {
          request_id: requestId,
          output: "docs/consultations/browser-e2e.md",
        },
      }));
      expect(published).toEqual({ path: "docs/consultations/browser-e2e.md" });
      expect(await readFile(join(fixture.root, published.path as string), "utf8"))
        .toContain("Browser result");

      expect(forbiddenHttpListener).not.toHaveBeenCalled();
    } finally {
      try {
        await client.close();
        await server.close();
      } finally {
        forbiddenHttpListener.mockRestore();
      }
    }
  });

  test("runs the real HTTP six-tool lifecycle, publishes explicitly, and links a follow-up", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start(startInput({
      files: ["src/queue.ts"],
      smart: true,
      attachments: ["review.png"],
      diff: "working",
      idempotencyKey: "e2e-parent",
    }));
    const server = await startServer(fixture);
    const client = await connect(server);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "request_get",
        "context_search",
        "context_read",
        "diff_get",
        "attachment_get",
        "request_complete",
      ]);
      const auth = { request_id: started.requestId, claim_token: started.claimToken };
      const claimed = await client.callTool({ name: "request_get", arguments: auth });
      expect(structured(claimed)).toMatchObject({
        request: { requestId: started.requestId, state: "claimed", revision: 1 },
      });
      const searched = await client.callTool({
        name: "context_search",
        arguments: { ...auth, query: "retry" },
      });
      expect((structured(searched).hits as unknown[]).length).toBeGreaterThan(0);
      const read = await client.callTool({
        name: "context_read",
        arguments: { ...auth, path: "src/queue.ts", offset: 0, limit: 4_096 },
      });
      expect(JSON.stringify(read)).toContain("retryJitter");
      const diff = await client.callTool({
        name: "diff_get",
        arguments: { ...auth, offset: 0, limit: 8_192 },
      });
      expect(JSON.stringify(diff)).toContain("retryJitter");
      const request = structured(claimed).request as {
        attachments: Array<{ id: string }>;
      };
      const attachment = await client.callTool({
        name: "attachment_get",
        arguments: { ...auth, attachment_id: request.attachments[0]!.id },
      });
      expect(attachment.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      await fixture.store.setConversationUrl(
        started.requestId,
        "https://chatgpt.com/c/e2e-conversation?ignored=1#fragment",
      );
      const completed = await client.callTool({
        name: "request_complete",
        arguments: { ...auth, expected_revision: 1, completion: completion() },
      });
      expect(structured(completed)).toMatchObject({ state: "completed", revision: 2 });

      expect((await fixture.service.show(started.requestId)).completion?.answer)
        .toContain("jitter");
      expect(await exists(join(fixture.root, "docs", "consultations"))).toBeFalse();
      const published = await fixture.service.publish(started.requestId);
      expect(published.path).toMatch(/^docs\/consultations\//);
      expect(await readFile(join(fixture.root, published.path), "utf8")).toContain("jitter");

      const child = await fixture.service.followup({
        parentId: started.requestId,
        goal: "Now review cancellation behavior",
        files: ["src/queue.test.ts"],
        smart: false,
        attachments: [],
        diff: "none",
        open: false,
        allowSensitive: false,
        idempotencyKey: "e2e-child",
      });
      expect(await fixture.store.get(child.requestId)).toMatchObject({
        parentId: started.requestId,
        conversationUrl: "https://chatgpt.com/c/e2e-conversation",
      });
      const childAuth = { request_id: child.requestId, claim_token: child.claimToken };
      await client.callTool({ name: "request_get", arguments: childAuth });
      await client.callTool({
        name: "request_complete",
        arguments: {
          ...childAuth,
          expected_revision: 1,
          completion: completion("Cancellation should stop scheduled retry work."),
        },
      });
      expect(await fixture.service.status(child.requestId)).toMatchObject({
        state: "completed",
        parentId: started.requestId,
      });
    } finally {
      await client.close();
    }
  });

  test("rejects unsafe paths, sensitive files, path overflow, and unsafe attachments", async () => {
    const fixture = await makeFixture();
    const outside = await mkdtemp(join(tmpdir(), "chatgpt-consult-e2e-outside-"));
    temporaryPaths.push(outside);
    await writeFile(join(outside, "outside.ts"), "export const privateValue = 1;\n");
    await symlink(join(outside, "outside.ts"), join(fixture.root, "escaped.ts"));
    await writeFile(join(fixture.root, ".env"), "SERVICE_TOKEN=secret\n");
    await writeFile(
      join(fixture.root, "private.pem"),
      "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
    );
    await writeFile(join(fixture.root, "active.svg"), "<svg><script /></svg>");
    await writeFile(join(fixture.root, "active.html"), "<html><script /></html>");
    await writeFile(join(fixture.root, "large.png"), Buffer.alloc(9, 1));

    for (const path of ["../outside.ts", "escaped.ts"]) {
      await expect(fixture.service.start(startInput({ files: [path] })))
        .rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    }
    for (const path of [".env", "private.pem"]) {
      await expect(fixture.service.start(startInput({ files: [path] })))
        .rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN_PATH|SENSITIVE_CONTENT/) });
    }

    const paths: string[] = [];
    for (let index = 0; index < 26; index += 1) {
      const path = `src/overflow-${index}.ts`;
      paths.push(path);
      await writeFile(join(fixture.root, path), `export const value${index} = ${index};\n`);
    }
    await expect(fixture.service.start(startInput({ files: paths })))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    await writeFile(
      join(fixture.root, "src", "oversized.ts"),
      "x".repeat(HARD_BUDGET.maxServedTextBytes + 1),
    );
    await expect(fixture.service.start(startInput({ files: ["src/oversized.ts"] })))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    await expect(fixture.service.start(startInput({
      attachments: ["large.png"],
      budget: { ...DEFAULT_BUDGET, maxAttachmentBytes: 8 },
    }))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    for (const path of ["active.svg", "active.html"]) {
      await expect(fixture.service.start(startInput({ attachments: [path] })))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await exists(join(fixture.root, "docs", "consultations"))).toBeFalse();
  });

  test("caps search at 50 hits and rejects claims, terminal completions, Host, and Origin", async () => {
    const fixture = await makeFixture();
    await writeFile(
      join(fixture.root, "src", "many.ts"),
      Array.from({ length: 51 }, (_, index) => `export const retry${index} = "retry";`).join("\n"),
    );
    const searchedRequest = await fixture.service.start(startInput({
      files: ["src/many.ts"],
      idempotencyKey: "e2e-search-cap",
    }));
    const server = await startServer(fixture);
    const client = await connect(server);
    try {
      const searchAuth = {
        request_id: searchedRequest.requestId,
        claim_token: searchedRequest.claimToken,
      };
      await client.callTool({ name: "request_get", arguments: searchAuth });
      const firstSearch = await client.callTool({
        name: "context_search",
        arguments: { ...searchAuth, query: "retry" },
      });
      expect(structured(firstSearch).hits).toHaveLength(50);
      const refusedFiftyFirst = await client.callTool({
        name: "context_search",
        arguments: { ...searchAuth, query: "retry" },
      });
      expect(structured(refusedFiftyFirst).hits).toEqual([]);

      const wrong = await fixture.service.start(startInput({ idempotencyKey: "e2e-wrong" }));
      const wrongClaim = await client.callTool({
        name: "request_get",
        arguments: { request_id: wrong.requestId, claim_token: "A".repeat(43) },
      });
      expect(wrongClaim.isError).toBeTrue();
      expect(structured(wrongClaim)).toMatchObject({ error: { code: "NOT_FOUND" } });

      const expiring = await fixture.service.start(startInput({
        idempotencyKey: "e2e-expired",
        budget: { ...DEFAULT_BUDGET, expiresAfterMs: 1 },
      }));
      fixture.setNow(new Date(baseTime.getTime() + 2));
      const expired = await client.callTool({
        name: "request_get",
        arguments: { request_id: expiring.requestId, claim_token: expiring.claimToken },
      });
      expect(expired.isError).toBeTrue();
      expect(structured(expired)).toMatchObject({ error: { code: "EXPIRED" } });
      fixture.setNow(baseTime);

      const cancelled = await fixture.service.start(startInput({ idempotencyKey: "e2e-cancelled" }));
      const cancelledAuth = {
        request_id: cancelled.requestId,
        claim_token: cancelled.claimToken,
      };
      await client.callTool({ name: "request_get", arguments: cancelledAuth });
      await fixture.service.cancel(cancelled.requestId);
      const cancelledCompletion = await client.callTool({
        name: "request_complete",
        arguments: { ...cancelledAuth, expected_revision: 1, completion: completion() },
      });
      expect(cancelledCompletion.isError).toBeTrue();
      expect(await fixture.store.getCompletion(cancelled.requestId)).toBeNull();

      const duplicate = await fixture.service.start(startInput({ idempotencyKey: "e2e-duplicate" }));
      const duplicateAuth = {
        request_id: duplicate.requestId,
        claim_token: duplicate.claimToken,
      };
      await client.callTool({ name: "request_get", arguments: duplicateAuth });
      await client.callTool({
        name: "request_complete",
        arguments: { ...duplicateAuth, expected_revision: 1, completion: completion() },
      });
      const conflicting = await client.callTool({
        name: "request_complete",
        arguments: {
          ...duplicateAuth,
          expected_revision: 1,
          completion: completion("A conflicting second answer."),
        },
      });
      expect(conflicting.isError).toBeTrue();
      expect((await fixture.service.show(duplicate.requestId)).completion?.answer)
        .toBe(completion().answer);

      for (const headers of [
        { Host: "evil.example" },
        { Origin: "https://evil.example" },
      ]) {
        const response = await fetch(server.mcpUrl, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        expect(response.status).toBe(403);
      }
      expect(await exists(join(fixture.root, "docs", "consultations"))).toBeFalse();
    } finally {
      await client.close();
    }
  });

  test("completes through a private manual bundle when the browser and MCP are disconnected", async () => {
    const workerLauncher: BrowserWorkerLauncher = {
      start: async () => { throw new Error("browser disconnected"); },
    };
    const fixture = await makeFixture(workerLauncher);
    const started = await fixture.service.start(startInput({
      files: ["src/queue.ts"],
      attachments: ["review.png"],
      diff: "working",
      open: true,
      idempotencyKey: "e2e-manual",
    }));
    expect(started.browser).toMatchObject({
      phase: "needs_manual",
      reason: "browser_unavailable",
    });
    expect(JSON.stringify(started.browser)).not.toContain(started.claimToken);

    const bundle = await fixture.service.manualBundle(started.requestId);
    expect(bundle.path).toBe(`.chatgpt-consult/manual/${started.requestId}.md`);
    expect(bundle.text).toContain("Decide whether queue retries need jitter");
    expect(bundle.text).not.toContain(started.claimToken);
    expect(await lstat(join(fixture.root, bundle.path)).then((info) => info.mode & 0o777))
      .toBe(0o600);

    await fixture.service.importManualCompletion(
      started.requestId,
      completion("Manual review recommends jitter without any live MCP connection."),
    );
    expect(await fixture.service.show(started.requestId)).toMatchObject({
      state: "completed",
      completionSource: "manual",
      completion: { answer: expect.stringContaining("jitter") },
    });
    expect(await exists(join(fixture.root, "docs", "consultations"))).toBeFalse();
  });
});
