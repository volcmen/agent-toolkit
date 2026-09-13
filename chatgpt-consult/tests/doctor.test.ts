import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../src/browser/agent-browser";
import { main } from "../src/cli/main";
import {
  classifyProjectPageObservation,
  DOCTOR_PROBE_NAMES,
  isProjectScopedComposerName,
  isSupportedBunVersion,
  probeProjectPage,
  runDoctor,
  type DoctorProbe,
  type DoctorProbeName,
  type DoctorResult,
  type ProjectPageObservation,
  type ProjectPageWorkspace,
} from "../src/cli/doctor";

const outcome = (status: "pass" | "warn" | "fail" | "skip", message: string) =>
  async () => ({ status, message });

const probesWith = (
  overrides: Partial<Record<DoctorProbeName, DoctorProbe>> = {},
): Record<DoctorProbeName, DoctorProbe> => Object.fromEntries(
  DOCTOR_PROBE_NAMES.map((name) => [name, overrides[name] ?? outcome("pass", `${name} ready`)]),
) as Record<DoctorProbeName, DoctorProbe>;

const RUNS = 200;

const GENERIC_COMPOSER_NAMES = [
  "Message ChatGPT", "Ask ChatGPT", "Ask anything", "Chat with ChatGPT", "Prompt",
];

function randomToken(length = 1 + Math.floor(Math.random() * 8)): string {
  const pool = "abcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < length; i++) out += pool[Math.floor(Math.random() * pool.length)];
  return out;
}

interface ProbeRunnerCall {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

function createProbeRunner(
  results: ReadonlyArray<{ status: number; output: string } | (() => { status: number; output: string })>,
): { calls: ProbeRunnerCall[]; runner: CommandRunner } {
  const calls: ProbeRunnerCall[] = [];
  let index = 0;
  return {
    calls,
    runner: async (argv, options) => {
      calls.push({ argv, ...options });
      const entry = results[index++];
      if (!entry) return { status: 1, output: "" };
      return typeof entry === "function" ? entry() : entry;
    },
  };
}

const probeUrlJson = (url: string): { status: number; output: string } =>
  ({ status: 0, output: JSON.stringify({ success: true, data: { url } }) });
const probeSnapshotJson = (refs: Record<string, unknown>): { status: number; output: string } =>
  ({ status: 0, output: JSON.stringify({ success: true, data: { refs } }) });
const probeEmptyJson = (): { status: number; output: string } =>
  ({ status: 0, output: JSON.stringify({ success: true, data: {} }) });

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

function fakeWorkspace(dir = "/tmp/doctor-probe-workspace"): {
  workspace: ProjectPageWorkspace;
  factory: () => Promise<ProjectPageWorkspace>;
  cleanedDirs: string[];
  cleanup: (value: string) => Promise<void>;
} {
  const cleanedDirs: string[] = [];
  const workspace: ProjectPageWorkspace = {
    dir,
    policyPath: `${dir}/action-policy.json`,
    configPath: `${dir}/agent-browser.json`,
  };
  return {
    workspace,
    factory: async () => workspace,
    cleanedDirs,
    cleanup: async (value) => { cleanedDirs.push(value); },
  };
}

const CONFIGURED_URL = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-example/project";

function assertNonMutating(calls: readonly ProbeRunnerCall[]): void {
  for (const call of calls) {
    if (call.argv.includes("fill") || call.argv.includes("press") || call.argv.includes("click")) {
      throw new Error(`probe issued a mutating command: ${JSON.stringify(call.argv)}`);
    }
  }
  const opens = calls.filter((call) => call.argv.includes("open"));
  if (opens.length > 1) {
    throw new Error(`probe opened more than one tab: ${JSON.stringify(calls.map((call) => call.argv))}`);
  }
  expect(new Set(calls.map((call) => call.argv[call.argv.indexOf("--session") + 1])).size).toBe(1);
  const last = calls[calls.length - 1];
  if (last === undefined || !last.argv.includes("tab") || !last.argv.includes("close")) {
    throw new Error(`probe did not close its tab last: ${JSON.stringify(calls.map((call) => call.argv))}`);
  }
  expect(last.argv.slice(-3)).toEqual(["tab", "close", "D".repeat(32)]);
}

describe("runDoctor", () => {
  test("accepts supported Bun releases and rejects malformed or older versions", () => {
    expect(isSupportedBunVersion("1.4.0")).toBeTrue();
    expect(isSupportedBunVersion("1.12.3")).toBeTrue();
    expect(isSupportedBunVersion("2.0.0")).toBeTrue();
    expect(isSupportedBunVersion("1.3.99")).toBeFalse();
    expect(isSupportedBunVersion("1.4")).toBeFalse();
    expect(isSupportedBunVersion("latest")).toBeFalse();
  });

  test("returns browser-first probes before optional compatibility checks", async () => {
    expect(DOCTOR_PROBE_NAMES).toEqual([
      "bun",
      "project",
      "ignore_rule",
      "state_permissions",
      "stdio_mcp",
      "agent_browser",
      "chrome",
      "cdp",
      "chatgpt_project_url",
      "chatgpt_project_page",
      "browser_login",
      "http_mcp",
      "tunnel",
      "webview",
    ]);
    const statuses = [
      "pass", "warn", "fail", "skip", "pass", "warn", "fail",
      "skip", "pass", "warn", "fail", "skip", "pass", "warn",
    ] as const;
    const probes = probesWith(Object.fromEntries(
      DOCTOR_PROBE_NAMES.map((name, index) => [name, outcome(statuses[index]!, `state ${index}`)]),
    ));

    const result = await runDoctor({ probes });

    expect(result.kind).toBe("doctor");
    expect(result.checks.map((check) => check.name)).toEqual([...DOCTOR_PROBE_NAMES]);
    expect(result.checks.map((check) => check.status)).toEqual([...statuses]);
    expect(result.checks).toHaveLength(14);
  });

  test("marks the browser-backed path as required and an absent tunnel as skipped", async () => {
    const probes = probesWith();
    delete (probes as Partial<Record<DoctorProbeName, DoctorProbe>>).tunnel;

    const result = await runDoctor({
      cwd: "/definitely/not/a/project",
      probes,
    });

    for (const name of [
      "agent_browser", "chrome", "chatgpt_project_url", "browser_login",
    ] as const) {
      expect(result.checks.find((check) => check.name === name)?.required).toBeTrue();
    }
    expect(result.checks.find((check) => check.name === "tunnel")).toMatchObject({
      required: false,
      status: "skip",
    });
  });

  test("the live project-page probe is advisory and cannot flip overall success", async () => {
    const result = await runDoctor({
      probes: probesWith({ chatgpt_project_page: outcome("fail", "Rate-limited or misread") }),
    });

    expect(result.checks.find((check) => check.name === "chatgpt_project_page")).toMatchObject({
      required: false,
      status: "fail",
    });
    expect(result.success).toBeTrue();
  });

  test("required warnings and optional failures do not fail the command", async () => {
    const result = await runDoctor({
      probes: probesWith({
        tunnel: outcome("fail", "Legacy tunnel check failed"),
        browser_login: outcome("warn", "Login needs interactive verification"),
      }),
    });

    expect(result.success).toBeTrue();
    expect(result.checks.find((check) => check.name === "tunnel")?.required).toBeFalse();
    expect(result.checks.find((check) => check.name === "browser_login")?.required).toBeTrue();
  });

  test("a required failure makes the result unsuccessful", async () => {
    const result = await runDoctor({
      probes: probesWith({ project: outcome("fail", "Project unavailable") }),
    });

    expect(result.success).toBeFalse();
    expect(result.checks.find((check) => check.name === "project")).toMatchObject({
      status: "fail",
      required: true,
    });
  });

  test("contains thrown probes and redacts credentials, claims, queries, and absolute paths", async () => {
    const claim = "a".repeat(43);
    const probes = probesWith({
      bun: async () => { throw new Error("unexpected"); },
      tunnel: outcome(
        "warn",
        `Authorization: Bearer secret-token Cookie: session=private ${claim} https://example.test/mcp?token=hidden /Users/example/chrome-profile /tmp/private/attachment.png`,
      ),
    });

    const result = await runDoctor({ probes });
    const serialized = JSON.stringify(result);

    expect(result.checks.find((check) => check.name === "bun")).toMatchObject({
      status: "fail",
      message: "Probe could not complete safely.",
    });
    for (const secret of [
      "secret-token",
      "session=private",
      claim,
      "token=hidden",
      "/Users/example/chrome-profile",
      "/tmp/private/attachment.png",
    ]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("https://example.test/mcp");
  });
});

describe("doctor CLI", () => {
  const diagnostic: DoctorResult = {
    kind: "doctor",
    success: true,
    checks: DOCTOR_PROBE_NAMES.map((name) => ({
      name,
      status: name === "tunnel" ? "skip" : "pass",
      required: [
        "bun", "project", "ignore_rule", "state_permissions",
        "agent_browser", "chrome", "chatgpt_project_url", "browser_login",
      ].includes(name),
      message: name === "tunnel" ? "Legacy tunnel compatibility is not configured." : "Ready.",
    })),
  };

  test("dispatches before project resolution and emits a stable JSON envelope", async () => {
    const output: string[] = [];
    let calls = 0;
    const exitCode = await main(["doctor", "--json"], {
      cwd: "/definitely/not/a/project",
      doctor: async () => { calls += 1; return diagnostic; },
      write: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(output.join("\n"))).toEqual({ schemaVersion: 1, ok: true, data: diagnostic });
  });

  test("renders a compact human table with corrective commands", async () => {
    const output: string[] = [];
    const exitCode = await main(["doctor"], {
      doctor: async () => diagnostic,
      write: (message) => output.push(message),
    });
    const rendered = output.join("\n");

    expect(exitCode).toBe(0);
    expect(rendered).toContain("STATUS\tCHECK\tMESSAGE");
    expect(rendered).toContain("SKIP\ttunnel\tLegacy tunnel compatibility is not configured.");
  });

  test("returns exit one for required failures and rejects arguments", async () => {
    const failed = { ...diagnostic, success: false };
    expect(await main(["doctor", "--json"], { doctor: async () => failed, write: () => {} })).toBe(1);

    const errors: string[] = [];
    expect(await main(["doctor", "extra"], { writeError: (message) => errors.push(message) })).toBe(2);
    expect(errors.join("\n")).toContain("INVALID_INPUT");
  });
});

describe("isProjectScopedComposerName generative properties", () => {
  test("recognizes any nonempty suffix after the project-scope prefix, case and whitespace insensitively", () => {
    for (let i = 0; i < RUNS; i++) {
      const slug = randomToken();
      const padded = `  New Chat in ${slug}  `;
      if (!isProjectScopedComposerName(padded)) {
        throw new Error(`expected a project-scoped composer name for input=${JSON.stringify(padded)}`);
      }
    }
  });

  test("never recognizes a generic composer name or unrelated text as project-scoped", () => {
    for (let i = 0; i < RUNS; i++) {
      const generic = GENERIC_COMPOSER_NAMES[Math.floor(Math.random() * GENERIC_COMPOSER_NAMES.length)]!;
      const junk = `X${randomToken()}`;
      for (const candidate of [generic, junk]) {
        if (isProjectScopedComposerName(candidate)) {
          throw new Error(`unexpectedly recognized "${candidate}" as project-scoped`);
        }
      }
    }
  });
});

describe("classifyProjectPageObservation generative properties", () => {
  test("a matching project-scoped page passes, and perturbing any one signal away from it flips the result off pass", () => {
    for (let i = 0; i < RUNS; i++) {
      const slug = randomToken();
      const configuredUrl = `https://chatgpt.com/g/g-p-${randomToken(12)}-${slug}/project`;
      const composerName = `new chat in ${slug}`;
      const genericName = GENERIC_COMPOSER_NAMES[
        Math.floor(Math.random() * GENERIC_COMPOSER_NAMES.length)
      ]!.toLowerCase();
      const baseline: ProjectPageObservation = {
        urlKind: "page",
        url: configuredUrl,
        composerNames: [composerName],
        signInControlPresent: false,
        rateLimited: false,
      };

      const passing = classifyProjectPageObservation(configuredUrl, baseline);
      if (passing.status !== "pass") {
        throw new Error(`expected pass for baseline=${JSON.stringify(baseline)} got status=${passing.status}`);
      }

      const signedOut = classifyProjectPageObservation(configuredUrl, {
        ...baseline,
        signInControlPresent: true,
      });
      if (signedOut.status !== "warn") {
        throw new Error(
          `expected warn once signed out for baseline=${JSON.stringify(baseline)} got status=${signedOut.status}`,
        );
      }

      const redirected = classifyProjectPageObservation(configuredUrl, {
        urlKind: "root",
        composerNames: baseline.composerNames,
        signInControlPresent: false,
        rateLimited: false,
      });
      if (redirected.status !== "fail") {
        throw new Error(
          `expected fail once redirected to root for baseline=${JSON.stringify(baseline)} got status=${redirected.status}`,
        );
      }

      const genericOnly = classifyProjectPageObservation(configuredUrl, {
        ...baseline,
        composerNames: [genericName],
      });
      if (genericOnly.status !== "fail") {
        throw new Error(
          `expected fail with only a generic composer for baseline=${JSON.stringify(baseline)} `
            + `got status=${genericOnly.status}`,
        );
      }

      const noComposerAtAll = classifyProjectPageObservation(configuredUrl, {
        ...baseline,
        composerNames: [],
      });
      if (noComposerAtAll.status !== "warn") {
        throw new Error(
          `expected warn with no composer at all for baseline=${JSON.stringify(baseline)} `
            + `got status=${noComposerAtAll.status}`,
        );
      }

      const wrongUrl = classifyProjectPageObservation(configuredUrl, {
        ...baseline,
        url: `${configuredUrl}-decoy`,
      });
      if (wrongUrl.status !== "fail") {
        throw new Error(
          `expected fail with a mismatched resolved URL for baseline=${JSON.stringify(baseline)} `
            + `got status=${wrongUrl.status}`,
        );
      }

      const stillRateLimited = classifyProjectPageObservation(configuredUrl, {
        ...baseline,
        rateLimited: true,
      });
      if (stillRateLimited.status !== "pass") {
        throw new Error(
          `expected pass despite a rate-limit banner when a project composer is present, `
            + `baseline=${JSON.stringify(baseline)} got status=${stillRateLimited.status}`,
        );
      }

      const rateLimitedNoComposer = classifyProjectPageObservation(configuredUrl, {
        ...baseline,
        composerNames: [],
        rateLimited: true,
      });
      if (rateLimitedNoComposer.status !== "warn") {
        throw new Error(
          `expected warn for a rate-limit banner with no composer, baseline=${JSON.stringify(baseline)} `
            + `got status=${rateLimitedNoComposer.status}`,
        );
      }
    }
  });

  test("a login redirect always warns regardless of composer signals", () => {
    for (let i = 0; i < RUNS; i++) {
      const configuredUrl = `https://chatgpt.com/g/g-p-${randomToken(12)}-${randomToken()}/project`;
      const observation: ProjectPageObservation = {
        urlKind: "login",
        composerNames: Math.random() < 0.5 ? [] : ["new chat in x"],
        signInControlPresent: Math.random() < 0.5,
        rateLimited: Math.random() < 0.5,
      };
      const result = classifyProjectPageObservation(configuredUrl, observation);
      if (result.status !== "warn") {
        throw new Error(
          `expected warn on a login redirect for observation=${JSON.stringify(observation)} `
            + `got status=${result.status}`,
        );
      }
    }
  });
});

describe("probeProjectPage", () => {
  test("skips without ever touching the browser when no project URL is configured", async () => {
    let attachCalls = 0;
    const result = await probeProjectPage(
      { browserCdpPort: 9222 },
      {
        attach: async (port) => { attachCalls += 1; return { port }; },
        resolveExecutable: () => "/usr/bin/agent-browser",
        commandRunner: createProbeRunner([]).runner,
        workspaceFactory: fakeWorkspace().factory,
      },
    );
    expect(result.status).toBe("skip");
    expect(attachCalls).toBe(0);
  });

  test("skips without ever touching the browser when no CDP port is configured", async () => {
    let attachCalls = 0;
    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL },
      {
        attach: async (port) => { attachCalls += 1; return { port }; },
        resolveExecutable: () => "/usr/bin/agent-browser",
        commandRunner: createProbeRunner([]).runner,
        workspaceFactory: fakeWorkspace().factory,
      },
    );
    expect(result.status).toBe("skip");
    expect(attachCalls).toBe(0);
  });

  test("skips when agent-browser is unavailable", async () => {
    let attachCalls = 0;
    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => null,
        attach: async (port) => { attachCalls += 1; return { port }; },
        commandRunner: createProbeRunner([]).runner,
        workspaceFactory: fakeWorkspace().factory,
      },
    );
    expect(result.status).toBe("skip");
    expect(attachCalls).toBe(0);
  });

  test("skips when Chrome is unreachable on the configured CDP port", async () => {
    const fake = createProbeRunner([]);
    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async () => { throw new Error("connection refused"); },
        commandRunner: fake.runner,
        workspaceFactory: fakeWorkspace().factory,
      },
    );
    expect(result.status).toBe("skip");
    expect(fake.calls).toHaveLength(0);
  });

  test("passes and closes its tab when the resolved page has a project-scoped composer", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      probeSnapshotJson({ e1: { role: "textbox", name: "New chat in Work" } }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();
    const clock = fakeClock();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    expect(result.status).toBe("pass");
    assertNonMutating(fake.calls);
    expect(ws.cleanedDirs).toEqual([ws.workspace.dir]);
  });

  test("fails and still closes its tab when the URL silently redirects to the ChatGPT home page", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson("https://chatgpt.com/"),
      probeSnapshotJson({ e1: { role: "textbox", name: "Message ChatGPT" } }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
        now: fakeClock().now,
        sleep: fakeClock().sleep,
      },
    );

    expect(result.status).toBe("fail");
    expect(result.message).toContain("did not resolve to a project-scoped page");
    assertNonMutating(fake.calls);
    expect(ws.cleanedDirs).toEqual([ws.workspace.dir]);
  });

  test("fails when the resolved URL matches but only a generic composer is present", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      probeSnapshotJson({ e1: { role: "textbox", name: "Message ChatGPT" } }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      },
    );

    expect(result.status).toBe("fail");
    assertNonMutating(fake.calls);
  });

  test("warns rather than failing when the resolved URL matches but no composer can be found at all", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      ...Array.from({ length: 8 }, () => probeSnapshotJson({ e1: { role: "heading", name: "Chat history" } })),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();
    const clock = fakeClock();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
        now: clock.now,
        sleep: clock.sleep,
        deadlineMs: 20_000,
      },
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("no composer could be");
    assertNonMutating(fake.calls);
  });

  test("passes with a note when a rate-limit banner is present alongside a project composer", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      probeSnapshotJson({
        e1: { role: "textbox", name: "New chat in Work" },
        e2: { role: "heading", name: "Too many requests" },
        e3: { role: "button", name: "Got it" },
      }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      },
    );

    expect(result.status).toBe("pass");
    expect(result.message).toContain("rate-limit banner was also present");
    assertNonMutating(fake.calls);
  });

  test("warns rather than failing when a rate-limit banner is present with no composer", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      probeSnapshotJson({
        e1: { role: "heading", name: "Too Many Requests" },
        e2: { role: "button", name: "Got it" },
      }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      },
    );

    expect(result.status).toBe("warn");
    expect(result.message).toContain("rate-limiting");
    assertNonMutating(fake.calls);
    expect(fake.calls.filter((call) => call.argv.includes("snapshot"))).toHaveLength(1);
  });

  test("warns when ChatGPT requires signing in before the page can be verified", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson("https://chatgpt.com/auth/login"),
      probeSnapshotJson({ e1: { role: "button", name: "Log in" } }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      },
    );

    expect(result.status).toBe("warn");
    assertNonMutating(fake.calls);
  });

  test("warns when the project page itself shows a sign-in control", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      probeSnapshotJson({ e1: { role: "button", name: "Log in" } }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      },
    );

    expect(result.status).toBe("warn");
  });

  test("warns rather than hanging when opening the page exceeds its budget without guessing which tab to close", async () => {
    const fake = createProbeRunner([
      { status: 1, output: "" },
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
      },
    );

    expect(result.status).toBe("warn");
    expect(fake.calls.some((call) => call.argv.includes("tab") && call.argv.includes("close"))).toBeFalse();
    expect(ws.cleanedDirs).toEqual([ws.workspace.dir]);
  });

  test("retries the snapshot within its budget until the project composer appears", async () => {
    const fake = createProbeRunner([
      { status: 0, output: JSON.stringify({ success: true, data: { targetId: "D".repeat(32) } }) },
      probeUrlJson(CONFIGURED_URL),
      probeSnapshotJson({}),
      probeSnapshotJson({ e1: { role: "textbox", name: "New chat in Work" } }),
      probeEmptyJson(),
    ]);
    const ws = fakeWorkspace();
    const clock = fakeClock();

    const result = await probeProjectPage(
      { chatgptProjectUrl: CONFIGURED_URL, browserCdpPort: 9222 },
      {
        resolveExecutable: () => "/usr/bin/agent-browser",
        attach: async (port) => ({ port }),
        commandRunner: fake.runner,
        workspaceFactory: ws.factory,
        workspaceCleanup: ws.cleanup,
        now: clock.now,
        sleep: clock.sleep,
        deadlineMs: 5_000,
      },
    );

    expect(result.status).toBe("pass");
    const snapshotCalls = fake.calls.filter((call) => call.argv.includes("snapshot"));
    expect(snapshotCalls).toHaveLength(2);
  });
});
