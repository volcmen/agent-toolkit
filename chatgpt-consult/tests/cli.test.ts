import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main, type MainDependencies } from "../src/cli/main";
import { ConsultError } from "../src/core/errors";
import type { ChatgptSetupGuidance, SetupClientsResult } from "../src/cli/setup";
import { setupBrowserSession } from "../src/browser/runtime";
import type { ChromeSession } from "../src/browser/chrome";
import { BrowserSessionManager } from "../src/browser/session";
import type { BrowserAutomationHooks } from "../src/browser/handoff";

const temporaryPaths: string[] = [];
const absoluteBin = join(dirname(import.meta.dir), "bin", "chatgpt-consult.ts");

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-cli-"));
  temporaryPaths.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "queue.ts"), "export const queue = [];\n");
  return root;
};

const run = (root: string, ...args: string[]) => Bun.spawnSync(
  ["bun", absoluteBin, ...args],
  { cwd: root, stdout: "pipe", stderr: "pipe" },
);

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("chatgpt-consult CLI", () => {
  const previewSetup: SetupClientsResult = {
    kind: "clients",
    mode: "preview",
    success: true,
    clients: [
      {
        client: "codex",
        status: "absent",
        action: "add",
        addArgv: ["codex", "mcp", "add", "chatgpt-consult", "--", "bun", "run", "/tmp/bin with space.ts", "serve", "local"],
        message: "Entry not found",
      },
      {
        client: "claude",
        status: "skipped",
        action: "skipped",
        message: "claude CLI not available",
      },
    ],
  };

  const chatgptGuidance: ChatgptSetupGuidance = {
    kind: "chatgpt",
    recommended: {
      initCommand: "chatgpt-consult init --chatgpt-project-url <chatgpt-project-url>",
      clientsCommand: "chatgpt-consult setup clients --apply",
      browserCommand: "chatgpt-consult setup browser",
      doctorCommand: "chatgpt-consult doctor",
      startCommand: "chatgpt-consult start \"Review the queue retry policy\" --profile lean --file src/queue.ts --open",
      steps: [
        "Configure a topic-scoped ChatGPT Project URL in ignored local state.",
        "Register the local six-tool MCP with Codex and Claude.",
        "Open the dedicated headed browser and sign in directly on ChatGPT.",
        "Run doctor, then start a bounded automatic consultation.",
        "Poll status until completion or a typed login/manual recovery state.",
      ],
    },
    manualFallback: {
      handoff: "chatgpt-consult handoff <id>",
      importResult: "chatgpt-consult import-result <id> --input <file>",
    },
    legacyCompatibility: {
      optional: true,
      neverAutoStarted: true,
      startCommand: "chatgpt-consult serve chatgpt",
      healthUrl: "http://127.0.0.1:43891/health",
      mcpUrl: "http://127.0.0.1:43891/mcp",
      healthCommand: "curl --fail --silent http://127.0.0.1:43891/health",
      tunnelDocumentationUrl: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
      requiredTools: ["request_get", "context_search", "context_read", "diff_get", "attachment_get", "request_complete"],
    },
  };

  test("setup browser validates, persists, and opens explicit CDP or managed mode", async () => {
    const root = await makeProject();
    const projectUrl = "https://chatgpt.com/g/projects/setup-browser";
    await initializeConfigWithProjectUrl(root, projectUrl);
    const opened: Array<{ port?: number; projectUrl?: string }> = [];
    const setupBrowser = async (
      input: Parameters<NonNullable<MainDependencies["setupBrowser"]>>[0],
    ) => {
      opened.push({
        ...(input.config.browserCdpPort === undefined
          ? {}
          : { port: input.config.browserCdpPort }),
        ...(input.config.chatgptProjectUrl === undefined
          ? {}
          : { projectUrl: input.config.chatgptProjectUrl }),
      });
      return {
        kind: "browser" as const,
        mode: input.config.browserCdpPort === undefined ? "managed" as const : "external" as const,
        opened: true,
        authentication: "pending" as const,
      };
    };

    expect(await main(["setup", "browser", "--cdp", "9222", "--json"], {
      cwd: root,
      setupBrowser,
      write: () => {},
    })).toBe(0);
    let config = JSON.parse(await readFile(join(root, ".chatgpt-consult", "config.local.json"), "utf8"));
    expect(config.browserCdpPort).toBe(9222);
    expect(opened.at(-1)).toEqual({ port: 9222, projectUrl });

    expect(await main(["setup", "browser", "--managed", "--json"], {
      cwd: root,
      setupBrowser,
      write: () => {},
    })).toBe(0);
    config = JSON.parse(await readFile(join(root, ".chatgpt-consult", "config.local.json"), "utf8"));
    expect(config.browserCdpPort).toBeUndefined();
    expect(opened.at(-1)).toEqual({ projectUrl });

    config.browserCdpPort = 9333;
    await writeFile(
      join(root, ".chatgpt-consult", "config.local.json"),
      `${JSON.stringify(config)}\n`,
    );
    expect(await main(["setup", "browser", "--json"], {
      cwd: root,
      setupBrowser,
      write: () => {},
    })).toBe(0);
    expect(opened.at(-1)).toEqual({ port: 9333, projectUrl });
  });

  test("setup browser rejects invalid mode flags without mutating config", async () => {
    const root = await makeProject();
    await initializeConfigWithProjectUrl(root, "https://chatgpt.com/g/projects/setup-errors");
    const path = join(root, ".chatgpt-consult", "config.local.json");
    const before = await readFile(path, "utf8");
    let opened = 0;
    const invalid = [
      ["setup", "browser", "--cdp"],
      ["setup", "browser", "--cdp", "0"],
      ["setup", "browser", "--cdp", "65536"],
      ["setup", "browser", "--cdp", "1.5"],
      ["setup", "browser", "--cdp", "9222", "--cdp", "9333"],
      ["setup", "browser", "--managed", "--managed"],
      ["setup", "browser", "--managed", "--cdp", "9222"],
    ];
    for (const argv of invalid) {
      const errors: string[] = [];
      expect(await main(argv, {
        cwd: root,
        setupBrowser: async () => {
          opened += 1;
          return {
            kind: "browser",
            mode: "managed",
            opened: true,
            authentication: "pending",
          } as const;
        },
        writeError: (message) => errors.push(message),
      })).toBe(2);
      expect(errors.join("\n")).toContain("INVALID_INPUT");
      expect(await readFile(path, "utf8")).toBe(before);
    }
    expect(opened).toBe(0);
  });

  test("browser setup opens only the configured Project in a headed managed or external session", async () => {
    const projectUrl = "https://chatgpt.com/g/projects/safe-setup";
    for (const browserCdpPort of [undefined, 9222] as const) {
      const session: ChromeSession = {
        pid: browserCdpPort === undefined ? 42 : 0,
        port: browserCdpPort ?? 9333,
        webSocketUrl: `ws://127.0.0.1:${browserCdpPort ?? 9333}/devtools/browser/test`,
        profileDir: browserCdpPort === undefined ? "/private/managed-profile" : null,
        ownership: browserCdpPort === undefined ? "owned" : "external",
        visibility: browserCdpPort === undefined ? "headed" : "external",
        reused: false,
      };
      const modes: string[] = [];
      const opened: Array<{ url: string; port: number; deadlineMs: number }> = [];
      let closeCalls = 0;
      const result = await setupBrowserSession({
        schemaVersion: 1,
        chatgptProjectUrl: projectUrl,
        ...(browserCdpPort === undefined ? {} : { browserCdpPort }),
        defaultProfile: "lean",
        connectorAllowlist: [],
        budget: {},
      }, {
        sessionManager: {
          ensureRunning: async (mode = "headless") => {
            modes.push(mode);
            return session;
          },
          switchOwnedToHeaded: async () => session,
          closeOwned: async () => { closeCalls += 1; },
        } as never,
        automation: {
          waitForAuthenticatedProject: async (input) => {
            opened.push({
              url: input.projectUrl,
              port: input.session.port,
              deadlineMs: input.deadlineMs,
            });
            return "authenticated";
          },
        },
      });

      expect(modes).toEqual(["headed"]);
      expect(opened).toEqual([{ url: projectUrl, port: session.port, deadlineMs: 1_000 }]);
      expect(closeCalls).toBe(0);
      expect(result).toMatchObject({
        mode: browserCdpPort === undefined ? "managed" : "external",
        opened: true,
        authentication: "authenticated",
      });
    }
  });

  test("browser setup switches an existing managed headless owner but leaves external CDP untouched", async () => {
    const projectUrl = "https://chatgpt.com/g/projects/setup-session-mode";
    let managedEnsure = 0;
    let managedSwitch = 0;
    const headless = {
      pid: 411,
      port: 44111,
      webSocketUrl: "ws://127.0.0.1:44111/devtools/browser/headless",
      profileDir: "/private/managed-profile",
      ownership: "owned",
      visibility: "headless",
      reused: true,
    } as const;
    const headed = {
      ...headless,
      pid: 422,
      port: 44222,
      webSocketUrl: "ws://127.0.0.1:44222/devtools/browser/headed",
      visibility: "headed",
      reused: false,
    } as const;
    const managedManager = new BrowserSessionManager({
      controller: {
        ensureRunning: async () => { managedEnsure += 1; return headless; },
        switchOwnedToHeaded: async () => { managedSwitch += 1; return headed; },
        closeOwned: async () => { throw new Error("must not close outside the atomic switch"); },
      },
    });
    const observed: ChromeSession[] = [];
    const automation = {
      waitForAuthenticatedProject: async (input: { session: ChromeSession }) => {
        observed.push(input.session);
        return "authenticated" as const;
      },
    };

    const managed = await setupBrowserSession({
      schemaVersion: 1,
      chatgptProjectUrl: projectUrl,
      defaultProfile: "lean",
      connectorAllowlist: [],
      budget: {},
    }, { sessionManager: managedManager, automation });

    let externalAttachments = 0;
    let externalManagedCalls = 0;
    const externalManager = new BrowserSessionManager({
      browserCdpPort: 45555,
      controller: {
        ensureRunning: async () => { externalManagedCalls += 1; return headless; },
        switchOwnedToHeaded: async () => { externalManagedCalls += 1; return headed; },
        closeOwned: async () => { externalManagedCalls += 1; },
      },
      attachExternal: async (port) => {
        externalAttachments += 1;
        return {
          pid: 0,
          port,
          webSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/external`,
          profileDir: null,
          ownership: "external",
          visibility: "external",
          reused: true,
        };
      },
    });
    const external = await setupBrowserSession({
      schemaVersion: 1,
      chatgptProjectUrl: projectUrl,
      browserCdpPort: 45555,
      defaultProfile: "lean",
      connectorAllowlist: [],
      budget: {},
    }, { sessionManager: externalManager, automation });

    expect(managed).toMatchObject({ mode: "managed", opened: true });
    expect(managedEnsure).toBe(1);
    expect(managedSwitch).toBe(1);
    expect(observed[0]).toMatchObject({ pid: 422, ownership: "owned", visibility: "headed" });
    expect(external).toMatchObject({ mode: "external", opened: true });
    expect(externalAttachments).toBe(1);
    expect(externalManagedCalls).toBe(0);
    expect(observed[1]).toMatchObject({ ownership: "external", visibility: "external" });
  });

  test("browser setup distinguishes an initial navigation timeout from login-pending evidence", async () => {
    const projectUrl = "https://chatgpt.com/g/projects/setup-open-proof";
    const session: ChromeSession = {
      pid: 420,
      port: 44200,
      webSocketUrl: "ws://127.0.0.1:44200/devtools/browser/setup-proof",
      profileDir: "/private/managed-profile",
      ownership: "owned",
      visibility: "headed",
      reused: true,
    };
    const config = {
      schemaVersion: 1 as const,
      chatgptProjectUrl: projectUrl,
      defaultProfile: "lean" as const,
      connectorAllowlist: [],
      budget: {},
    };
    const sessionManager = {
      ensureRunning: async () => session,
      switchOwnedToHeaded: async () => session,
      closeOwned: async () => {},
    } as never;

    const initialTimeout = await setupBrowserSession(config, {
      sessionManager,
      automation: {
        waitForAuthenticatedProject: async () => "timed_out",
      },
    });
    const loginPending = await setupBrowserSession(config, {
      sessionManager,
      automation: {
        waitForAuthenticatedProject: async (_input, hooks) => {
          await (hooks as BrowserAutomationHooks & {
            navigationConfirmed?: () => Promise<void>;
          }).navigationConfirmed?.();
          return "timed_out";
        },
      },
    });

    expect(initialTimeout).toEqual({
      kind: "browser",
      mode: "managed",
      opened: false,
      authentication: "pending",
    });
    expect(loginPending).toEqual({
      kind: "browser",
      mode: "managed",
      opened: true,
      authentication: "pending",
    });
    expect(JSON.stringify([initialTimeout, loginPending])).not.toMatch(
      /managed-profile|devtools|44200|cookie|storage/i,
    );
  });

  test("browser setup renderer describes managed headed and external visibility accurately", async () => {
    const root = await makeProject();
    await initializeConfigWithProjectUrl(root, "https://chatgpt.com/g/projects/setup-renderer");
    const outputs: string[] = [];
    expect(await main(["setup", "browser", "--managed"], {
      cwd: root,
      setupBrowser: async () => ({
        kind: "browser",
        mode: "managed",
        opened: true,
        authentication: "authenticated",
      }),
      write: (message) => outputs.push(message),
    })).toBe(0);
    expect(outputs.pop()).toContain("headed managed browser");

    expect(await main(["setup", "browser", "--cdp", "9222"], {
      cwd: root,
      setupBrowser: async () => ({
        kind: "browser",
        mode: "external",
        opened: true,
        authentication: "pending",
      }),
      write: (message) => outputs.push(message),
    })).toBe(0);
    const external = outputs.pop()!;
    expect(external).toContain("external browser session");
    expect(external).not.toContain("headed browser");
    expect(external).not.toMatch(/9222|devtools|profile|cookie|storage/i);
  });

  test("private worker dispatch accepts only exact request and owner identifiers", async () => {
    const root = await makeProject();
    await initializeConfigWithProjectUrl(root, "https://chatgpt.com/g/projects/worker-dispatch");
    const requestId = "a".repeat(32);
    const ownerId = "b".repeat(32);
    const calls: Array<{ requestId: string; ownerId: string }> = [];
    const output: string[] = [];

    expect(await main(["worker", requestId, ownerId], {
      cwd: root,
      runBrowserWorker: async (input) => {
        calls.push({ requestId: input.requestId, ownerId: input.ownerId });
        return { kind: "recovery", requestId, phase: "needs_manual", reason: "browser_unavailable" };
      },
      write: (message) => output.push(message),
    })).toBe(0);
    expect(calls).toEqual([{ requestId, ownerId }]);
    expect(output).toEqual([]);

    for (const argv of [
      ["worker"],
      ["worker", requestId],
      ["worker", requestId, ownerId, "extra"],
      ["worker", requestId.toUpperCase(), ownerId],
      ["worker", requestId, "short"],
      ["worker", requestId, ownerId, "--json"],
    ]) {
      expect(await main(argv, {
        cwd: root,
        runBrowserWorker: async () => { throw new Error("must not run"); },
        writeError: () => {},
      })).toBe(2);
    }
  });

  test("dispatches setup clients before project resolution and forwards apply flags", async () => {
    const output: string[] = [];
    const calls: Array<{ apply: boolean; replace: boolean }> = [];
    const exitCode = await main(
      ["setup", "clients", "--apply", "--replace", "--json"],
      {
        cwd: join(tmpdir(), "chatgpt-consult-does-not-exist"),
        setupClients: async (input) => {
          calls.push(input);
          return { ...previewSetup, mode: "apply" };
        },
        write: (message) => output.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ apply: true, replace: true }]);
    expect(JSON.parse(output.join("\n"))).toEqual({
      schemaVersion: 1,
      ok: true,
      data: { ...previewSetup, mode: "apply" },
    });
  });

  test("renders deterministic quoted client setup output and reports inner errors with exit one", async () => {
    const previewOutput: string[] = [];
    const previewCode = await main(["setup", "clients"], {
      setupClients: async () => previewSetup,
      write: (message) => previewOutput.push(message),
    });

    expect(previewCode).toBe(0);
    expect(previewOutput.join("\n")).toBe([
      "Client setup (preview)",
      "codex\tabsent\tadd\tEntry not found",
      "  add: \"codex\" \"mcp\" \"add\" \"chatgpt-consult\" \"--\" \"bun\" \"run\" \"/tmp/bin with space.ts\" \"serve\" \"local\"",
      "claude\tskipped\tskipped\tclaude CLI not available",
    ].join("\n"));

    const failedOutput: string[] = [];
    const failedCode = await main(["setup", "clients", "--json"], {
      setupClients: async () => ({
        ...previewSetup,
        success: false,
        clients: [{ client: "codex", status: "error", action: "error", message: "Query failed" }],
      }),
      write: (message) => failedOutput.push(message),
    });
    expect(failedCode).toBe(1);
    expect(JSON.parse(failedOutput.join("\n"))).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: { kind: "clients", success: false },
    });
  });

  test("renders complete ChatGPT connector guidance without project access", async () => {
    const output: string[] = [];
    let calls = 0;
    const exitCode = await main(["setup", "chatgpt"], {
      cwd: join(tmpdir(), "chatgpt-consult-does-not-exist"),
      getChatgptSetupGuidance: () => {
        calls += 1;
        return chatgptGuidance;
      },
      write: (message) => output.push(message),
    });
    const rendered = output.join("\n");

    expect(exitCode).toBe(0);
    expect(calls).toBe(1);
    for (const value of [
      chatgptGuidance.recommended.browserCommand,
      chatgptGuidance.recommended.startCommand,
      chatgptGuidance.manualFallback.handoff,
      chatgptGuidance.manualFallback.importResult,
      chatgptGuidance.legacyCompatibility.startCommand,
      chatgptGuidance.legacyCompatibility.tunnelDocumentationUrl,
      "recommended",
      "Legacy/optional compatibility",
      "never started automatically",
    ]) expect(rendered).toContain(value);
    expect(rendered.indexOf(chatgptGuidance.recommended.browserCommand))
      .toBeLessThan(rendered.indexOf(chatgptGuidance.legacyCompatibility.startCommand));
  });

  test("rejects malformed setup targets and target-specific options", async () => {
    for (const argv of [
      ["setup"],
      ["setup", "unknown"],
      ["setup", "clients", "extra"],
      ["setup", "chatgpt", "extra"],
      ["setup", "chatgpt", "--apply"],
      ["setup", "chatgpt", "--replace"],
      ["setup", "clients", "--apply", "--apply"],
    ]) {
      const errors: string[] = [];
      const exitCode = await main(argv, { writeError: (message) => errors.push(message) });
      expect(exitCode).toBe(2);
      expect(errors.join("\n")).toContain("INVALID_INPUT");
    }
  });

  const storedProfile = async (root: string, requestId: string): Promise<string> => {
    const requestText = await Bun.file(
      join(root, ".chatgpt-consult", "requests", `${requestId}.json`),
    ).text();
    return (JSON.parse(requestText) as { profile: string }).profile;
  };

  test("start without a profile keeps the configured default when the request carries no context", async () => {
    const root = await makeProject();
    const result = run(root, "start", "Review the queue", "--json");
    const payload = JSON.parse(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(await storedProfile(root, payload.data.requestId)).toBe("lean");
  });

  test("start without a profile resolves to analysis when the request carries files", async () => {
    const root = await makeProject();
    const result = run(root, "start", "Review the queue", "--file", "src/queue.ts", "--json");
    const payload = JSON.parse(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(await storedProfile(root, payload.data.requestId)).toBe("analysis");
  });

  test("start honours an explicit lean profile even when the request carries files", async () => {
    const root = await makeProject();
    const result = run(
      root, "start", "Review the queue", "--file", "src/queue.ts", "--profile", "lean", "--json",
    );
    const payload = JSON.parse(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(await storedProfile(root, payload.data.requestId)).toBe("lean");
  });

  test("followup without a profile inherits the parent's profile", async () => {
    const root = await makeProject();
    const started = run(root, "start", "Review the queue", "--profile", "research", "--json");
    const parentId = JSON.parse(started.stdout.toString()).data.requestId;

    const followed = run(root, "followup", parentId, "Now assess backoff", "--json");
    const followedPayload = JSON.parse(followed.stdout.toString());

    expect(followed.exitCode).toBe(0);
    expect(await storedProfile(root, followedPayload.data.requestId)).toBe("research");
  });

  test("starts through the real binary with a protocol-clean JSON envelope", async () => {
    const root = await makeProject();
    const result = run(root, "start", "Review the queue", "--file", "src/queue.ts", "--json");
    const payload = JSON.parse(result.stdout.toString());

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ schemaVersion: 1, ok: true, data: { state: "pending" } });
    expect(payload.data.claimToken).toBeString();
    expect(result.stderr.toString()).not.toContain(payload.data.claimToken);
    expect(result.stdout.toString()).not.toMatch(/\x1b\[/);
  });

  test("rejects unknown and duplicate scalar options with exit code 2", async () => {
    const root = await makeProject();
    for (const args of [
      ["start", "Review", "--wat"],
      ["start", "Review", "--profile", "lean", "--profile", "analysis"],
    ]) {
      const result = run(root, ...args, "--json");
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        schemaVersion: 1,
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });

  test("rejects a missing goal and connected-only connector misuse", async () => {
    const root = await makeProject();
    const missing = run(root, "start", "--json");
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout.toString()).error.code).toBe("INVALID_INPUT");

    const connector = run(root, "start", "Review", "--connector", "Drive", "--json");
    expect(connector.exitCode).toBe(2);
    expect(JSON.parse(connector.stdout.toString()).error.code).toBe("INVALID_INPUT");
  });

  test("renders human status without claim material", async () => {
    const root = await makeProject();
    const started = run(root, "start", "Review", "--json");
    const created = JSON.parse(started.stdout.toString()).data;
    const status = run(root, "status", created.requestId);

    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain(`Request: ${created.requestId}`);
    expect(status.stdout.toString()).toContain("State: pending");
    expect(status.stdout.toString()).toContain("Next: ");
    expect(status.stdout.toString()).not.toContain(created.claimToken);
  });

  test("maps not-found failures and keeps JSON errors free of ANSI", async () => {
    const root = await makeProject();
    const result = run(root, "show", "missing", "--json");
    const payload = JSON.parse(result.stdout.toString());

    expect(result.exitCode).toBe(3);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(result.stdout.toString()).not.toMatch(/\x1b\[/);
  });

  test("normalizes connected allowlists and preserves a valid idempotency key", async () => {
    const root = await makeProject();
    const result = run(
      root,
      "start",
      "Review",
      "--profile",
      "connected",
      "--connector",
      " Drive ",
      "--connector",
      "drive",
      "--idempotency-key",
      "cli-key:1",
      "--json",
    );
    const payload = JSON.parse(result.stdout.toString());
    expect(result.exitCode).toBe(0);
    const requestText = await Bun.file(join(root, ".chatgpt-consult", "requests", `${payload.data.requestId}.json`)).text();
    expect(JSON.parse(requestText)).toMatchObject({
      idempotencyKey: "cli-key:1",
      connectorAllowlist: ["drive"],
    });
  });

  test("uses a private claim-free manual bundle through the real handoff and import lifecycle", async () => {
    const root = await makeProject();
    const started = run(root, "start", "Review", "--json");
    const created = JSON.parse(started.stdout.toString()).data;

    const handedOff = run(root, "handoff", created.requestId, "--json");
    const handoffPayload = JSON.parse(handedOff.stdout.toString());
    expect(handedOff.exitCode).toBe(0);
    expect(handoffPayload).toMatchObject({
      schemaVersion: 1,
      ok: true,
    });
    expect(handoffPayload.data.path).toBeString();
    expect(handoffPayload.data.path).toContain(`manual/${created.requestId}.md`);
    expect(handoffPayload.data.text).toBeString();
    expect(JSON.stringify(handoffPayload)).not.toContain(created.claimToken);
    expect(handedOff.stderr.toString()).not.toContain(created.claimToken);
    expect((await lstat(join(root, handoffPayload.data.path))).mode & 0o777).toBe(0o600);

    await writeFile(join(root, "manual-result.json"), JSON.stringify({
      summary: "Manual review",
      answer: "Use the queue.",
      evidence: [],
      assumptions: [],
      risks: [],
      recommendations: [],
      followUpQuestions: [],
    }));
    const imported = run(
      root,
      "import-result",
      created.requestId,
      "--input",
      "manual-result.json",
      "--json",
    );
    expect(imported.exitCode).toBe(0);
    expect(JSON.parse(imported.stdout.toString())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: { requestId: created.requestId, state: "completed", completionSource: "manual" },
    });
  });

  test("rejects an oversized manual import before parsing or persisting it", async () => {
    const root = await makeProject();
    const started = run(root, "start", "Review", "--json");
    const created = JSON.parse(started.stdout.toString()).data;
    await writeFile(join(root, "oversized.json"), `{${"x".repeat(300_000)}`);

    const imported = run(
      root,
      "import-result",
      created.requestId,
      "--input",
      "oversized.json",
      "--json",
    );
    expect(imported.exitCode).toBe(2);
    expect(JSON.parse(imported.stdout.toString())).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "BUDGET_EXCEEDED" },
    });
    expect(await Bun.file(join(root, ".chatgpt-consult", "results", `${created.requestId}.json`)).exists()).toBeFalse();
  });

  test("keeps JSON output actionable and sanitized when an injected launcher rejects", async () => {
    const root = await makeProject();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await main(
      ["start", "Review", "--open", "--json"],
      {
        cwd: root,
        workerLauncher: {
          start: async () => {
            throw new ConsultError("UNAVAILABLE", "adapter echoed PRIVATE_DIAGNOSTIC");
          },
        },
        write: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      },
    );
    const payload = JSON.parse(output.join("\n"));

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: { browser: { phase: "needs_manual", reason: "browser_unavailable" } },
    });
    expect(payload.data.handoff).toContain(payload.data.claimToken);
    expect(output.join("\n")).not.toContain("adapter echoed");
    expect(output.join("\n")).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(errors).toEqual([]);
  });

  test("production launcher path records manual recovery without a configured URL", async () => {
    const root = await makeProject();
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await main(
      ["start", "Review", "--open", "--json"],
      {
        cwd: root,
        write: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      },
    );
    const payload = JSON.parse(output.join("\n"));

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: {
        state: "pending",
        browser: { phase: "needs_manual", reason: "browser_unavailable" },
      },
    });
    expect(payload.data.handoff).toBeString();
    expect(payload.data.claimToken).toBeString();
    expect(payload.data.handoff).toContain(payload.data.claimToken);
    expect(errors).toEqual([]);
    expect(output.join("\n")).not.toMatch(/\x1b\[/);
  });

  test("configured project uses the injected worker launcher factory deterministically", async () => {
    const root = await makeProject();
    const projectUrl = "https://chatgpt.com/g/projects/alpha-bravo";
    await initializeConfigWithProjectUrl(root, projectUrl);

    const factoryCalls: string[] = [];
    const startCalls: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await main(
      ["start", "Review", "--open", "--json"],
      {
        cwd: root,
        workerLauncherFactory: (project) => {
          factoryCalls.push(project.root);
          return {
            start: async (requestId) => { startCalls.push(requestId); },
          };
        },
        write: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      },
    );
    const payload = JSON.parse(output.join("\n"));

    expect(exitCode).toBe(0);
    expect(factoryCalls).toEqual([await realpath(root)]);
    expect(startCalls).toEqual([payload.data.requestId]);
    expect(payload.data.browser).toMatchObject({ phase: "queued", reason: null });
  });

  test("explicit worker launcher injection overrides the factory", async () => {
    const root = await makeProject();
    const projectUrl = "https://chatgpt.com/g/projects/alpha-bravo";
    await initializeConfigWithProjectUrl(root, projectUrl);

    let factoryInvoked = false;
    const explicitStartCalls: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await main(
      ["start", "Review", "--open", "--json"],
      {
        cwd: root,
        workerLauncher: {
          start: async (requestId) => { explicitStartCalls.push(requestId); },
        },
        workerLauncherFactory: () => {
          factoryInvoked = true;
          return { start: async () => {} };
        },
        write: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      },
    );
    const payload = JSON.parse(output.join("\n"));

    expect(exitCode).toBe(0);
    expect(factoryInvoked).toBeFalse();
    expect(explicitStartCalls).toEqual([payload.data.requestId]);
    expect(payload.data.browser).toMatchObject({ phase: "queued", reason: null });
  });

  test("non-open commands do not invoke the selected launcher", async () => {
    const root = await makeProject();
    const projectUrl = "https://chatgpt.com/g/projects/alpha-bravo";
    await initializeConfigWithProjectUrl(root, projectUrl);

    const factoryCalls: string[] = [];
    let startInvoked = false;
    const output: string[] = [];
    const errors: string[] = [];
    // First create a request without --open.
    const createExit = await main(
      ["start", "Review", "--json"],
      {
        cwd: root,
        write: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      },
    );
    const created = JSON.parse(output.join("\n")).data;

    output.length = 0;
    errors.length = 0;
    const exitCode = await main(
      ["status", created.requestId, "--json"],
      {
        cwd: root,
        workerLauncherFactory: (project) => {
          factoryCalls.push(project.root);
          return {
            start: async () => { startInvoked = true; },
          };
        },
        write: (message) => output.push(message),
        writeError: (message) => errors.push(message),
      },
    );
    const statusPayload = JSON.parse(output.join("\n"));

    expect(createExit).toBe(0);
    expect(exitCode).toBe(0);
    expect(factoryCalls).toEqual([await realpath(root)]);
    expect(startInvoked).toBeFalse();
    expect(statusPayload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: { requestId: created.requestId, state: "pending" },
    });
    expect(output.join("\n")).not.toContain(created.claimToken);
    expect(errors).toEqual([]);
  });
});

const initializeConfigWithProjectUrl = async (root: string, projectUrl: string): Promise<void> => {
  const initOutput: string[] = [];
  const initErrors: string[] = [];
  const initExit = await main(
    ["init", "--chatgpt-project-url", projectUrl],
    {
      cwd: root,
      write: (message) => initOutput.push(message),
      writeError: (message) => initErrors.push(message),
    },
  );
  if (initExit !== 0) throw new Error(`init failed: ${initErrors.join("\n")}`);
};
