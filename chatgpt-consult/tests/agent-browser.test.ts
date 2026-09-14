import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBrowserAutomation,
  AgentBrowserSubmitter,
  AGENT_BROWSER_POLICY,
  type CdpPageClientFactory,
  type AgentBrowserAutomationOptions,
  type CommandRunner,
  type WorkspaceFactory,
  type WorkspaceCleanup,
  type WorkspacePaths,
} from "../src/browser/agent-browser";
import type {
  BrowserAutomationHooks,
  BrowserAutomationInput,
  BrowserSubmitInput,
} from "../src/browser/handoff";
import type { ChromeSession } from "../src/browser/chrome";
import { BROWSER_RESULT_BEGIN, BROWSER_RESULT_END, formatBrowserPrompt } from "../src/browser/protocol";
import { CdpPageClient, type MinimalSocket } from "../src/browser/cdp-page";

const SESSION: ChromeSession = {
  pid: 1,
  port: 9222,
  webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
  profileDir: "/tmp/profile",
  ownership: "owned",
  visibility: "headless",
  reused: false,
};

const HANDOFF = `Use the ChatGPT Consult MCP tools. Call request_get with request_id "req_01" and claim_token "claim_abc", selectively inspect context, then call request_complete.`;
const PROJECT_URL = "https://chatgpt.com/g/projects/aaa-bbb-ccc";
const CONVERSATION_URL = "https://chatgpt.com/c/abc-123";

function makeInput(overrides?: Partial<BrowserSubmitInput>): BrowserSubmitInput {
  return {
    session: SESSION,
    targetUrl: PROJECT_URL,
    handoff: HANDOFF,
    requestId: "req_01",
    targetKind: "configured",
    ...overrides,
  };
}

interface RunnerCall {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

interface FakeRunner {
  calls: RunnerCall[];
  runner: CommandRunner;
}

function createFakeRunner(
  results: Array<{ status: number; output: string } | (() => { status: number; output: string })>,
): FakeRunner {
  const calls: RunnerCall[] = [];
  let idx = 0;
  return {
    calls,
    runner: async (argv, options) => {
      calls.push({ argv, ...options });
      const entry = results[idx++];
      if (!entry) return { status: 1, output: "" };
      return typeof entry === "function" ? entry() : entry;
    },
  };
}

interface FakeWorkspace {
  created: boolean;
  cleanedDirs: string[];
  factory: WorkspaceFactory;
  cleanup: WorkspaceCleanup;
  paths: WorkspacePaths;
}

function createFakeWorkspace(dir = "/tmp/fake-ab-workspace"): FakeWorkspace {
  const cleanedDirs: string[] = [];
  const paths: WorkspacePaths = {
    dir,
    policyPath: `${dir}/action-policy.json`,
    configPath: `${dir}/agent-browser.json`,
  };
  return {
    created: false,
    cleanedDirs,
    paths,
    factory: async () => {
      return paths;
    },
    cleanup: async (d) => {
      cleanedDirs.push(d);
    },
  };
}

function snapshotJson(refs: Record<string, unknown>): string {
  return JSON.stringify({ success: true, data: { refs } });
}

function urlJson(url: string): string {
  return JSON.stringify({ success: true, data: { url } });
}

function emptyJson(): string {
  return JSON.stringify({ success: true, data: {} });
}

const VALID_COMPOSER_REFS: Record<string, unknown> = {
  e1: { role: "textbox", name: "Message ChatGPT" },
  e2: { role: "button", name: "Send" },
};

function sevenStepSuccessResults(): Array<{ status: number; output: string }> {
  return [
    { status: 0, output: emptyJson() },       // Step 1: open
    { status: 0, output: urlJson(PROJECT_URL) }, // Step 2: get url (post-open)
    { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) }, // Step 3: snapshot -i
    { status: 0, output: urlJson(PROJECT_URL) }, // Step 4: get url (pre-fill)
    { status: 0, output: emptyJson() },       // Step 5: fill
    { status: 0, output: emptyJson() },       // Step 6: press Enter
    { status: 0, output: urlJson(CONVERSATION_URL) }, // Step 7: get url (confirm)
  ];
}

// ─── Constructor validation ──────────────────────────────────────────

describe("AgentBrowserSubmitter constructor", () => {
  test("rejects non-string non-null executablePath", () => {
    expect(() => new AgentBrowserSubmitter({ executablePath: 42 as unknown as string })).toThrow(TypeError);
  });

  test("rejects non-function commandRunner", () => {
    expect(() => new AgentBrowserSubmitter({ commandRunner: "x" as unknown as CommandRunner })).toThrow(TypeError);
  });

  test("rejects non-function workspaceFactory", () => {
    expect(() => new AgentBrowserSubmitter({ workspaceFactory: 1 as unknown as WorkspaceFactory })).toThrow(TypeError);
  });

  test("rejects non-function workspaceCleanup", () => {
    expect(() => new AgentBrowserSubmitter({ workspaceCleanup: {} as unknown as WorkspaceCleanup })).toThrow(TypeError);
  });

  test("rejects non-positive deadlineMs", () => {
    expect(() => new AgentBrowserSubmitter({ deadlineMs: 0 })).toThrow(TypeError);
    expect(() => new AgentBrowserSubmitter({ deadlineMs: -1 })).toThrow(TypeError);
    expect(() => new AgentBrowserSubmitter({ deadlineMs: Infinity })).toThrow(TypeError);
    expect(() => new AgentBrowserSubmitter({ deadlineMs: NaN })).toThrow(TypeError);
  });

  test("rejects non-function now", () => {
    expect(() => new AgentBrowserSubmitter({ now: "x" as unknown as () => number })).toThrow(TypeError);
  });

  test("accepts valid options", () => {
    const ws = createFakeWorkspace();
    expect(() => new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: ws.factory as unknown as CommandRunner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: 5000,
      now: () => 0,
    })).not.toThrow();
  });

  test("accepts null executablePath", () => {
    expect(() => new AgentBrowserSubmitter({ executablePath: null })).not.toThrow();
  });
});

// ─── Policy ──────────────────────────────────────────────────────────

describe("AGENT_BROWSER_POLICY", () => {
  test("has default deny", () => {
    expect(AGENT_BROWSER_POLICY.default).toBe("deny");
  });

  test("has exact flat allow array", () => {
    expect(AGENT_BROWSER_POLICY.allow).toEqual([
      "launch", "navigate", "open", "snapshot", "get", "count", "find", "nth", "click", "fill",
      "press", "wait", "interact", "upload", "url", "tab_close",
    ]);
  });

  test("has exact flat deny array", () => {
    expect(AGENT_BROWSER_POLICY.deny).toEqual([
      "eval", "evalhandle", "addscript", "addinitscript", "addstyle", "expose",
      "setcontent", "download", "waitfordownload", "network", "route", "unroute",
      "requests", "har", "state", "cookies", "storage",
    ]);
  });

  test("serialized schema has correct shape", () => {
    const serialized = JSON.parse(JSON.stringify(AGENT_BROWSER_POLICY));
    expect(Object.keys(serialized).sort()).toEqual(["allow", "default", "deny"]);
    expect(Array.isArray(serialized.allow)).toBe(true);
    expect(Array.isArray(serialized.deny)).toBe(true);
    expect(serialized.default).toBe("deny");
  });

  test("is frozen / immutable", () => {
    expect(Object.isFrozen(AGENT_BROWSER_POLICY)).toBe(true);
    expect(Object.isFrozen(AGENT_BROWSER_POLICY.allow)).toBe(true);
    expect(Object.isFrozen(AGENT_BROWSER_POLICY.deny)).toBe(true);
  });

  test("authorizes the bounded connection launch before CDP navigation", async () => {
    const ws = createFakeWorkspace();
    let call = 0;
    const runner: CommandRunner = async () => {
      call += 1;
      if (call === 1 && !(AGENT_BROWSER_POLICY.allow as readonly string[]).includes("launch")) {
        return {
          status: 1,
          output: JSON.stringify({
            success: false,
            error: "Action 'launch' denied by policy",
          }),
        };
      }
      if (call === 1) return { status: 0, output: emptyJson() };
      if (call === 2) return { status: 0, output: urlJson(PROJECT_URL) };
      return { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) };
    };
    const automation = new AgentBrowserAutomation({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });

    const result = await automation.waitForAuthenticatedProject({
      session: SESSION,
      projectUrl: PROJECT_URL,
      deadlineMs: 5_000,
    }, {
      beforeSubmission: async () => {},
      submissionConfirmed: async () => {},
      heartbeat: async () => {},
      isCancelled: async () => false,
    });

    expect(result).toBe("authenticated");
  });

  test("authorizes the bounded assistant count before typing", () => {
    expect(AGENT_BROWSER_POLICY.allow).toContain("count");
  });

  test("authorizes the bounded final assistant selection", () => {
    expect(AGENT_BROWSER_POLICY.allow).toContain("nth");
  });

  test("authorizes closing only the exact request-owned tab", () => {
    expect(AGENT_BROWSER_POLICY.allow).toContain("tab_close");
  });
});

// ─── Unavailable executable ──────────────────────────────────────────

describe("unavailable executable", () => {
  test("null executable returns unavailable without workspace or runner", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([]);
    const sub = new AgentBrowserSubmitter({
      executablePath: null,
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
    expect(ws.cleanedDirs).toHaveLength(0);
  });

  test("message contains no sensitive data", async () => {
    const sub = new AgentBrowserSubmitter({ executablePath: null });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    const msg = result.message ?? "";
    expect(msg).not.toContain("agent-browser");
    expect(msg).not.toContain("/");
    expect(msg).not.toContain("claim");
    expect(msg).not.toContain("req_");
  });
});

// ─── Invalid target URL ─────────────────────────────────────────────

describe("invalid target URL", () => {
  test("returns unavailable without workspace or runner", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput({ targetUrl: "https://evil.com/phish" }));
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
    expect(ws.cleanedDirs).toHaveLength(0);
  });

  test("rejects non-chatgpt host", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput({ targetUrl: "https://example.com" }));
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
  });
});

// ─── argv and environment ────────────────────────────────────────────

describe("argv and environment", () => {
  test("exact global flags and subcommands on success", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");

    expect(fake.calls).toHaveLength(7);

    const GLOBAL_FLAGS = [
      "--session", fake.calls[0]!.argv[fake.calls[0]!.argv.indexOf("--session") + 1]!,
      "--cdp", "9222",
      "--pin-tab",
      "--content-boundaries",
      "--max-output", "12000",
      "--action-policy", ws.paths.policyPath,
      "--config", ws.paths.configPath,
      "--idle-timeout", "10s",
      "--json",
    ];

    for (const call of fake.calls) {
      expect(call.argv[0]).toBe("/usr/bin/agent-browser");
      for (const flag of GLOBAL_FLAGS) {
        expect(call.argv).toContain(flag);
      }
    }

    // Step 1: open <canonical URL>
    const step1 = fake.calls[0]!.argv;
    expect(step1[step1.length - 2]).toBe("open");
    expect(step1[step1.length - 1]).toBe(PROJECT_URL);

    // Step 2: get url (post-open validation)
    const step2 = fake.calls[1]!.argv;
    expect(step2[step2.length - 2]).toBe("get");
    expect(step2[step2.length - 1]).toBe("url");

    // Step 3: snapshot -i
    const step3 = fake.calls[2]!.argv;
    expect(step3[step3.length - 2]).toBe("snapshot");
    expect(step3[step3.length - 1]).toBe("-i");

    // Step 4: get url (pre-fill validation)
    const step4 = fake.calls[3]!.argv;
    expect(step4[step4.length - 2]).toBe("get");
    expect(step4[step4.length - 1]).toBe("url");

    // Step 5: fill @ref handoff
    const step5 = fake.calls[4]!.argv;
    expect(step5[step5.length - 3]).toBe("fill");
    expect(step5[step5.length - 2]).toBe("@e1");
    expect(step5[step5.length - 1]).toBe(HANDOFF);

    // Step 6: press Enter
    const step6 = fake.calls[5]!.argv;
    expect(step6[step6.length - 2]).toBe("press");
    expect(step6[step6.length - 1]).toBe("Enter");

    // Step 7: get url (confirmation)
    const step7 = fake.calls[6]!.argv;
    expect(step7[step7.length - 2]).toBe("get");
    expect(step7[step7.length - 1]).toBe("url");
  });

  test("no forbidden flags in argv", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());

    const FORBIDDEN = [
      "--allowed-domains", "--profile", "--restore", "--state",
      "--headers", "--provider", "--args", "--init-script",
      "--enable", "--plugins", "--auto-connect", "--headed",
    ];

    for (const call of fake.calls) {
      for (const flag of FORBIDDEN) {
        expect(call.argv).not.toContain(flag);
      }
    }
  });

  test("safe cwd and environment", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());

    for (const call of fake.calls) {
      expect(call.cwd).toBe(ws.paths.dir);
      expect(call.env.HOME).toBe(ws.paths.dir);
      expect(call.env.XDG_CONFIG_HOME).toBe(ws.paths.dir);
      expect(call.env.LANG).toBe("C");
      expect(call.env.LC_ALL).toBe("C");
      expect(call.env.NO_COLOR).toBe("1");
      expect(call.env).not.toHaveProperty("AGENT_BROWSER_TEST");
      expect(call.env).not.toHaveProperty("HTTP_PROXY");
      expect(call.env).not.toHaveProperty("HTTPS_PROXY");
      expect(call.env).not.toHaveProperty("OPENAI_API_KEY");
    }
  });

  test("timeoutMs is remaining deadline", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    let t = 1000;
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: 20_000,
      now: () => t,
    });
    await sub.submit(makeInput());
    // First call should have timeoutMs = deadline - now = 20000+1000 - 1000 = 20000
    expect(fake.calls[0]!.timeoutMs).toBe(20_000);
  });

  test("canonical target URL used in open, not raw", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const rawUrl = "https://chatgpt.com/g/projects/aaa-bbb-ccc?ref=home";
    await sub.submit(makeInput({ targetUrl: rawUrl }));
    const step1 = fake.calls[0]!.argv;
    // configured purpose strips query → canonical is PROJECT_URL
    expect(step1[step1.length - 1]).toBe(PROJECT_URL);
  });

  test("canonical target strips query for configured purpose", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const rawUrl = "https://chatgpt.com/g/projects/aaa-bbb-ccc?ref=home";
    await sub.submit(makeInput({ targetUrl: rawUrl }));
    const step1 = fake.calls[0]!.argv;
    expect(step1[step1.length - 1]).toBe(PROJECT_URL);
  });

  test("handoff text passed only to fill step", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());

    for (let i = 0; i < fake.calls.length; i++) {
      const argv = fake.calls[i]!.argv;
      if (i === 4) {
        // fill step should contain handoff
        expect(argv).toContain(HANDOFF);
      } else {
        // no other step should contain handoff
        for (const arg of argv) {
          if (typeof arg === "string" && arg === HANDOFF) {
            throw new Error(`HANDOFF found in step ${i}`);
          }
        }
      }
    }
  });

  test("one isolated session per submission and port from ChromeSession", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const customSession: ChromeSession = { ...SESSION, port: 12345 };
    await sub.submit(makeInput({ session: customSession }));

    for (const call of fake.calls) {
      const idx = call.argv.indexOf("--cdp");
      expect(idx).toBeGreaterThan(-1);
      expect(call.argv[idx + 1]).toBe("12345");

      const sIdx = call.argv.indexOf("--session");
      expect(sIdx).toBeGreaterThan(-1);
      expect(call.argv[sIdx + 1]).toMatch(/^consult-[a-f0-9]{24}$/);
      expect(call.argv[sIdx + 1]).toBe(fake.calls[0]!.argv[sIdx + 1]);
    }
  });
});

// ─── Snapshot parser ─────────────────────────────────────────────────

describe("snapshot parser", () => {
  test("accepts one valid composer ref", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
  });

  test("rejects zero composer refs → opened_manual", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {
      e1: { role: "button", name: "Send" },
    };
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async () => {},
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    expect(fake.calls[3]!.argv[fake.calls[3]!.argv.length - 2]).toBe("snapshot");
  });

  test("rejects duplicate composer refs → opened_manual", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {
      e1: { role: "textbox", name: "Message ChatGPT" },
      e2: { role: "textbox", name: "Ask ChatGPT" },
    };
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async () => {},
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    expect(fake.calls[3]!.argv[fake.calls[3]!.argv.length - 2]).toBe("snapshot");
  });

  test("rejects malformed ref keys", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {
      "0bad": { role: "textbox", name: "Message ChatGPT" },
      "e0": { role: "textbox", name: "Message ChatGPT" },
    };
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async () => {},
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    expect(fake.calls[3]!.argv[fake.calls[3]!.argv.length - 2]).toBe("snapshot");
  });

  test("rejects more than 512 refs", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {};
    for (let i = 1; i <= 513; i++) {
      refs[`e${i}`] = { role: "textbox", name: "Message ChatGPT" };
    }
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async () => {},
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    expect(fake.calls[3]!.argv[fake.calls[3]!.argv.length - 2]).toBe("snapshot");
  });

  test("rejects login/email/password lookalike refs", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {
      e1: { role: "textbox", name: "Email" },
      e2: { role: "textbox", name: "Password" },
    };
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async () => {},
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    expect(fake.calls[3]!.argv[fake.calls[3]!.argv.length - 2]).toBe("snapshot");
  });

  test("rejects non-object ref values", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {
      e1: "textbox",
    };
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async () => {},
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    expect(fake.calls[3]!.argv[fake.calls[3]!.argv.length - 2]).toBe("snapshot");
  });

  test("accepts all four valid composer names", async () => {
    for (const name of ["Message ChatGPT", "Ask ChatGPT", "Ask Anything", "Chat with ChatGPT", "Prompt"]) {
      const ws = createFakeWorkspace();
      const refs: Record<string, unknown> = {
        e1: { role: "textbox", name },
      };
      const results = [
        { status: 0, output: emptyJson() },
        { status: 0, output: urlJson(PROJECT_URL) },
        { status: 0, output: snapshotJson(refs) },
        { status: 0, output: urlJson(PROJECT_URL) },
        { status: 0, output: emptyJson() },
        { status: 0, output: emptyJson() },
        { status: 0, output: urlJson(CONVERSATION_URL) },
      ];
      const fake2 = createFakeRunner(results);
      const sub = new AgentBrowserSubmitter({
        executablePath: "/usr/bin/agent-browser",
        commandRunner: fake2.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      });
      const result = await sub.submit(makeInput());
      expect(result.kind).toBe("submitted");
    }
  });

  test("accepts a project-scoped composer name", async () => {
    const ws = createFakeWorkspace();
    const refs: Record<string, unknown> = {
      e1: { role: "textbox", name: "New chat in WORK" },
    };
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(refs) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
  });

  test("retries the snapshot until the composer renders", async () => {
    const ws = createFakeWorkspace();
    const sleeps: number[] = [];
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({ e1: { role: "button", name: "Send" } }) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
    expect(sleeps).toEqual([1000]);
    expect(fake.calls).toHaveLength(8);
  });

  test("no snapshot/page text is used as selector or returned", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: JSON.stringify({ success: true, data: { refs: VALID_COMPOSER_REFS, snapshot: "secret page content" } }) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
    // Ensure no snapshot text in result
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("secret page content");
  });
});

// ─── Error handling ──────────────────────────────────────────────────

describe("error handling", () => {
  test("open failure → unavailable, no further commands", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(1);
  });

  test("open malformed JSON → unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: "not json" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });

  test("open success:false → unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: JSON.stringify({ success: false, data: {} }) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });

  test("open timeout (runner throws) → unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake: FakeRunner = {
      calls: [],
      runner: async (argv, options) => {
        fake.calls.push({ argv, ...options });
        throw new Error("timeout");
      },
    };
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(1);
  });

  test("snapshot failure after open → opened_manual", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(3);
  });

  test("fill failure after open → opened_manual", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(5);
  });

  test("press failure after open → opened_manual", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(6);
  });

  test("no later command runs after failure", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 1, output: "" },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());
    expect(fake.calls).toHaveLength(5);
  });

  test("oversized output → failure", async () => {
    const ws = createFakeWorkspace();
    const bigOutput = "x".repeat(13_000);
    const fake: FakeRunner = {
      calls: [],
      runner: async (argv, options) => {
        fake.calls.push({ argv, ...options });
        throw new RangeError("Output exceeds its byte ceiling");
      },
    };
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });
});

// ─── Deadline ────────────────────────────────────────────────────────

describe("deadline", () => {
  test("post-open URL at deadline: runner returns valid URL but clock reaches deadline, unavailable, two commands, no handoff", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 5000;
    const calls: RunnerCall[] = [];

    const runner: CommandRunner = async (argv, options) => {
      calls.push({ argv, ...options });
      return { status: 0, output: urlJson(PROJECT_URL) };
    };

    const wrappedRunner: CommandRunner = async (argv, options) => {
      const result = await runner(argv, options);
      if (calls.length === 2) {
        t = DEADLINE;
      }
      return result;
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: wrappedRunner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.argv).not.toContain(HANDOFF);
    }
  });

  test("deadline at exactly 0 remaining after open prevents post-open get url: unavailable, one command", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 1000;
    const calls: RunnerCall[] = [];

    const runner: CommandRunner = async (argv, options) => {
      calls.push({ argv, ...options });
      if (calls.length === 1) {
        t = DEADLINE;
      }
      return { status: 0, output: emptyJson() };
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    // After open, t = DEADLINE, so post-open get url deadline check fires → unavailable
    expect(calls).toHaveLength(1);
    expect(result.kind).toBe("unavailable");
  });

  test("exact pre-open-url cutoff: deadline reached before post-open get url returns unavailable, one command, no handoff", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 2000;
    const calls: RunnerCall[] = [];

    const runner: CommandRunner = async (argv, options) => {
      calls.push({ argv, ...options });
      return { status: 0, output: emptyJson() };
    };

    const wrappedRunner: CommandRunner = async (argv, options) => {
      const result = await runner(argv, options);
      if (calls.length === 1) {
        t = DEADLINE;
      }
      return result;
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: wrappedRunner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[calls[0]!.argv.length - 2]).toBe("open");
    for (const call of calls) {
      expect(call.argv).not.toContain(HANDOFF);
    }
  });

  test("exact pre-fill-url cutoff: deadline reached after snapshot rejects snapshot result, opened_manual, three commands, no handoff", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 5000;
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ]);

    const origRunner = fake.runner;
    let callCount = 0;
    const wrappedRunner: CommandRunner = async (argv, options) => {
      const result = await origRunner(argv, options);
      callCount++;
      if (callCount === 3) {
        t = DEADLINE;
      }
      return result;
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: wrappedRunner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]!.argv[fake.calls[0]!.argv.length - 2]).toBe("open");
    expect(fake.calls[1]!.argv[fake.calls[1]!.argv.length - 2]).toBe("get");
    expect(fake.calls[2]!.argv[fake.calls[2]!.argv.length - 2]).toBe("snapshot");
    for (const call of fake.calls) {
      expect(call.argv).not.toContain(HANDOFF);
    }
  });

  test("pre-fill URL at deadline: runner returns valid URL but clock reaches deadline, unavailable, four commands, no handoff", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 5000;
    const calls: RunnerCall[] = [];

    const runner: CommandRunner = async (argv, options) => {
      calls.push({ argv, ...options });
      return { status: 0, output: urlJson(PROJECT_URL) };
    };

    const wrappedRunner: CommandRunner = async (argv, options) => {
      const result = await runner(argv, options);
      if (calls.length === 4) {
        t = DEADLINE;
      }
      return result;
    };

    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
    ]);
    const origSnapshot = fake.runner;

    const mixedRunner: CommandRunner = async (argv, options) => {
      if (calls.length < 3) {
        const r = await origSnapshot(argv, options);
        calls.push({ argv, ...options });
        return r;
      }
      return wrappedRunner(argv, options);
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: mixedRunner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.argv).not.toContain(HANDOFF);
    }
  });

  test("final URL at deadline: runner returns valid conversation URL but clock reaches deadline, unavailable, seven commands, never submitted", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 10000;
    const calls: RunnerCall[] = [];

    const results = [
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ];

    let idx = 0;
    const runner: CommandRunner = async (argv, options) => {
      calls.push({ argv, ...options });
      const entry = results[idx++];
      if (!entry) return { status: 1, output: "" };
      if (calls.length === 7) {
        t = DEADLINE;
      }
      return entry;
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(result.kind).not.toBe("submitted");
    expect(calls).toHaveLength(7);
    expect(calls[4]!.argv).toContain(HANDOFF);
    for (let i = 0; i < calls.length; i++) {
      if (i !== 4) {
        expect(calls[i]!.argv).not.toContain(HANDOFF);
      }
    }
  });

  test("shared deadline rule: non-URL command result rejected at deadline boundary", async () => {
    const ws = createFakeWorkspace();
    let t = 0;
    const DEADLINE = 3000;
    const calls: RunnerCall[] = [];

    const runner: CommandRunner = async (argv, options) => {
      calls.push({ argv, ...options });
      if (calls.length === 3) {
        t = DEADLINE;
      }
      return { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) };
    };

    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
    ]);
    const origRunner = fake.runner;

    const mixedRunner: CommandRunner = async (argv, options) => {
      if (calls.length < 2) {
        const r = await origRunner(argv, options);
        calls.push({ argv, ...options });
        return r;
      }
      return runner(argv, options);
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: mixedRunner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      deadlineMs: DEADLINE,
      now: () => t,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("opened_manual");
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.argv).not.toContain(HANDOFF);
    }
  });
});

// ─── URL handling ────────────────────────────────────────────────────

describe("URL handling", () => {
  test("valid conversation URL strips query and fragment", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson("https://chatgpt.com/c/new-conv?ref=home#section") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    }));
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.conversationUrl).toBe("https://chatgpt.com/c/new-conv");
    }
  });

  test("unchanged configured Project URL still returns submitted", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.conversationUrl).toBeUndefined();
    }
  });

  test("invalid final URL from get url returns unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson("https://evil.com/phish") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });

  test("malformed final URL from get url returns unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: JSON.stringify({ success: true, data: { url: 123 } }) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });

  test("get url failure after press → unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });

  test("get url malformed JSON after press → unavailable", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: "not json" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
  });
});

// ─── Workspace cleanup ───────────────────────────────────────────────

describe("workspace cleanup", () => {
  test("workspace is always cleaned up after success", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());
    expect(ws.cleanedDirs).toEqual([ws.paths.dir]);
  });

  test("workspace is cleaned up after failure", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([{ status: 1, output: "" }]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());
    expect(ws.cleanedDirs).toEqual([ws.paths.dir]);
  });

  test("cleanup failure does not change safe result", async () => {
    const ws = createFakeWorkspace();
    const failCleanup: WorkspaceCleanup = async () => {
      throw new Error("rm failed");
    };
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: failCleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
  });

  test("cleanup targets exact generated directory", async () => {
    const ws = createFakeWorkspace("/tmp/specific-dir-12345");
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());
    expect(ws.cleanedDirs).toEqual(["/tmp/specific-dir-12345"]);
  });
});

// ─── Message safety ──────────────────────────────────────────────────

describe("message safety", () => {
  test("no raw error in messages", async () => {
    const ws = createFakeWorkspace();
    const fake: FakeRunner = {
      calls: [],
      runner: async (argv, options) => {
        fake.calls.push({ argv, ...options });
        throw new Error("ENOENT /secret/path agent-browser crash");
      },
    };
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    const msg = result.message ?? "";
    expect(msg).not.toContain("ENOENT");
    expect(msg).not.toContain("/secret");
    expect(msg).not.toContain("crash");
  });

  test("no CDP coordinates or page content in messages", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    const msg = result.message ?? "";
    expect(msg).not.toContain("9222");
    expect(msg).not.toContain("ws://");
    expect(msg).not.toContain("claim_abc");
  });

  test("no path or argv in messages", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    const msg = result.message ?? "";
    expect(msg).not.toContain("/tmp/");
    expect(msg).not.toContain("action-policy");
    expect(msg).not.toContain("--session");
  });
});

// ─── Production workspace ────────────────────────────────────────────

describe("production workspace (OS temp fixture)", () => {
  test("creates real directory with correct files, modes, content; cleans up after submit", async () => {
    const osModule = await import("node:os");
    const pathModule = await import("node:path");
    const fsModule = await import("node:fs");

    const projectRoot = pathModule.resolve(__dirname, "..");
    const tmpRoot = pathModule.resolve(osModule.tmpdir());

    let capturedCwd: string | null = null;

    const capturingRunner: CommandRunner = async (argv, options) => {
      capturedCwd = options.cwd;

      // Enumerate directory contents
      const entries = await fsModule.promises.readdir(options.cwd);
      expect(entries.sort()).toEqual(["action-policy.json", "agent-browser.json"]);

      // Stat directory — mode 0700
      const dirStat = await fsModule.promises.stat(options.cwd);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Directory is beneath OS temp and outside project checkout
      const resolvedCwd = pathModule.resolve(options.cwd);
      expect(resolvedCwd.startsWith(tmpRoot)).toBe(true);
      expect(resolvedCwd.startsWith(projectRoot)).toBe(false);

      // Stat and read policy file
      const policyPath = pathModule.join(options.cwd, "action-policy.json");
      const policyStat = await fsModule.promises.stat(policyPath);
      expect(policyStat.mode & 0o777).toBe(0o600);
      const policyContent = await fsModule.promises.readFile(policyPath, "utf8");
      const expectedPolicy = JSON.stringify(AGENT_BROWSER_POLICY, null, 2) + "\n";
      expect(policyContent).toBe(expectedPolicy);

      // Stat and read config file
      const configPath = pathModule.join(options.cwd, "agent-browser.json");
      const configStat = await fsModule.promises.stat(configPath);
      expect(configStat.mode & 0o777).toBe(0o600);
      const configContent = await fsModule.promises.readFile(configPath, "utf8");
      expect(configContent).toBe("{}\n");

      // Return open failure so submit() returns unavailable
      return { status: 1, output: "" };
    };

    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: capturingRunner,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");

    // The real workspace directory was captured and must now be cleaned up
    expect(capturedCwd).not.toBeNull();
    const dirExists = await fsModule.promises.access(capturedCwd!).then(() => true, () => false);
    expect(dirExists).toBe(false);
  });
});

// ─── Executable resolution ──────────────────────────────────────────

describe("executable resolution", () => {
  test("uses injected executable path in argv", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner(sevenStepSuccessResults());
    const sub = new AgentBrowserSubmitter({
      executablePath: "/custom/path/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    await sub.submit(makeInput());
    for (const call of fake.calls) {
      expect(call.argv[0]).toBe("/custom/path/agent-browser");
    }
  });
});

// ─── Authoritative redirect/confirmation regressions ───────────────

describe("authoritative redirect/confirmation regressions", () => {
  function lastTwo(argv: readonly string[]): [string, string] {
    return [argv[argv.length - 2]!, argv[argv.length - 1]!];
  }

  function subcommand(argv: readonly string[]): string {
    return argv[argv.length - 2]!;
  }

  function hasHandoffInArgv(argv: readonly string[]): boolean {
    return argv.some(a => a === HANDOFF);
  }

  test("post-open foreign URL: stops after open+get url, unavailable, no snapshot/fill/press/handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson("https://evil.com/phish") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(2);
    expect(subcommand(fake.calls[0]!.argv)).toBe("open");
    expect(subcommand(fake.calls[1]!.argv)).toBe("get");
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("post-open /auth/login URL: stops after two commands, unavailable, no fill/press/handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson("https://chatgpt.com/auth/login") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("post-open /login URL: stops after two commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson("https://chatgpt.com/login") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("post-open malformed envelope: stops after two commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: "not json" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("post-open missing data.url: stops after two commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: JSON.stringify({ success: true, data: {} }) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("post-open non-string data.url: stops after two commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: JSON.stringify({ success: true, data: { url: 123 } }) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("pre-fill unsafe URL (foreign): stops after four commands, unavailable, zero fill/press, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson("https://evil.com/phish") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(4);
    expect(subcommand(fake.calls[0]!.argv)).toBe("open");
    expect(subcommand(fake.calls[1]!.argv)).toBe("get");
    expect(subcommand(fake.calls[2]!.argv)).toBe("snapshot");
    expect(subcommand(fake.calls[3]!.argv)).toBe("get");
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("pre-fill safe URL change stops before fill, press, or handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });

    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls.map((call) => subcommand(call.argv)))
      .toEqual(["open", "get", "snapshot", "get"]);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("pre-fill unsafe URL (/login): stops after four commands, unavailable, zero fill/press, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson("https://chatgpt.com/login") },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(4);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("pre-fill malformed URL envelope: stops after four commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: "not json" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(4);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("pre-fill missing data.url: stops after four commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: JSON.stringify({ success: true, data: {} }) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(4);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("pre-fill non-string data.url: stops after four commands, unavailable, no handoff", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: JSON.stringify({ success: true, data: { url: 42 } }) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(fake.calls).toHaveLength(4);
    for (const call of fake.calls) {
      expect(hasHandoffInArgv(call.argv)).toBe(false);
    }
  });

  test("safe redirect: exact seven-command order, submitted with canonical conversation URL", async () => {
    const ws = createFakeWorkspace();
    const convUrl = "https://chatgpt.com/c/safe-redirect-conv";
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(convUrl) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.conversationUrl).toBe(convUrl);
    }
    expect(fake.calls).toHaveLength(7);
    expect(subcommand(fake.calls[0]!.argv)).toBe("open");
    expect(lastTwo(fake.calls[0]!.argv)[1]).toBe(PROJECT_URL);
    expect(subcommand(fake.calls[1]!.argv)).toBe("get");
    expect(subcommand(fake.calls[2]!.argv)).toBe("snapshot");
    expect(subcommand(fake.calls[3]!.argv)).toBe("get");
    expect(fake.calls[4]!.argv[fake.calls[4]!.argv.length - 3]).toBe("fill");
    expect(fake.calls[4]!.argv).toContain(HANDOFF);
    expect(subcommand(fake.calls[5]!.argv)).toBe("press");
    expect(subcommand(fake.calls[6]!.argv)).toBe("get");
    for (let i = 0; i < fake.calls.length; i++) {
      if (i !== 4) {
        expect(hasHandoffInArgv(fake.calls[i]!.argv)).toBe(false);
      }
    }
  });

  test("existing conversation same-URL follow-up: submitted after fill/press with safe final URL", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(VALID_COMPOSER_REFS) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: emptyJson() },
      { status: 0, output: emptyJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    }));
    expect(result.kind).toBe("submitted");
    expect(fake.calls).toHaveLength(7);
    expect(fake.calls[4]!.argv[fake.calls[4]!.argv.length - 3]).toBe("fill");
    expect(fake.calls[4]!.argv).toContain(HANDOFF);
    expect(subcommand(fake.calls[5]!.argv)).toBe("press");
  });

  test("post-open get url command failure returns unavailable, not opened_manual", async () => {
    const ws = createFakeWorkspace();
    const fake = createFakeRunner([
      { status: 0, output: emptyJson() },
      { status: 1, output: "" },
    ]);
    const sub = new AgentBrowserSubmitter({
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
    });
    const result = await sub.submit(makeInput());
    expect(result.kind).toBe("unavailable");
    expect(result.kind).not.toBe("opened_manual");
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.argv).not.toContain(HANDOFF);
    }
  });
});

// ─── Full bounded browser automation ────────────────────────────────

type ScriptResult = { status: number; output: string };
type ScriptEntry = ScriptResult | ((call: RunnerCall) => ScriptResult | Promise<ScriptResult>);

const automationTemporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    automationTemporaryPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

const automationJson = (data: Record<string, unknown> = {}): string =>
  JSON.stringify({ success: true, data });

const countJson = (count: number): string => automationJson({ count });
const textJson = (text: string): string => automationJson({ text });

const AUTOMATION_REQUEST_ID = "a".repeat(32);
const ownEnvelope = (answer: string): string => browserCompletionEnvelope(AUTOMATION_REQUEST_ID, answer);
const AUTOMATION_PROMPT = "Bounded automatic consultation prompt";
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

const COMPOSER_SNAPSHOT = {
  e1: { role: "textbox", name: "Message ChatGPT" },
  e2: { role: "button", name: "Send" },
};

const STOP_SNAPSHOT = {
  e1: { role: "textbox", name: "Message ChatGPT" },
  e4: { role: "button", name: "Stop generating" },
};

function commandArgs(argv: readonly string[]): readonly string[] {
  const index = argv.indexOf("--json");
  expect(index).toBeGreaterThan(-1);
  return argv.slice(index + 1);
}

function createScriptedRunner(entries: readonly ScriptEntry[], events: string[] = [],
  proof: { userTurnText?: () => string; sendReady?: () => number } = {}): FakeRunner {
  const calls: RunnerCall[] = [];
  let index = 0;
  let prompt = "";
  return {
    calls,
    runner: async (argv, options) => {
      const call = { argv, ...options };
      calls.push(call);
      const args = commandArgs(argv);
      events.push(`command:${args.join(" ")}`);
      if (args[0] === "fill") prompt = args[2]!;
      if (args[0] === "find" && args[2] === '[data-message-author-role="user"]') {
        const output = textJson(proof.userTurnText?.() ?? prompt);
        return Buffer.byteLength(output) > options.maxBytes ? { status: 1, output: "" } : { status: 0, output };
      }
      if (args[0] === "get" && args[2] === 'button[data-testid="send-button"]:enabled') {
        return { status: 0, output: countJson(proof.sendReady?.() ?? 1) };
      }
      const entry = entries[index++];
      if (entry === undefined) throw new Error(`Unexpected command: ${args.join(" ")}`);
      return typeof entry === "function" ? await entry(call) : entry;
    },
  };
}

interface AutomationHarness {
  automation: AgentBrowserAutomation;
  fake: FakeRunner;
  hooks: BrowserAutomationHooks;
  hookCalls: {
    before: number;
    confirmed: string[];
    heartbeat: number;
    heartbeatAt: number[];
    cancelled: number;
    navigation: number;
  };
  events: string[];
  now(): number;
}

function createAutomationHarness(
  entries: readonly ScriptEntry[],
  options: {
    deadlineMs?: number;
    cancel?: (harness: AutomationHarness) => boolean;
    heartbeatError?: (harness: AutomationHarness) => Error | null;
    onSleep?: (now: number, harness: AutomationHarness) => void;
    onCommandWait?: (now: number, harness: AutomationHarness) => void;
    commandWaitStepMs?: number;
    ownedTabCleanup?: (input: {
      targetId: string;
      sessionPort: number;
      workspace: WorkspacePaths;
      env: Record<string, string>;
    }) => Promise<void>;
    cdpPageClientFactory?: CdpPageClientFactory;
    userTurnText?: () => string;
    sendReady?: () => number;
    rateLimitGate?: AgentBrowserAutomationOptions["rateLimitGate"];
  } = {},
): AutomationHarness {
  const events: string[] = [];
  const fake = createScriptedRunner(entries, events, options);
  const ws = createFakeWorkspace("/tmp/fake-ab-automation");
  let clock = 0;
  const hookCalls = {
    before: 0,
    confirmed: [] as string[],
    heartbeat: 0,
    heartbeatAt: [] as number[],
    cancelled: 0,
    navigation: 0,
  };
  const harness = {} as AutomationHarness;
  const hooks: BrowserAutomationHooks = {
    async beforeSubmission() {
      hookCalls.before++;
      events.push("hook:beforeSubmission");
    },
    async submissionConfirmed(conversationUrl) {
      hookCalls.confirmed.push(conversationUrl);
      events.push(`hook:submissionConfirmed ${conversationUrl}`);
    },
    async heartbeat() {
      hookCalls.heartbeat++;
      hookCalls.heartbeatAt.push(clock);
      events.push("hook:heartbeat");
      const error = options.heartbeatError?.(harness) ?? null;
      if (error !== null) throw error;
    },
    async isCancelled() {
      hookCalls.cancelled++;
      return options.cancel?.(harness) ?? false;
    },
    async navigationConfirmed() {
      hookCalls.navigation++;
      events.push("hook:navigationConfirmed");
    },
  };
  Object.assign(harness, {
    fake,
    hooks,
    hookCalls,
    events,
    now: () => clock,
    automation: Reflect.construct(AgentBrowserAutomation, [{
      executablePath: "/usr/bin/agent-browser",
      commandRunner: fake.runner,
      workspaceFactory: ws.factory,
      workspaceCleanup: ws.cleanup,
      ...(options.rateLimitGate === undefined ? {} : { rateLimitGate: options.rateLimitGate }),
      ...(options.ownedTabCleanup === undefined
        ? {}
        : { ownedTabCleanup: options.ownedTabCleanup }),
      ...(options.cdpPageClientFactory === undefined
        ? {}
        : { cdpPageClientFactory: options.cdpPageClientFactory }),
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds;
        options.onSleep?.(clock, harness);
      },
      ...(options.onCommandWait === undefined ? {} : {
        commandWait: async (milliseconds: number, signal: AbortSignal) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (signal.aborted) return;
          clock += Math.min(milliseconds, options.commandWaitStepMs ?? milliseconds);
          options.onCommandWait?.(clock, harness);
        },
      }),
    }]) as AgentBrowserAutomation,
  });
  return harness;
}

async function createAutomationInput(
  overrides: Partial<BrowserAutomationInput> = {},
): Promise<BrowserAutomationInput> {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "chatgpt-consult-automation-"));
  automationTemporaryPaths.push(stagingDirectory);
  const canonicalStagingDirectory = await realpath(stagingDirectory);
  return {
    session: SESSION,
    mode: "submit_and_collect",
    requestId: AUTOMATION_REQUEST_ID,
    targetUrl: PROJECT_URL,
    targetKind: "configured",
    prompt: AUTOMATION_PROMPT,
    uploadPaths: [],
    stagingDirectory: canonicalStagingDirectory,
    maximumResponseBytes: 1_024,
    ...overrides,
  };
}

function rootSuccessScript(answer = "stable response"): ScriptResult[] {
  const response = ownEnvelope(answer);
  return [
    { status: 0, output: automationJson() },
    { status: 0, output: urlJson(PROJECT_URL) },
    { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
    { status: 0, output: countJson(0) },
    { status: 0, output: urlJson(PROJECT_URL) },
    { status: 0, output: automationJson() },
    { status: 0, output: urlJson(PROJECT_URL) },
    { status: 0, output: automationJson() },
    { status: 0, output: urlJson(`${CONVERSATION_URL}?model=auto#latest`) },
    { status: 0, output: urlJson(CONVERSATION_URL) },
    { status: 0, output: snapshotJson(STOP_SNAPSHOT) },
    { status: 0, output: urlJson(CONVERSATION_URL) },
    { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
    { status: 0, output: countJson(1) },
    { status: 0, output: urlJson(CONVERSATION_URL) },
    { status: 0, output: textJson(response) },
    { status: 0, output: urlJson(CONVERSATION_URL) },
    { status: 0, output: textJson(response) },
  ];
}

function browserCompletionEnvelope(requestId: string, answer = "current response"): string {
  return [
    BROWSER_RESULT_BEGIN,
    JSON.stringify({
      schemaVersion: 1,
      requestId,
      expectedRevision: 0,
      completion: {
        summary: "Bounded browser response",
        answer,
        evidence: [],
        assumptions: [],
        risks: [],
        recommendations: [],
        followUpQuestions: [],
      },
    }),
    BROWSER_RESULT_END,
  ].join("\n");
}

describe("AgentBrowserAutomation", () => {
  test("completes within the bound Project and records only its nested conversation", async () => {
    const conversationUrl = "https://chatgpt.com/g/projects-test/c/project-conversation";
    const projectUrl = "https://chatgpt.com/g/projects-test/project";
    const script = rootSuccessScript("Project answer").map((result) => ({
      ...result, output: result.output.replaceAll(CONVERSATION_URL, conversationUrl).replaceAll(PROJECT_URL, projectUrl),
    }));
    const harness = createAutomationHarness(script);
    const result = await harness.automation.run(await createAutomationInput({
      targetUrl: projectUrl, projectUrl,
    }), harness.hooks);
    expect(result).toEqual({ kind: "completed", conversationUrl, responseText: ownEnvelope("Project answer") });
    expect(harness.hookCalls.confirmed).toEqual([conversationUrl]);
    expect(commandArgs(harness.fake.calls[0]!.argv)).toEqual(["open", projectUrl]);
  });

  test("submits a fresh Project chat and collects two byte-identical final reads", async () => {
    const harness = createAutomationHarness(rootSuccessScript());
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: ownEnvelope("stable response"),
    });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv))).toEqual([
      ["open", PROJECT_URL],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "count", ASSISTANT_SELECTOR],
      ["get", "url"],
      ["fill", "@e1", AUTOMATION_PROMPT],
      ["get", "url"],
      ["press", "Enter"],
      ["get", "url"],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "count", ASSISTANT_SELECTOR],
      ["get", "url"],
      ["find", "last", ASSISTANT_SELECTOR, "text"],
      ["get", "url"],
      ["find", "last", ASSISTANT_SELECTOR, "text"],
    ]);
    expect(harness.events.indexOf("hook:beforeSubmission"))
      .toBeLessThan(harness.events.indexOf("command:press Enter"));
    expect(harness.events.indexOf(`command:get url`)).toBeGreaterThan(-1);
    expect(harness.events.indexOf(`hook:submissionConfirmed ${CONVERSATION_URL}`))
      .toBeGreaterThan(harness.events.indexOf("command:press Enter"));
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([CONVERSATION_URL]);
  });

  test("cleans up only the exact tab created for the bounded request", async () => {
    const targetId = "D".repeat(32);
    const script = rootSuccessScript("owned tab cleanup");
    script[0] = { status: 0, output: automationJson({ targetId }) };
    const cleaned: Array<{
      targetId: string;
      sessionPort: number;
      workspace: WorkspacePaths;
      env: Record<string, string>;
    }> = [];
    const harness = createAutomationHarness(script, {
      ownedTabCleanup: async (input) => { cleaned.push(input); },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toMatchObject({
      targetId,
      sessionPort: 9222,
      workspace: { dir: "/tmp/fake-ab-automation" },
    });
  });

  test("accepts the current Project-scoped dynamic composer name", async () => {
    const dynamicComposer = {
      e44: { role: "textbox", name: "New chat in Private Project" },
    };
    const script = rootSuccessScript("dynamic composer");
    script[2] = { status: 0, output: snapshotJson(dynamicComposer) };
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(commandArgs(harness.fake.calls[5]!.argv)).toEqual([
      "fill", "@e44", AUTOMATION_PROMPT,
    ]);
  });

  test("waits for the authenticated Project composer to finish loading", async () => {
    const dynamicComposer = {
      e44: { role: "textbox", name: "New chat in Private Project" },
    };
    const script = rootSuccessScript("loaded composer");
    script[2] = { status: 0, output: snapshotJson({}) };
    script.splice(
      3,
      0,
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(dynamicComposer) },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)).slice(0, 5)).toEqual([
      ["open", PROJECT_URL],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "url"],
      ["snapshot", "-i"],
    ]);
  });

  test("uses exact isolated argv, clean environment, and per-command bounded ceilings", async () => {
    const harness = createAutomationHarness(rootSuccessScript("page secret must not leak"));
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result.kind).toBe("completed");

    for (const [index, call] of harness.fake.calls.entries()) {
      expect(call.argv[0]).toBe("/usr/bin/agent-browser");
      expect(call.argv).toContain("--cdp");
      expect(call.argv[call.argv.indexOf("--cdp") + 1]).toBe("9222");
      expect(call.argv).toContain("--pin-tab");
      expect(call.argv).toContain("--content-boundaries");
      expect(call.argv).toContain("--action-policy");
      expect(call.argv).toContain("--config");
      expect(call.argv).toContain("--json");
      expect(call.cwd).toBe("/tmp/fake-ab-automation");
      expect(call.env).toEqual({
        PATH: process.env.PATH ?? "",
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1",
        HOME: "/tmp/fake-ab-automation",
        XDG_CONFIG_HOME: "/tmp/fake-ab-automation",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      });
      const command = commandArgs(call.argv)[0];
      const finalRead = command === "find";
      expect(call.maxBytes).toBe(finalRead ? 17_408 : command === "snapshot" ? 131_072 : 12_288);
      expect(call.argv[call.argv.indexOf("--max-output") + 1])
        .toBe(finalRead ? "17408" : "12000");
    }

    const forbidden = new Set([
      "eval", "evalhandle", "addscript", "addinitscript", "setcontent",
      "download", "waitfordownload", "network", "route", "requests", "har",
      "state", "cookies", "storage", "screenshot",
    ]);
    for (const call of harness.fake.calls) {
      expect(forbidden.has(commandArgs(call.argv)[0]!)).toBe(false);
      expect(call.argv).not.toContain("--profile");
      expect(call.argv).not.toContain("--headed");
      expect(call.argv).not.toContain("--headers");
      expect(call.argv).not.toContain("--init-script");
    }
  });

  test("allows bounded JSON-envelope overhead for interactive snapshots", async () => {
    const harness = createAutomationHarness(rootSuccessScript());
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result.kind).toBe("completed");

    const snapshotCalls = harness.fake.calls.filter(
      (call) => commandArgs(call.argv)[0] === "snapshot",
    );
    expect(snapshotCalls.length).toBeGreaterThan(0);
    for (const call of snapshotCalls) {
      expect(call.maxBytes).toBe(131_072);
      expect(call.argv[call.argv.indexOf("--max-output") + 1]).toBe("12000");
    }
  });

  test("uploads only exact verified staged files and refreshes composer refs", async () => {
    const input = await createAutomationInput();
    const first = join(input.stagingDirectory, "001-review.pdf");
    const second = join(input.stagingDirectory, "002-log.txt");
    await writeFile(first, "pdf");
    await writeFile(second, "log");
    const uploadedRefs = { e7: { role: "textbox", name: "Message ChatGPT" } };
    let readyReads = 0;
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: snapshotJson(uploadedRefs) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("uploaded")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("uploaded")) },
    ], { sendReady: () => ++readyReads >= 3 ? 1 : 0 });

    const result = await harness.automation.run({
      ...input,
      uploadPaths: [first, second],
    }, harness.hooks);

    expect(result.kind).toBe("completed");
    expect(readyReads).toBe(3);
    const commands = harness.fake.calls.map((call) => commandArgs(call.argv));
    expect(commands.filter((args) => args[0] === "click")).toEqual([["click", 'button[data-testid="send-button"]:enabled']]);
    expect(commands.some((args) => args[0] === "press")).toBeFalse();
    expect(commandArgs(harness.fake.calls[5]!.argv)).toEqual([
      "upload", "input#upload-files[type=file]", first, second,
    ]);
    expect(commandArgs(harness.fake.calls[6]!.argv)).toEqual(["snapshot", "-i"]);
    expect(commandArgs(harness.fake.calls[8]!.argv)).toEqual([
      "fill", "@e7", AUTOMATION_PROMPT,
    ]);
  });

  test("an unchanged follow-up URL cannot confirm an Enter key that sent no message", async () => {
    const prior = browserCompletionEnvelope("b".repeat(32), "previous answer");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      ...Array.from({ length: 20 }, () => ({ status: 0, output: urlJson(CONVERSATION_URL) })),
    ], { userTurnText: () => "The previous user message", deadlineMs: 6000 });
    const result = await harness.automation.run(await createAutomationInput({
      targetKind: "conversation", targetUrl: CONVERSATION_URL,
    }), harness.hooks);
    expect(result).toMatchObject({ kind: "recovery", reason: "submission_uncertain", certainty: "uncertain" });
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([]);
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "press")).toHaveLength(1);
  });

  test("an unfinished upload never attempts to send the prompt", async () => {
    const input = await createAutomationInput();
    const attachment = join(input.stagingDirectory, "attachment.txt");
    await writeFile(attachment, "synthetic attachment");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
    ], { sendReady: () => 0, deadlineMs: 3000 });
    const result = await harness.automation.run({ ...input, uploadPaths: [attachment] }, harness.hooks);
    expect(result).toMatchObject({ kind: "recovery", reason: "upload_failed", certainty: "not_submitted" });
    expect(harness.hookCalls.before).toBe(0);
    expect(harness.fake.calls.some((call) => ["press", "click"].includes(commandArgs(call.argv)[0]!))).toBeFalse();
  });

  test("a rate-limit dialog pauses peer workers before they open another tab", async () => {
    let paused = false;
    const gate = {
      isBlocked: async () => paused,
      pause: async (port: number) => { expect(port).toBe(9222); paused = true; },
    };
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({
        e1: { role: "dialog", name: "Too many requests" },
        e2: { role: "button", name: "Got it" },
      }) },
    ], { rateLimitGate: gate });
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result).toMatchObject({ reason: "rate_limited", certainty: "not_submitted", phase: "needs_manual" });
    expect(harness.hookCalls.before).toBe(0);
    expect(paused).toBeTrue();
    const peer = createAutomationHarness([], { rateLimitGate: gate });
    const resumed = await peer.automation.run(await createAutomationInput({
      mode: "collect_only", targetUrl: CONVERSATION_URL, targetKind: "conversation",
    }), peer.hooks);
    expect(resumed).toMatchObject({ reason: "rate_limited", certainty: "submitted", conversationUrl: CONVERSATION_URL });
    expect(peer.fake.calls).toHaveLength(0);
  });

  test("Project-bound requests reject an ordinary chat redirect after sending without a second send", async () => {
    const harness = createAutomationHarness(rootSuccessScript());
    const result = await harness.automation.run(await createAutomationInput({ projectUrl: PROJECT_URL }), harness.hooks);
    expect(result).toMatchObject({ reason: "submission_uncertain", certainty: "uncertain" });
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([]);
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "press")).toHaveLength(1);
  });

  test("Project-bound follow-ups refuse a conversation outside their Project before opening", async () => {
    const harness = createAutomationHarness([]);
    const result = await harness.automation.run(await createAutomationInput({
      projectUrl: PROJECT_URL, targetKind: "conversation", targetUrl: CONVERSATION_URL,
    }), harness.hooks);
    expect(result).toMatchObject({ reason: "ui_changed", certainty: "not_submitted" });
    expect(harness.fake.calls).toHaveLength(0);
  });

  test("recognizes a rate-limit warning when the interactive snapshot omits its heading", async () => {
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({ e1: { role: "button", name: "Got it" } }) },
      { status: 0, output: textJson("Too many requests\nYou're making requests too quickly.\nPlease wait a few minutes before trying again.\nGot it") },
    ]);
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result).toMatchObject({ reason: "rate_limited", certainty: "not_submitted" });
    expect(harness.hookCalls.before).toBe(0);
    expect(harness.fake.calls.some((call) => commandArgs(call.argv)[0] === "click")).toBeFalse();
  });

  test("recovers a root request from one existing Project conversation via one scoped new-chat control", async () => {
    const projectNewChat = {
      ...COMPOSER_SNAPSHOT,
      e9: { role: "link", name: "New chat in project" },
    };
    const script = rootSuccessScript("fresh recovery");
    script.splice(
      1,
      3,
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(projectNewChat) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)).slice(0, 7)).toEqual([
      ["open", PROJECT_URL],
      ["get", "url"],
      ["snapshot", "-i"],
      ["click", "@e9"],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "count", ASSISTANT_SELECTOR],
    ]);
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "click")).toHaveLength(1);
  });

  test("opens one project-scoped new chat from an authenticated Project landing", async () => {
    const projectLanding = {
      e9: { role: "link", name: "New chat in project" },
    };
    const script = rootSuccessScript("fresh landing");
    script.splice(
      1,
      3,
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(projectLanding) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)).slice(0, 7)).toEqual([
      ["open", PROJECT_URL],
      ["get", "url"],
      ["snapshot", "-i"],
      ["click", "@e9"],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "count", ASSISTANT_SELECTOR],
    ]);
  });

  test.each(["Markdown", "escaped newlines"])("proves a follow-up's new message with %s rendering", async (rendering) => {
    const prior = browserCompletionEnvelope("b".repeat(32), "earlier answer");
    const prompt = formatBrowserPrompt(AUTOMATION_REQUEST_ID, 0,
      rendering === "Markdown" ? "Review this:\n```json\n{\"limit\": 3}\n```" : "a\n".repeat(30_000), "lean");
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(65_536);
    if (rendering === "escaped newlines") expect(Buffer.byteLength(textJson(prompt))).toBeGreaterThan(81_920);
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(`${CONVERSATION_URL}?model=auto`) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(3) },
      { status: 0, output: countJson(3) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: countJson(3) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(4) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("same chat")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("same chat")) },
    ], { userTurnText: () => prompt.replaceAll("```", "").replaceAll(" ", "\u00a0") + "\nShow more" });
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
      prompt,
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: ownEnvelope("same chat"),
    });
    expect(commandArgs(harness.fake.calls[3]!.argv)).toEqual([
      "get", "count", ASSISTANT_SELECTOR,
    ]);
    expect(commandArgs(harness.fake.calls[16]!.argv)).toEqual([
      "get", "count", ASSISTANT_SELECTOR,
    ]);
  });

  test("waits for the exact follow-up conversation composer to finish loading", async () => {
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson({}) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(ownEnvelope("earlier turn")) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(ownEnvelope("earlier turn")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("loaded follow-up")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("loaded follow-up")) },
    ]);
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)).slice(0, 5)).toEqual([
      ["open", CONVERSATION_URL],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "url"],
      ["snapshot", "-i"],
    ]);
  });

  test("waits for the follow-up conversation to hydrate before settling its prior answer", async () => {
    const early = browserCompletionEnvelope("b".repeat(32), "first hydrated turn");
    const prior = browserCompletionEnvelope("c".repeat(32), "last hydrated turn");
    const own = browserCompletionEnvelope(AUTOMATION_REQUEST_ID, "after hydration");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: countJson(0) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(early) },
      { status: 0, output: countJson(2) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: countJson(2) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(own) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(own) },
    ]);
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: own,
    });
    const texts = harness.fake.calls
      .map((call) => commandArgs(call.argv))
      .filter((argv) => argv[0] === "find" && argv[2] === ASSISTANT_SELECTOR);
    expect(texts).toHaveLength(6);
  });

  test("tolerates a new stable non-envelope answer for two read pairs, then accepts the envelope", async () => {
    const prior = browserCompletionEnvelope("d".repeat(32), "earlier answer");
    const own = browserCompletionEnvelope(AUTOMATION_REQUEST_ID, "child answer");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Thinking") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Thinking") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Thinking") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Thinking") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(own) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(own) },
    ]);
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: own,
    });
  });

  test("fails a new answer that stays a stable non-envelope for three read pairs", async () => {
    const prior = browserCompletionEnvelope("d".repeat(32), "earlier answer");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: countJson(1) },
      { status: 0, output: textJson(prior) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(2) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
    ]);
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "invalid_response",
      rejectedText: "Internal Server Error",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(harness.fake.calls).toHaveLength(14 + 3 * 7);
  });

  test("treats any control whose name starts with stop as active generation", async () => {
    const script = rootSuccessScript();
    script.splice(10, 1, { status: 0, output: snapshotJson({ e1: { role: "button", name: "Stop streaming" } }) });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.fake.calls).toHaveLength(18);
  });

  test("keeps polling while the newest assistant message is still empty", async () => {
    const script = rootSuccessScript("filled later");
    script.splice(15, 0,
      { status: 0, output: textJson("") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: ownEnvelope("filled later"),
    });
  });

  test("fails fast when the stable final answer carries the end sentinel but no valid envelope", async () => {
    const broken = `${BROWSER_RESULT_BEGIN}\n{"schemaVersion":1,"requestId":"${AUTOMATION_REQUEST_ID}"\n${BROWSER_RESULT_END}`;
    const harness = createAutomationHarness(rootSuccessScript().map((step, index) =>
      index === 15 || index === 17 ? { status: 0, output: textJson(broken) } : step));

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "invalid_response",
      rejectedText: broken,
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(harness.fake.calls).toHaveLength(18);
  });

  test.each(["strict", "rendered citations", "fenced"])("collect-only delivers an already-present %s answer without resubmitting", async (format) => {
    const raw = browserCompletionEnvelope(AUTOMATION_REQUEST_ID, "resumed\nExample Docs\n+2");
    const response = format === "rendered citations" ? raw.replaceAll("\\n", "\n")
      : format === "fenced" ? raw.replace(`${BROWSER_RESULT_BEGIN}\n`, `${BROWSER_RESULT_BEGIN}\n\`\`\`json\n`)
        .replace(`\n${BROWSER_RESULT_END}`, `\n\`\`\`\n${BROWSER_RESULT_END}`) : raw;
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ]);
    const input = await createAutomationInput({
      mode: "collect_only",
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "immediate",
    });
    expect(harness.fake.calls).toHaveLength(5);
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "find")).toHaveLength(1);
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("fill");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("press");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("upload");
    expect(harness.hookCalls.before).toBe(0);
    expect(harness.hookCalls.confirmed).toEqual([]);
  });

  test("collect-only polls past a stable stale response until the exact request envelope arrives", async () => {
    const stale = browserCompletionEnvelope("b".repeat(32), "stale response must not be returned");
    const current = browserCompletionEnvelope(AUTOMATION_REQUEST_ID, "current response");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(4) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(4) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(current) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(current) },
    ]);
    const input = await createAutomationInput({
      mode: "collect_only",
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: current,
      collectionPath: "polling",
    });
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "find")).toHaveLength(5);
  });

  test("collect-only refuses a stable stale response until its bounded deadline without leaking it", async () => {
    const stale = browserCompletionEnvelope("b".repeat(32), "stale secret response");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(4) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(4) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(stale) },
    ], { deadlineMs: 2_000 });
    const input = await createAutomationInput({
      mode: "collect_only",
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "polling",
    });
    expect(JSON.stringify(result)).not.toContain("stale secret response");
    expect(JSON.stringify(result)).not.toContain("b".repeat(32));
  });

  test("collect-only preserves submitted certainty and its known URL when open fails", async () => {
    const harness = createAutomationHarness([
      { status: 1, output: "raw unavailable browser detail" },
    ]);
    const input = await createAutomationInput({
      mode: "collect_only",
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "browser_unavailable",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
  });

  test.each([
    ["auth URL", [
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson("https://chatgpt.com/auth/login") },
    ], "needs_login", "login_required", "not_submitted"],
    ["login screen without composer", [
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson("https://chatgpt.com/") },
      { status: 0, output: snapshotJson({ e8: { role: "button", name: "Log in" } }) },
    ], "needs_login", "login_required", "not_submitted"],
    ["CAPTCHA", [
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({ e8: { role: "button", name: "Verify you are human" } }) },
    ], "needs_manual", "human_challenge", "not_submitted"],
    ["consent dialog", [
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({ e8: { role: "button", name: "Accept all cookies" } }) },
    ], "needs_manual", "human_challenge", "not_submitted"],
    ["generic dialog", [
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({
        ...COMPOSER_SNAPSHOT,
        e8: { role: "dialog" },
      }) },
    ], "needs_manual", "ui_changed", "not_submitted"],
    ["multiple composers", [
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({
        e1: { role: "textbox", name: "Message ChatGPT" },
        e2: { role: "textbox", name: "Ask ChatGPT" },
      }) },
    ], "needs_manual", "ui_changed", "not_submitted"],
  ] as const)("classifies %s without typing", async (_name, entries, phase, reason, certainty) => {
    const harness = createAutomationHarness(entries);
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result).toEqual({ kind: "recovery", phase, reason, certainty });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("fill");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("press");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("upload");
  });

  test("returns upload_failed and never places an unverified path in argv", async () => {
    const input = await createAutomationInput();
    const outside = await mkdtemp(join(tmpdir(), "chatgpt-consult-outside-"));
    automationTemporaryPaths.push(outside);
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    const harness = createAutomationHarness([]);

    const result = await harness.automation.run({ ...input, uploadPaths: [outsideFile] }, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "upload_failed",
      certainty: "not_submitted",
    });
    expect(harness.fake.calls).toHaveLength(0);
  });

  test("rejects symlinked and non-regular staged uploads before argv construction", async () => {
    const input = await createAutomationInput();
    const target = join(input.stagingDirectory, "target.txt");
    const link = join(input.stagingDirectory, "link.txt");
    const directory = join(input.stagingDirectory, "directory.txt");
    await writeFile(target, "safe");
    await symlink(target, link);
    await mkdir(directory);

    for (const uploadPath of [link, directory]) {
      const harness = createAutomationHarness([]);
      const result = await harness.automation.run({ ...input, uploadPaths: [uploadPath] }, harness.hooks);
      expect(result).toMatchObject({
        kind: "recovery",
        reason: "upload_failed",
        certainty: "not_submitted",
      });
      expect(harness.fake.calls).toHaveLength(0);
    }
  });

  test("returns upload_failed when the bounded upload command fails", async () => {
    const input = await createAutomationInput();
    const file = join(input.stagingDirectory, "001.txt");
    await writeFile(file, "safe");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 1, output: "raw upload error /private/secret" },
    ]);

    const result = await harness.automation.run({ ...input, uploadPaths: [file] }, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "upload_failed",
      certainty: "not_submitted",
    });
    expect(JSON.stringify(result)).not.toContain("/private/secret");
  });

  test("revalidates a staged upload after URL proof and before constructing subprocess argv", async () => {
    const input = await createAutomationInput();
    const file = join(input.stagingDirectory, "001.txt");
    const outside = await mkdtemp(join(tmpdir(), "chatgpt-consult-replaced-upload-"));
    automationTemporaryPaths.push(outside);
    const outsideFile = join(outside, "outside.txt");
    await writeFile(file, "initially safe");
    await writeFile(outsideFile, "outside");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      async () => {
        await rm(file);
        await symlink(outsideFile, file);
        return { status: 0, output: urlJson(PROJECT_URL) };
      },
    ]);

    const result = await harness.automation.run({ ...input, uploadPaths: [file] }, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "upload_failed",
      certainty: "not_submitted",
    });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("upload");
  });

  test("maps final-read output overflow to a submitted invalid response", async () => {
    const script: ScriptEntry[] = rootSuccessScript();
    script.splice(15, 1, () => {
      throw new RangeError("raw output /secret/path exceeded");
    });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "invalid_response",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("times out bounded generation polling and emits a lease heartbeat by ten seconds", async () => {
    const script: ScriptResult[] = rootSuccessScript();
    script.splice(
      9,
      script.length - 9,
      ...Array.from({ length: 11 }, () => [
        { status: 0, output: urlJson(CONVERSATION_URL) },
        { status: 0, output: snapshotJson(STOP_SNAPSHOT) },
      ]).flat(),
    );
    const harness = createAutomationHarness(script, { deadlineMs: 11_000 });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(harness.hookCalls.heartbeat).toBeGreaterThanOrEqual(1);
    expect(harness.now()).toBe(11_000);
  });

  test("rejects foreign navigation immediately before submission without invoking certainty callbacks", async () => {
    const script = rootSuccessScript();
    script.splice(6, script.length - 6, { status: 0, output: urlJson("https://example.com/phish") });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "ui_changed",
      certainty: "not_submitted",
    });
    expect(harness.hookCalls.before).toBe(0);
    expect(harness.hookCalls.confirmed).toEqual([]);
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("press");
  });

  test("rejects foreign navigation immediately before upload without uploading or typing", async () => {
    const input = await createAutomationInput();
    const file = join(input.stagingDirectory, "001.txt");
    await writeFile(file, "safe");
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson("https://example.com/phish") },
    ]);

    const result = await harness.automation.run({ ...input, uploadPaths: [file] }, harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "ui_changed",
      certainty: "not_submitted",
    });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("upload");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("fill");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("press");
  });

  test("rejects foreign navigation immediately before fill without typing or submitting", async () => {
    const script = rootSuccessScript();
    script.splice(4, script.length - 4, { status: 0, output: urlJson("https://example.com/phish") });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "ui_changed",
      certainty: "not_submitted",
    });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("fill");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("press");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("find");
  });

  test("rejects foreign navigation during collection before reading any response text", async () => {
    const script = rootSuccessScript();
    script.splice(9, script.length - 9, { status: 0, output: urlJson("https://example.com/phish") });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "ui_changed",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("find");
  });

  test("rejects foreign navigation between final response reads without a second read", async () => {
    const script = rootSuccessScript();
    script.splice(
      9,
      script.length - 9,
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("first read must not be returned")) },
      { status: 0, output: urlJson("https://example.com/phish") },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "ui_changed",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "find")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("first read must not be returned");
  });

  test("stops immediately when collection is cancelled after confirmation", async () => {
    const script = rootSuccessScript();
    const harness = createAutomationHarness(script, {
      cancel: (value) => value.hookCalls.confirmed.length === 1,
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
    expect(harness.fake.calls.map((call) => commandArgs(call.argv))).toHaveLength(9);
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("find");
  });

  test("keeps polling a missing response until the bounded deadline", async () => {
    const script = rootSuccessScript();
    script.splice(
      9,
      script.length - 9,
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
    );
    const harness = createAutomationHarness(script, { deadlineMs: 2_000 });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
    });
  });

  test("waits through delayed generation start and then collects the stable response", async () => {
    const script = rootSuccessScript("delayed response");
    script.splice(
      9,
      script.length - 9,
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(STOP_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("delayed response")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("delayed response")) },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: ownEnvelope("delayed response"),
    });
    expect(harness.now()).toBe(3_000);
  });

  test("does not accept a changed response until a later pair is byte-identical", async () => {
    const script = rootSuccessScript();
    script.splice(
      9,
      script.length - 9,
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("draft A")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("draft B")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("final C")) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(ownEnvelope("final C")) },
    );
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: ownEnvelope("final C"),
    });
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "find")).toHaveLength(4);
  });

  test("press failure is submission_uncertain and can never be retried automatically", async () => {
    const script = rootSuccessScript();
    script.splice(7, script.length - 7, { status: 1, output: "raw press failure" });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "submission_uncertain",
      certainty: "uncertain",
    });
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([]);
  });

  test("waits for delayed conversation navigation after successful Enter", async () => {
    const script = rootSuccessScript("delayed navigation");
    script[8] = { status: 0, output: urlJson(PROJECT_URL) };
    script.splice(9, 0, { status: 0, output: urlJson(CONVERSATION_URL) });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)).slice(7, 10)).toEqual([
      ["press", "Enter"],
      ["get", "url"],
      ["get", "url"],
    ]);
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([CONVERSATION_URL]);
  });

  test("foreign navigation after Enter is submission_uncertain", async () => {
    const script = rootSuccessScript();
    script.splice(8, script.length - 8, { status: 0, output: urlJson("https://evil.example/chat") });
    const harness = createAutomationHarness(script);

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toMatchObject({
      kind: "recovery",
      reason: "submission_uncertain",
      certainty: "uncertain",
    });
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([]);
  });

  test("renews the lease every ten seconds while one browser command remains pending", async () => {
    let release!: (value: ScriptResult) => void;
    const pending = new Promise<ScriptResult>((resolve) => {
      release = resolve;
    });
    const fallback = setTimeout(() => release({ status: 0, output: automationJson() }), 25);
    const script: ScriptEntry[] = [() => pending, ...rootSuccessScript().slice(1)];
    const harness = createAutomationHarness(script, {
      deadlineMs: 40_000,
      commandWaitStepMs: 5_000,
      onCommandWait: (now) => {
        if (now >= 25_000) release({ status: 0, output: automationJson() });
      },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    clearTimeout(fallback);

    expect(result.kind).toBe("completed");
    expect(harness.hookCalls.heartbeatAt).toEqual([10_000, 20_000]);
    expect(harness.hookCalls.heartbeatAt.every((value, index, all) =>
      index === 0 ? value <= 10_000 : value - all[index - 1]! <= 10_000)).toBe(true);
    expect(commandArgs(harness.fake.calls[0]!.argv)).toEqual(["open", PROJECT_URL]);
  });

  test("heartbeat failure during a pending command stops before any later browser mutation", async () => {
    let release!: (value: ScriptResult) => void;
    const pending = new Promise<ScriptResult>((resolve) => {
      release = resolve;
    });
    const fallback = setTimeout(() => release({ status: 0, output: automationJson() }), 25);
    const script: ScriptEntry[] = [() => pending, ...rootSuccessScript().slice(1)];
    const harness = createAutomationHarness(script, {
      deadlineMs: 40_000,
      commandWaitStepMs: 5_000,
      onCommandWait: () => {},
      heartbeatError: () => {
        release({ status: 0, output: automationJson() });
        return new Error("raw heartbeat detail");
      },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    clearTimeout(fallback);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "not_submitted",
    });
    expect(harness.fake.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("heartbeat");
  });

  test("cancellation during a pending command stops before any later browser mutation", async () => {
    let release!: (value: ScriptResult) => void;
    const pending = new Promise<ScriptResult>((resolve) => {
      release = resolve;
    });
    const fallback = setTimeout(() => release({ status: 0, output: automationJson() }), 25);
    const script: ScriptEntry[] = [() => pending, ...rootSuccessScript().slice(1)];
    const harness = createAutomationHarness(script, {
      deadlineMs: 40_000,
      commandWaitStepMs: 5_000,
      onCommandWait: () => {},
      cancel: (value) => {
        if (value.now() < 10_000) return false;
        release({ status: 0, output: automationJson() });
        return true;
      },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    clearTimeout(fallback);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "browser_unavailable",
      certainty: "not_submitted",
    });
    expect(harness.fake.calls).toHaveLength(1);
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("fill");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("press");
  });

  test("caps response-command ceilings at the hard completion budget plus overhead", async () => {
    const harness = createAutomationHarness(rootSuccessScript());
    const input = await createAutomationInput({ maximumResponseBytes: 1_048_576 });
    const result = await harness.automation.run(input, harness.hooks);
    expect(result.kind).toBe("completed");
    const finalReads = harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "find");
    expect(finalReads).toHaveLength(2);
    expect(finalReads.every((call) => commandArgs(call.argv)[0] === "find")).toBe(true);
    for (const call of finalReads) {
      expect(call.maxBytes).toBe(1_064_960);
      expect(call.argv[call.argv.indexOf("--max-output") + 1]).toBe("1064960");
    }
  });
});

describe("AgentBrowserAutomation authentication probe", () => {
  test("initial open timeout does not report Project navigation", async () => {
    const harness = createAutomationHarness([
      () => new Promise<ScriptResult>(() => {}),
    ], {
      commandWaitStepMs: 1_000,
      onCommandWait: () => {},
    });

    const result = await harness.automation.waitForAuthenticatedProject({
      session: SESSION,
      projectUrl: PROJECT_URL,
      deadlineMs: 1_000,
    }, harness.hooks);

    expect(result).toBe("timed_out");
    expect(harness.hookCalls.navigation).toBe(0);
  });

  test("waits in one-second polls until the exact Project composer is authenticated", async () => {
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson("https://chatgpt.com/login") },
      { status: 0, output: snapshotJson({ e8: { role: "button", name: "Log in" } }) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
    ]);

    const result = await harness.automation.waitForAuthenticatedProject({
      session: SESSION,
      projectUrl: PROJECT_URL,
      deadlineMs: 5_000,
    }, harness.hooks);

    expect(result).toBe("authenticated");
    expect(harness.fake.calls.map((call) => commandArgs(call.argv))).toEqual([
      ["open", PROJECT_URL],
      ["get", "url"],
      ["snapshot", "-i"],
      ["get", "url"],
      ["snapshot", "-i"],
    ]);
    expect(harness.now()).toBe(1_000);
    expect(harness.hookCalls.navigation).toBe(1);
  });

  test("accepts an exact authenticated Project landing with one scoped new-chat control", async () => {
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({
        e9: { role: "link", name: "New chat in project" },
      }) },
    ]);

    const result = await harness.automation.waitForAuthenticatedProject({
      session: SESSION,
      projectUrl: PROJECT_URL,
      deadlineMs: 5_000,
    }, harness.hooks);

    expect(result).toBe("authenticated");
  });

  test("returns manual for CAPTCHA without attempting to automate it", async () => {
    const harness = createAutomationHarness([
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: snapshotJson({ e5: { role: "button", name: "Verify you are human" } }) },
    ]);

    const result = await harness.automation.waitForAuthenticatedProject({
      session: SESSION,
      projectUrl: PROJECT_URL,
      deadlineMs: 5_000,
    }, harness.hooks);

    expect(result).toBe("manual");
    expect(harness.hookCalls.navigation).toBe(1);
    expect(harness.fake.calls.map((call) => commandArgs(call.argv)[0])).not.toContain("click");
  });

  test("times out at its public deadline and heartbeats by ten seconds", async () => {
    const entries: ScriptResult[] = [{ status: 0, output: automationJson() }];
    for (let index = 0; index < 11; index++) {
      entries.push(
        { status: 0, output: urlJson("https://chatgpt.com/login") },
        { status: 0, output: snapshotJson({ e8: { role: "button", name: "Log in" } }) },
      );
    }
    const harness = createAutomationHarness(entries);

    const result = await harness.automation.waitForAuthenticatedProject({
      session: SESSION,
      projectUrl: PROJECT_URL,
      deadlineMs: 11_000,
    }, harness.hooks);

    expect(result).toBe("timed_out");
    expect(harness.hookCalls.navigation).toBe(1);
    expect(harness.now()).toBe(11_000);
    expect(harness.hookCalls.heartbeat).toBeGreaterThanOrEqual(1);
  });
});

class FakeCdpSocket implements MinimalSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  failMethod: string | undefined;
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: never) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data) as { id: number; method: string };
    queueMicrotask(() => {
      const reply = parsed.method === this.failMethod
        ? { id: parsed.id, error: { message: "boom" } }
        : { id: parsed.id, result: {} };
      this.emitMessage(JSON.stringify(reply));
    });
  }

  close(): void {
    this.closeCalls += 1;
  }

  emitOpen(): void {
    for (const listener of [...(this.listeners.get("open") ?? [])]) listener(undefined as never);
  }

  emitClose(): void {
    for (const listener of [...(this.listeners.get("close") ?? [])]) listener(undefined as never);
  }

  emitMessage(data: string): void {
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener({ data } as never);
  }
}

function cdpFrameMessage(payloadData: string): string {
  return JSON.stringify({
    method: "Network.webSocketFrameReceived",
    params: { requestId: "1", timestamp: 1, response: { opcode: 1, mask: false, payloadData } },
  });
}

function turnFrame(kind: "done" | "stream-item", conversationId: string): string {
  const topicId = `conversation-turn-${conversationId}`;
  return JSON.stringify({
    type: "message",
    topic_id: topicId,
    payload: {
      type: "conversation-turn-stream",
      metadata: null,
      payload: {
        type: kind === "done" ? "done" : "stream-item",
        conversation_id: conversationId,
        turn_id: conversationId,
      },
    },
  });
}

function createCdpFactory(
  options: { failMethod?: string } = {},
): { factory: CdpPageClientFactory; sockets: FakeCdpSocket[] } {
  const sockets: FakeCdpSocket[] = [];
  const factory: CdpPageClientFactory = ({ port, targetId }) => {
    const socket = new FakeCdpSocket();
    socket.failMethod = options.failMethod;
    sockets.push(socket);
    queueMicrotask(() => socket.emitOpen());
    return new CdpPageClient({ port, targetId, socketFactory: () => socket });
  };
  return { factory, sockets };
}

const EVENT_TARGET_ID = "E".repeat(32);
const CONVERSATION_ID = "abc-123";

function eventPreSubmissionScript(targetId = EVENT_TARGET_ID): ScriptEntry[] {
  return [
    { status: 0, output: automationJson({ targetId }) },
    { status: 0, output: urlJson(PROJECT_URL) },
    { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
    { status: 0, output: countJson(0) },
    { status: 0, output: urlJson(PROJECT_URL) },
    { status: 0, output: automationJson() },
    { status: 0, output: urlJson(PROJECT_URL) },
    { status: 0, output: automationJson() },
  ];
}

describe("AgentBrowserAutomation event-driven collection", () => {
  test("a rate limit that prevents navigation preserves uncertainty and pauses peers", async () => {
    let paused = false;
    const harness = createAutomationHarness([
      ...eventPreSubmissionScript(),
      ...Array.from({ length: 40 }, (): ScriptEntry => (call) => ({
        status: 0,
        output: commandArgs(call.argv)[0] === "snapshot"
          ? snapshotJson({ e8: { role: "dialog", name: "Too many requests" } }) : urlJson(PROJECT_URL),
      })),
    ], { deadlineMs: 60_000, rateLimitGate: { isBlocked: async () => paused, pause: async () => { paused = true; } } });
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result).toMatchObject({ reason: "rate_limited", certainty: "uncertain" });
    expect(paused).toBeTrue();
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([]);
    expect(harness.fake.calls.filter((call) => commandArgs(call.argv)[0] === "press")).toHaveLength(1);
  });

  test("a rate limit after Send stops event collection and pauses other clients", async () => {
    const { factory, sockets } = createCdpFactory();
    let paused = false;
    const gate = { isBlocked: async () => paused, pause: async () => { paused = true; } };
    const harness = createAutomationHarness([
      ...eventPreSubmissionScript(),
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson({ e8: { role: "dialog", name: "Too many requests" } }) },
    ], {
      cdpPageClientFactory: factory, rateLimitGate: gate,
      deadlineMs: 30_000, commandWaitStepMs: 10_000, onCommandWait: () => {},
    });
    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);
    expect(result).toMatchObject({ reason: "rate_limited", certainty: "submitted", collectionPath: "event" });
    expect(harness.hookCalls.before).toBe(1);
    expect(harness.hookCalls.confirmed).toEqual([CONVERSATION_URL]);
    expect(harness.now()).toBe(10_000);
    expect(paused).toBeTrue();
    expect(sockets[0]?.closeCalls).toBe(1);
    const peer = createAutomationHarness([], { rateLimitGate: gate });
    expect(await peer.automation.run(await createAutomationInput(), peer.hooks)).toMatchObject({ reason: "rate_limited" });
    expect(peer.fake.calls).toHaveLength(0);
  });

  test("buffers a done frame that arrives before the conversation id is known and still completes the turn", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("late id race answer");
    const script: ScriptEntry[] = [
      { status: 0, output: automationJson({ targetId: EVENT_TARGET_ID }) },
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(PROJECT_URL) };
      },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
  });

  test("completes over the event path when the submitted conversation url is nested under the configured project path", async () => {
    const nestedConversationUrl = `${PROJECT_URL}/c/${CONVERSATION_ID}`;
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("nested project conversation answer");
    const script: ScriptEntry[] = [
      { status: 0, output: automationJson({ targetId: EVENT_TARGET_ID }) },
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(PROJECT_URL) };
      },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(nestedConversationUrl) },
      { status: 0, output: urlJson(nestedConversationUrl) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: nestedConversationUrl,
      responseText: response,
      collectionPath: "event",
    });
  });

  test("ignores a done frame for a foreign conversation before completing on the matching one", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("matching conversation answer");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 40_000,
      commandWaitStepMs: 10_000,
      onCommandWait: (now) => {
        if (now === 10_000) {
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", "someone-elses-conversation")));
        }
        if (now >= 20_000) {
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        }
      },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
    expect(harness.now()).toBeGreaterThanOrEqual(20_000);
  });

  test("falls back to the polling collector when the connection is lost mid-wait and the safety net finds no envelope yet", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("fallback answer");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitClose();
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(1) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "polling",
    });
  });

  test("reports the existing timeout reason when the watcher's own deadline expires", async () => {
    const { factory } = createCdpFactory();
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      { status: 0, output: urlJson(CONVERSATION_URL) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory, deadlineMs: 150 });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "event",
    });
  });

  test("completes through the safety net when the turn watcher's deadline is reached but a valid envelope is already in the page", async () => {
    const { factory } = createCdpFactory();
    const response = ownEnvelope("answer that finished after the frame watcher gave up");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 20_000,
      commandWaitStepMs: 10_000,
      onCommandWait: () => {},
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event_recovered",
    });
  });

  test("does not complete through the safety net when the deadline read carries a different request's envelope", async () => {
    const { factory } = createCdpFactory();
    const foreign = browserCompletionEnvelope("b".repeat(32), "not our answer");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(foreign) },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 20_000,
      commandWaitStepMs: 10_000,
      onCommandWait: () => {},
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "event",
    });
    expect(JSON.stringify(result)).not.toContain("not our answer");
  });

  test("completes through the safety net when the connection is lost and a valid envelope is already in the page", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("already finished before the socket closed");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitClose();
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event_recovered",
    });
    expect(harness.fake.calls).toHaveLength(11);
  });

  test("keeps using the event path on a non-network un-throttle degradation and tolerates DOM lag", async () => {
    const { factory, sockets } = createCdpFactory({ failMethod: "Page.setWebLifecycleState" });
    const response = ownEnvelope("degraded but usable answer");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
  });

  test("retries through the settle window past DOM lag and succeeds once the envelope appears", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("settled after two retries");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("partial text, no envelope yet") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("still assembling, no envelope yet") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
    expect(harness.now()).toBe(2_000);
  });

  test("event collection delivers citation line breaks instead of rejecting the final answer", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("Reviewed\nExample Docs\n+2").replaceAll("\\n", "\n");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    expect(await harness.automation.run(await createAutomationInput(), harness.hooks)).toEqual({
      kind: "completed", conversationUrl: CONVERSATION_URL, responseText: response, collectionPath: "event",
    });
  });

  test("polling collection delivers citation line breaks after stable reads", async () => {
    const response = ownEnvelope("Reviewed\nExample Docs\n+2").replaceAll("\\n", "\n");
    const script = rootSuccessScript();
    script[15] = { status: 0, output: textJson(response) };
    script[17] = { status: 0, output: textJson(response) };
    const harness = createAutomationHarness(script);

    expect(await harness.automation.run(await createAutomationInput(), harness.hooks)).toEqual({
      kind: "completed", conversationUrl: CONVERSATION_URL, responseText: response,
    });
  });

  test("returns invalid_response once the settle window elapses without ever finding the envelope", async () => {
    const { factory, sockets } = createCdpFactory();
    const settleAttempts = 200;
    const settleEntries: ScriptEntry[] = Array.from({ length: settleAttempts }, () => [
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("Internal Server Error") },
    ]).flat();
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      ...settleEntries,
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "invalid_response",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "event",
      rejectedText: "Internal Server Error",
    });
    expect(harness.now()).toBe(180_000);
    expect(harness.fake.calls.length).toBeLessThan(9 + settleAttempts * 2);
  });

  test("retries a transient response-text read failure within the settle window and then completes", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("recovered after a transient read failure");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 1, output: "" },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
  });

  test("fails fast over the event path when the observed text carries the end sentinel but no valid envelope", async () => {
    const { factory, sockets } = createCdpFactory();
    const broken = `${BROWSER_RESULT_BEGIN}\n{"schemaVersion":1,"requestId":"${AUTOMATION_REQUEST_ID}"\n${BROWSER_RESULT_END}`;
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(broken) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "invalid_response",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "event",
      rejectedText: broken,
    });
    expect(harness.fake.calls).toHaveLength(11);
  });

  test("keeps the lease heartbeat flowing while blocked awaiting turn completion", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("heartbeat during watch");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 60_000,
      commandWaitStepMs: 10_000,
      onCommandWait: (now) => {
        if (now >= 20_000) {
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        }
      },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result.kind).toBe("completed");
    expect(harness.hookCalls.heartbeatAt.length).toBeGreaterThanOrEqual(2);
    expect(harness.hookCalls.heartbeatAt[0]).toBe(10_000);
    expect(harness.hookCalls.heartbeatAt[1]).toBe(20_000);
  });

  test("completes a conversation follow-up over the event path once its own new-turn frame arrives after submission", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("follow-up event answer");
    const script: ScriptEntry[] = [
      { status: 0, output: automationJson({ targetId: EVENT_TARGET_ID }) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(3) },
      { status: 0, output: countJson(3) },
      { status: 0, output: textJson("earlier answer") },
      { status: 0, output: countJson(3) },
      { status: 0, output: textJson("earlier answer") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
  });

  test("ignores a done frame buffered before submission from the conversation's own still-generating previous turn", async () => {
    const { factory, sockets } = createCdpFactory();
    const FRESH_AT = 250_000;
    let clock = 0;
    const finalAnswer = ownEnvelope("finally answered after the real turn completes");
    const placeholder = "still generating, no envelope yet";
    const trailingPolls: ScriptEntry[] = Array.from({ length: 200 }, () => [
      (): ScriptResult => ({ status: 0, output: urlJson(CONVERSATION_URL) }),
      (call: RunnerCall): ScriptResult => ({
        status: 0,
        output: commandArgs(call.argv)[0] === "snapshot" ? snapshotJson(COMPOSER_SNAPSHOT)
          : textJson(clock >= FRESH_AT ? finalAnswer : placeholder),
      }),
    ]).flat();
    const script: ScriptEntry[] = [
      { status: 0, output: automationJson({ targetId: EVENT_TARGET_ID }) },
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(3) },
      { status: 0, output: countJson(3) },
      { status: 0, output: textJson("earlier answer") },
      { status: 0, output: countJson(3) },
      { status: 0, output: textJson("earlier answer") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      ...trailingPolls,
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 400_000,
      commandWaitStepMs: 10_000,
      onCommandWait: (now) => {
        clock = now;
        if (now >= FRESH_AT) {
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        }
      },
    });
    const input = await createAutomationInput({
      targetUrl: CONVERSATION_URL,
      targetKind: "conversation",
    });

    const result = await harness.automation.run(input, harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: finalAnswer,
      collectionPath: "event",
    });
    expect(harness.now()).toBeGreaterThanOrEqual(FRESH_AT);
  });

  test("restores focus emulation before closing the CDP socket on a successful run", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("restore before close answer");
    let restoreSentBeforeClose = false;
    const script: ScriptEntry[] = [
      { status: 0, output: automationJson({ targetId: EVENT_TARGET_ID }) },
      () => {
        const originalClose = sockets[0]!.close.bind(sockets[0]!);
        sockets[0]!.close = () => {
          const methods = sockets[0]!.sent.map((raw) => (JSON.parse(raw) as { method: string }).method);
          restoreSentBeforeClose = methods
            .filter((method) => method === "Emulation.setFocusEmulationEnabled").length >= 2;
          originalClose();
        };
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(PROJECT_URL) };
      },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
    const methods = sockets[0]!.sent.map((raw) => (JSON.parse(raw) as { method: string }).method);
    expect(methods.filter((method) => method === "Emulation.setFocusEmulationEnabled").length).toBe(2);
    expect(restoreSentBeforeClose).toBe(true);
    expect(sockets[0]!.closeCalls).toBe(1);
  });

  test("keeps the run's real result even when restoring focus emulation fails", async () => {
    const { factory, sockets } = createCdpFactory({ failMethod: "Emulation.setFocusEmulationEnabled" });
    const response = ownEnvelope("degraded restore still completes");
    const script: ScriptEntry[] = [
      { status: 0, output: automationJson({ targetId: EVENT_TARGET_ID }) },
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(PROJECT_URL) };
      },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: countJson(0) },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(PROJECT_URL) },
      { status: 0, output: automationJson() },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
    expect(sockets[0]!.closeCalls).toBe(1);
  });

  test("an unauthenticated done hint triggers a validated read that completes the request when the envelope is present", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("recovered from an unauthenticated done hint");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, { cdpPageClientFactory: factory });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event_recovered",
    });
    expect(harness.fake.calls).toHaveLength(11);
  });

  test("an unauthenticated done hint whose read finds no envelope keeps waiting and still reaches the deadline outcome", async () => {
    const { factory, sockets } = createCdpFactory();
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("no envelope in the page yet") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("still no envelope at the deadline") },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 20_000,
      commandWaitStepMs: 10_000,
      onCommandWait: () => {},
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "event",
    });
    expect(harness.fake.calls).toHaveLength(15);
  });

  test("repeated unauthenticated done hints in quick succession trigger only one validated read", async () => {
    const { factory, sockets } = createCdpFactory();
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        for (let i = 0; i < 5; i += 1) {
          sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
        }
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("no envelope in the page yet") },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: snapshotJson(COMPOSER_SNAPSHOT) },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson("still no envelope at the deadline") },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 20_000,
      commandWaitStepMs: 10_000,
      onCommandWait: () => {},
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "recovery",
      phase: "needs_manual",
      reason: "timed_out",
      certainty: "submitted",
      conversationUrl: CONVERSATION_URL,
      collectionPath: "event",
    });
    expect(harness.fake.calls).toHaveLength(15);
  });

  test("a conversations-topic frame never triggers a hint read nor completes the request", async () => {
    const { factory, sockets } = createCdpFactory();
    const response = ownEnvelope("legitimate completion after global noise");
    const script: ScriptEntry[] = [
      ...eventPreSubmissionScript(),
      () => {
        sockets[0]!.emitMessage(cdpFrameMessage(JSON.stringify({
          type: "message",
          topic_id: "conversations",
          payload: {
            type: "conversation-turn-complete",
            metadata: null,
            payload: { conversation_id: CONVERSATION_ID },
          },
        })));
        return { status: 0, output: urlJson(CONVERSATION_URL) };
      },
      { status: 0, output: urlJson(CONVERSATION_URL) },
      { status: 0, output: textJson(response) },
    ];
    const harness = createAutomationHarness(script, {
      cdpPageClientFactory: factory,
      deadlineMs: 20_000,
      commandWaitStepMs: 10_000,
      onCommandWait: (now) => {
        if (now >= 20_000) return;
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("stream-item", CONVERSATION_ID)));
        sockets[0]!.emitMessage(cdpFrameMessage(turnFrame("done", CONVERSATION_ID)));
      },
    });

    const result = await harness.automation.run(await createAutomationInput(), harness.hooks);

    expect(result).toEqual({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: response,
      collectionPath: "event",
    });
    expect(harness.fake.calls).toHaveLength(11);
  });
});
