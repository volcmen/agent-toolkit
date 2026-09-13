import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBrowserAutomation,
  type CommandRunner,
  type OwnedTabCleanupInput,
} from "../src/browser/agent-browser";
import type { BrowserAutomationHooks, BrowserAutomationInput } from "../src/browser/handoff";
import { BROWSER_RESULT_BEGIN, BROWSER_RESULT_END } from "../src/browser/protocol";
import { probeProjectPage } from "../src/cli/doctor";

const projectUrl = "https://chatgpt.com/g/g-p-concurrency/project";
const paths: string[] = [];
const hooks: BrowserAutomationHooks = {
  beforeSubmission: async () => {},
  submissionConfirmed: async () => {},
  heartbeat: async () => {},
  isCancelled: async () => false,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const ok = (data: Record<string, unknown> = {}) => ({
  status: 0,
  output: JSON.stringify({ success: true, data }),
});
const envelope = (requestId: string) => [
  BROWSER_RESULT_BEGIN,
  JSON.stringify({
    schemaVersion: 1, requestId, expectedRevision: 0,
    completion: {
      summary: "Isolated answer", answer: requestId, evidence: [], assumptions: [],
      risks: [], recommendations: [], followUpQuestions: [],
    },
  }),
  BROWSER_RESULT_END,
].join("\n");

async function input(requestId: string): Promise<BrowserAutomationInput> {
  const dir = await mkdtemp(join(tmpdir(), "consult-concurrency-"));
  paths.push(dir);
  return {
    session: {
      pid: 0, port: 9222, webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/test",
      profileDir: null, ownership: "external", visibility: "external", reused: true,
    },
    mode: "submit_and_collect", targetUrl: projectUrl, targetKind: "configured",
    requestId, prompt: requestId, uploadPaths: [], stagingDirectory: await realpath(dir),
    maximumResponseBytes: 4096,
  };
}

function sharedBrowser(expectedOpens: number) {
  const opened = deferred();
  const firstClosed = deferred();
  const sessions = new Map<string, { targetId: string; url: string; prompt: string; answer: string }>();
  const liveTargets = new Set(["user-tab"]);
  const cleaned: OwnedTabCleanupInput[] = [];
  const commands: Array<{ session: string; args: readonly string[] }> = [];
  let opens = 0;
  let nextTarget = 0;
  const runner: CommandRunner = async (argv) => {
    const session = argv[argv.indexOf("--session") + 1]!;
    const args = argv.slice(argv.indexOf("--json") + 1);
    commands.push({ session, args });
    if (args[0] === "open") {
      let tab = sessions.get(session);
      if (!tab) {
        tab = { targetId: (++nextTarget).toString(16).padStart(32, "0"), url: "", prompt: "", answer: "" };
        sessions.set(session, tab);
        liveTargets.add(tab.targetId);
      }
      tab.url = args[1]!;
      if (++opens === expectedOpens) opened.resolve();
      await opened.promise;
      return ok({ targetId: tab.targetId });
    }
    const tab = sessions.get(session);
    if (!tab || !liveTargets.has(tab.targetId)) return { status: 1, output: "tab_gone" };
    if (args[0] === "snapshot") return ok({ refs: { e1: { role: "textbox", name: "New chat in Test" } } });
    if (args[0] === "fill") { tab.prompt = args[2]!; return ok(); }
    if (args[0] === "press") {
      tab.url = `https://chatgpt.com/c/${tab.prompt}`;
      tab.answer = envelope(tab.prompt);
      return ok();
    }
    if (args[0] === "get" && args[1] === "url") return ok({ url: tab.url });
    if (args[0] === "get" && args[1] === "count") {
      if (tab.answer && tab.prompt === "b".repeat(32)) await firstClosed.promise;
      return ok({ count: tab.answer ? 1 : 0 });
    }
    if (args[0] === "find") return ok({ text: tab.answer });
    if (args[0] === "tab" && args[1] === "close") {
      if (args[2] !== tab.targetId) return { status: 1, output: "wrong_target" };
      liveTargets.delete(tab.targetId);
      firstClosed.resolve();
      return ok();
    }
    throw new Error(`Unexpected fixture command: ${args[0]}`);
  };
  const cleanup = async (value: OwnedTabCleanupInput) => {
    cleaned.push(value);
    expect(sessions.get(value.sessionId)?.targetId).toBe(value.targetId);
    liveTargets.delete(value.targetId);
    firstClosed.resolve();
  };
  return { runner, cleanup, sessions, liveTargets, cleaned, commands };
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("interleaved consultations retain their own prompts, answers, refs and cleanup", async () => {
  const browser = sharedBrowser(2);
  const automation = new AgentBrowserAutomation({
    executablePath: "/fixture/agent-browser", commandRunner: browser.runner,
    ownedTabCleanup: browser.cleanup, deadlineMs: 3000, sleep: async () => {},
  });
  const inputs = await Promise.all([input("a".repeat(32)), input("b".repeat(32))]);
  const results = await Promise.all(inputs.map((value) => automation.run(value, hooks)));
  for (const [index, result] of results.entries()) {
    expect(result).toMatchObject({
      kind: "completed", responseText: envelope(inputs[index]!.requestId),
      conversationUrl: `https://chatgpt.com/c/${inputs[index]!.requestId}`,
    });
  }
  expect(browser.sessions.size).toBe(2);
  expect(new Set(browser.cleaned.map((value) => value.targetId)).size).toBe(2);
  expect(browser.liveTargets).toEqual(new Set(["user-tab"]));
});

test("a cancelled consultation cannot close a simultaneous chat", async () => {
  const browser = sharedBrowser(2);
  const automation = new AgentBrowserAutomation({
    executablePath: "/fixture/agent-browser", commandRunner: browser.runner,
    ownedTabCleanup: browser.cleanup, sleep: async () => {},
  });
  const [cancelled, continuing] = await Promise.all([input("a".repeat(32)), input("b".repeat(32))]);
  const results = await Promise.all([
    automation.run(cancelled!, {
      ...hooks, isCancelled: async () => browser.commands.filter((value) => value.args[0] === "open").length === 2,
    }),
    automation.run(continuing!, hooks),
  ]);
  expect(results[0]).toMatchObject({ kind: "recovery", certainty: "not_submitted" });
  expect(results[1]).toMatchObject({ kind: "completed", responseText: envelope(continuing!.requestId) });
  expect(browser.liveTargets).toEqual(new Set(["user-tab"]));
});

test("simultaneous doctor probes each clean only their own target", async () => {
  const browser = sharedBrowser(2);
  const deps = { resolveExecutable: () => "/fixture/agent-browser", commandRunner: browser.runner, attach: async () => ({ port: 9222 }) };
  const config = { chatgptProjectUrl: projectUrl, browserCdpPort: 9222 };
  const results = await Promise.all([probeProjectPage(config, deps), probeProjectPage(config, deps)]);
  expect(results.map((value) => value.status)).toEqual(["pass", "pass"]);
  expect(browser.sessions.size).toBe(2);
  expect(browser.liveTargets).toEqual(new Set(["user-tab"]));
});

test("authentication probes and consultations do not navigate the same tab", async () => {
  const browser = sharedBrowser(2);
  const automation = new AgentBrowserAutomation({
    executablePath: "/fixture/agent-browser", commandRunner: browser.runner,
    ownedTabCleanup: browser.cleanup, sleep: async () => {},
  });
  const value = await input("a".repeat(32));
  const results = await Promise.all([
    automation.run(value, hooks),
    automation.waitForAuthenticatedProject({ session: value.session, projectUrl, deadlineMs: 3000 }, hooks),
  ]);
  expect(results[0]).toMatchObject({ kind: "completed" });
  expect(results[1]).toBe("authenticated");
  expect(browser.sessions.size).toBe(2);
  expect(browser.liveTargets.size).toBe(2);
  expect(browser.liveTargets.has("user-tab")).toBeTrue();
});
