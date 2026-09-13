import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthenticationProbeInput,
  BrowserAutomationHooks,
  BrowserAutomationInput,
  BrowserAutomationResult,
} from "../src/browser/handoff";
import type { BrowserRequestPackage } from "../src/browser/package";
import { BrowserJob, type BrowserJobOptions } from "../src/browser/worker";
import type { ChromeSession } from "../src/browser/chrome";
import { DEFAULT_BUDGET, type ConsultationCompletion } from "../src/core/schema";
import { RequestStore, type CreateRequestInput } from "../src/core/store";
import { resolveProject, type ResolvedProject } from "../src/security/project";

const PROJECT_URL = "https://chatgpt.com/g/projects/browser-worker";
const CONVERSATION_URL = "https://chatgpt.com/g/browser-worker/c/proven-conversation";
const OWNER_A = "a".repeat(32);
const OWNER_B = "b".repeat(32);
const temporaryPaths: string[] = [];

const completion: ConsultationCompletion = {
  summary: "Browser review",
  answer: "Use the proven browser result.",
  evidence: [],
  assumptions: [],
  risks: [],
  recommendations: [],
  followUpQuestions: [],
};

const responseEnvelope = (
  requestId: string,
  expectedRevision: number,
  value: ConsultationCompletion = completion,
): string => [
  "BEGIN_CHATGPT_CONSULT_RESULT",
  JSON.stringify({ schemaVersion: 1, requestId, expectedRevision, completion: value }),
  "END_CHATGPT_CONSULT_RESULT",
].join("\n");

const validCreateInput = (
  key: string,
  overrides: Partial<CreateRequestInput> = {},
): CreateRequestInput => ({
  projectName: "Browser worker fixture",
  goal: "Review the browser worker",
  profile: "analysis",
  parentId: null,
  conversationUrl: null,
  idempotencyKey: key,
  budget: DEFAULT_BUDGET,
  contextManifest: { selectors: [], paths: [], smartSelection: false, exclusions: [] },
  diff: null,
  attachments: [],
  sensitivity: [],
  connectorAllowlist: [],
  ...overrides,
});

const ownedSession = (visibility: "headless" | "headed" = "headless"): ChromeSession => ({
  pid: 321,
  port: 43210,
  webSocketUrl: "ws://127.0.0.1:43210/devtools/browser/worker",
  profileDir: "/private/browser-profile",
  ownership: "owned",
  visibility,
  reused: true,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const waitForAbort = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  signal.addEventListener("abort", () => resolve(), { once: true });
});

class FakeSessions {
  ensureCalls: string[] = [];
  switchCalls = 0;
  ensureError: Error | undefined;
  switchError: Error | undefined;
  ensureImpl: ((visibility: "headless" | "headed") => Promise<ChromeSession>) | undefined;
  switchImpl: (() => Promise<ChromeSession>) | undefined;

  async ensureRunning(visibility: "headless" | "headed" = "headless"): Promise<ChromeSession> {
    this.ensureCalls.push(visibility);
    if (this.ensureError) throw this.ensureError;
    if (this.ensureImpl) return this.ensureImpl(visibility);
    return ownedSession(visibility);
  }

  async switchOwnedToHeaded(): Promise<ChromeSession> {
    this.switchCalls++;
    if (this.switchError) throw this.switchError;
    if (this.switchImpl) return this.switchImpl();
    return ownedSession("headed");
  }
}

class FakeAutomation {
  calls: BrowserAutomationInput[] = [];
  probeCalls: AuthenticationProbeInput[] = [];
  runImpl: (
    input: BrowserAutomationInput,
    hooks: BrowserAutomationHooks,
  ) => Promise<BrowserAutomationResult>;
  probeImpl: (
    input: AuthenticationProbeInput,
    hooks: BrowserAutomationHooks,
  ) => Promise<"authenticated" | "timed_out" | "manual"> = async () => "authenticated";

  constructor(runImpl?: FakeAutomation["runImpl"]) {
    this.runImpl = runImpl ?? (async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, 0),
      };
    });
  }

  async run(
    input: BrowserAutomationInput,
    hooks: BrowserAutomationHooks,
  ): Promise<BrowserAutomationResult> {
    this.calls.push(input);
    return this.runImpl(input, hooks);
  }

  async waitForAuthenticatedProject(
    input: AuthenticationProbeInput,
    hooks: BrowserAutomationHooks,
  ): Promise<"authenticated" | "timed_out" | "manual"> {
    this.probeCalls.push(input);
    return this.probeImpl(input, hooks);
  }
}

interface Harness {
  project: ResolvedProject;
  store: RequestStore;
  requestId: string;
  revision: number;
  claimToken: string;
  automation: FakeAutomation;
  sessions: FakeSessions;
  packages: BrowserRequestPackage[];
  cleaned: BrowserRequestPackage[];
  job: BrowserJob;
}

const makeHarness = async (options: {
  now?: () => Date;
  automation?: FakeAutomation;
  input?: Partial<CreateRequestInput>;
  prepareError?: Error;
  cleanupError?: Error;
  sessions?: FakeSessions;
  preparePackageImpl?: (
    value: BrowserRequestPackage,
  ) => Promise<BrowserRequestPackage>;
  leaseWait?: NonNullable<BrowserJobOptions["leaseWait"]>;
  drainWait?: NonNullable<BrowserJobOptions["drainWait"]>;
  cleanupPackageImpl?: (value: BrowserRequestPackage) => Promise<void>;
} = {}): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-browser-worker-"));
  temporaryPaths.push(root);
  const project = await resolveProject(root);
  let randomCall = 0;
  const store = await RequestStore.init(project, {
    ...(options.now === undefined ? {} : { now: options.now }),
    randomBytes: (size) => Buffer.alloc(size, 17 + randomCall++),
  });
  const created = await store.create(validCreateInput("browser-worker", options.input));
  const automation = options.automation ?? new FakeAutomation();
  const sessions = options.sessions ?? new FakeSessions();
  const packages: BrowserRequestPackage[] = [];
  const cleaned: BrowserRequestPackage[] = [];
  const job = new BrowserJob({
    project,
    store,
    projectUrl: PROJECT_URL,
    automation,
    sessionManager: sessions,
    preparePackage: async (_project, _store, request) => {
      if (options.prepareError) throw options.prepareError;
      const value: BrowserRequestPackage = Object.freeze({
        requestId: request.id,
        expectedRevision: request.revision,
        prompt: `private prompt for ${request.id}`,
        uploadPaths: Object.freeze(["/private/staging/001-review.pdf"]),
        directory: "/private/staging",
      });
      const prepared = options.preparePackageImpl
        ? await options.preparePackageImpl(value)
        : value;
      packages.push(prepared);
      return prepared;
    },
    cleanupPackage: async (value) => {
      cleaned.push(value);
      await options.cleanupPackageImpl?.(value);
      if (options.cleanupError) throw options.cleanupError;
    },
    ...(options.leaseWait === undefined ? {} : { leaseWait: options.leaseWait }),
    ...(options.drainWait === undefined ? {} : { drainWait: options.drainWait }),
  });
  return {
    project,
    store,
    requestId: created.request.id,
    revision: created.request.revision,
    claimToken: created.claimToken,
    automation,
    sessions,
    packages,
    cleaned,
    job,
  };
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("browser job coordinator", () => {
  test("keeps a rate-limit reason without clearing an uncertain submission or resending", async () => {
    const automation = new FakeAutomation(async (_input, hooks) => {
      await hooks.beforeSubmission();
      return { kind: "recovery", phase: "needs_manual", reason: "rate_limited", certainty: "uncertain" };
    });
    const harness = await makeHarness({ automation });
    await harness.store.queueBrowserExecution(harness.requestId);
    expect(await harness.job.run(harness.requestId, OWNER_A)).toMatchObject({ kind: "recovery", reason: "rate_limited" });
    const saved = await harness.store.get(harness.requestId);
    expect(saved.browserExecution).toMatchObject({
      phase: "needs_manual", reason: "rate_limited", submission: { certainty: "uncertain" }, lease: null,
    });
    await harness.job.run(harness.requestId, OWNER_B);
    expect(automation.calls).toHaveLength(1);
  });

  test("leases, submits once, validates, imports, and releases exact package provenance", async () => {
    let harness!: Harness;
    const observedStates: unknown[] = [];
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      observedStates.push((await harness.store.get(input.requestId)).browserExecution);
      await hooks.submissionConfirmed(CONVERSATION_URL);
      observedStates.push((await harness.store.get(input.requestId)).browserExecution);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
      };
    });
    harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({ kind: "completed", requestId: harness.requestId });
    expect(automation.calls).toHaveLength(1);
    expect(automation.calls[0]).toMatchObject({
      mode: "submit_and_collect",
      requestId: harness.packages[0]!.requestId,
      prompt: harness.packages[0]!.prompt,
      uploadPaths: harness.packages[0]!.uploadPaths,
      stagingDirectory: harness.packages[0]!.directory,
      targetUrl: PROJECT_URL,
      targetKind: "configured",
      maximumResponseBytes: DEFAULT_BUDGET.maxCompletionBytes,
    });
    expect(automation.calls[0]!.uploadPaths).toBe(harness.packages[0]!.uploadPaths);
    expect(observedStates).toMatchObject([
      { phase: "needs_manual", reason: "submission_uncertain", submission: { certainty: "uncertain" } },
      { phase: "awaiting_response", reason: null, submission: { certainty: "submitted" } },
    ]);
    expect((await harness.store.getCompletion(harness.requestId))?.source).toBe("browser");
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease).toBeNull();
    expect(harness.cleaned).toHaveLength(1);
    expect(harness.cleaned[0]).toBe(harness.packages[0]);
  });

  test("records which collection path served a completed browser-driven request", async () => {
    let harness!: Harness;
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
        collectionPath: "event",
      };
    });
    harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({ kind: "completed", requestId: harness.requestId });
    const events = (await readFile(
      join(harness.project.stateDir, "events", `${harness.requestId}.jsonl`),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    const completedEvent = events.find((line) => line.event === "completed");
    expect(completedEvent?.metadata).toMatchObject({ collectionPath: "event" });
  });

  test("records the polling fallback path served a completed browser-driven request", async () => {
    let harness!: Harness;
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
        collectionPath: "polling",
      };
    });
    harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({ kind: "completed", requestId: harness.requestId });
    const events = (await readFile(
      join(harness.project.stateDir, "events", `${harness.requestId}.jsonl`),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    const completedEvent = events.find((line) => line.event === "completed");
    expect(completedEvent?.metadata).toMatchObject({ collectionPath: "polling" });
  });

  test("follow-up collects from the proven parent conversation", async () => {
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(input.targetUrl);
      return {
        kind: "completed",
        conversationUrl: input.targetUrl,
        responseText: responseEnvelope(input.requestId, 0),
      };
    });
    const harness = await makeHarness({ automation });
    const parent = await harness.store.create(validCreateInput("parent", {
      conversationUrl: "https://chatgpt.com/g/browser-worker/c/proven-parent",
    }));
    const child = await harness.store.create(validCreateInput("child", {
      parentId: parent.request.id,
      conversationUrl: null,
    }));

    await harness.job.run(child.request.id, OWNER_B);

    expect(harness.automation.calls[0]?.targetUrl).toBe("https://chatgpt.com/g/browser-worker/c/proven-parent");
    expect(harness.automation.calls[0]?.targetKind).toBe("conversation");
  });

  test("a fresh follow-up uses its saved Project and resumes only its own new conversation", async () => {
    const harness = await makeHarness();
    const parent = await harness.store.create(validCreateInput("fresh-parent", {
      conversationUrl: "https://chatgpt.com/g/browser-worker/c/parent",
    }));
    const child = await harness.store.create(validCreateInput("fresh-child", {
      parentId: parent.request.id, conversationUrl: null,
      thread: { projectUrl: PROJECT_URL, mode: "new", requestedMode: "new", reason: "requested", turn: 1 },
    }));
    harness.automation.runImpl = async (_input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return { kind: "recovery", phase: "needs_manual", reason: "timed_out", certainty: "submitted", conversationUrl: CONVERSATION_URL };
    };
    await harness.job.run(child.request.id, OWNER_A);
    expect(harness.automation.calls[0]).toMatchObject({ targetUrl: PROJECT_URL, targetKind: "configured", projectUrl: PROJECT_URL });
    harness.automation.runImpl = async (input) => ({
      kind: "completed", conversationUrl: CONVERSATION_URL, responseText: responseEnvelope(input.requestId, 0),
    });
    const result = await harness.job.run(child.request.id, OWNER_B);
    expect(result.kind).toBe("completed");
    expect(harness.automation.calls[1]).toMatchObject({ mode: "collect_only", targetUrl: CONVERSATION_URL });
    expect((await harness.store.get(parent.request.id)).conversationUrl).toBe("https://chatgpt.com/g/browser-worker/c/parent");
  });

  test("follow-up confirmation cannot escape the proven parent conversation", async () => {
    const harness = await makeHarness();
    const parent = await harness.store.create(validCreateInput("bound-parent", {
      conversationUrl: "https://chatgpt.com/g/browser-worker/c/proven-parent",
    }));
    const child = await harness.store.create(validCreateInput("bound-child", {
      parentId: parent.request.id,
      conversationUrl: null,
    }));

    const result = await harness.job.run(child.request.id, OWNER_B);

    expect(result).toEqual({
      kind: "recovery",
      requestId: child.request.id,
      phase: "needs_manual",
      reason: "submission_uncertain",
    });
    expect(await harness.store.getCompletion(child.request.id)).toBeNull();
    expect((await harness.store.get(child.request.id)).conversationUrl).toBeNull();
  });

  test("a follow-up without a proven parent URL enters manual recovery without automation", async () => {
    const harness = await makeHarness();
    const parent = await harness.store.create(validCreateInput("parent-without-url"));
    const child = await harness.store.create(validCreateInput("child-without-url", {
      parentId: parent.request.id,
    }));

    const result = await harness.job.run(child.request.id, OWNER_B);

    expect(result).toEqual({
      kind: "recovery",
      requestId: child.request.id,
      phase: "needs_manual",
      reason: "ui_changed",
    });
    expect(harness.automation.calls).toHaveLength(0);
    expect((await harness.store.get(child.request.id)).browserExecution).toMatchObject({
      phase: "needs_manual",
      lease: null,
    });
  });

  test("known submitted state requires its canonical URL and resumes collection only", async () => {
    const harness = await makeHarness();
    await harness.store.acquireBrowserLease(harness.requestId, OWNER_A);
    await harness.store.recordBrowserProgress(harness.requestId, OWNER_A, { phase: "awaiting_browser" });
    const capability = await harness.store.beginBrowserSubmission(harness.requestId, OWNER_A);
    await harness.store.confirmBrowserSubmission(
      harness.requestId,
      OWNER_A,
      capability,
      CONVERSATION_URL,
    );
    const submitted = await harness.store.get(harness.requestId);
    await expect(harness.store.recordBrowserProgress(harness.requestId, OWNER_A, {
      phase: "awaiting_response",
      submissionCertainty: "not_submitted",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.store.get(harness.requestId)).toEqual(submitted);
    await harness.store.releaseBrowserLease(harness.requestId, OWNER_A);
    harness.automation.runImpl = async (input) => ({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: responseEnvelope(input.requestId, harness.revision),
    });

    const result = await harness.job.run(harness.requestId, OWNER_B);

    expect(result.kind).toBe("completed");
    expect(harness.automation.calls).toHaveLength(1);
    expect(harness.automation.calls[0]).toMatchObject({
      mode: "collect_only",
      targetKind: "conversation",
      targetUrl: CONVERSATION_URL,
    });
  });

  test("records the immediate-read fast path for a resumed request in the JSONL event log", async () => {
    const harness = await makeHarness();
    await harness.store.acquireBrowserLease(harness.requestId, OWNER_A);
    await harness.store.recordBrowserProgress(harness.requestId, OWNER_A, { phase: "awaiting_browser" });
    const capability = await harness.store.beginBrowserSubmission(harness.requestId, OWNER_A);
    await harness.store.confirmBrowserSubmission(
      harness.requestId,
      OWNER_A,
      capability,
      CONVERSATION_URL,
    );
    await harness.store.releaseBrowserLease(harness.requestId, OWNER_A);
    harness.automation.runImpl = async (input) => ({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: responseEnvelope(input.requestId, harness.revision),
      collectionPath: "immediate",
    });

    const result = await harness.job.run(harness.requestId, OWNER_B);

    expect(result.kind).toBe("completed");
    expect(harness.automation.calls[0]).toMatchObject({ mode: "collect_only" });
    const events = (await readFile(
      join(harness.project.stateDir, "events", `${harness.requestId}.jsonl`),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    const completedEvent = events.find((line) => line.event === "completed");
    expect(completedEvent?.metadata).toMatchObject({ collectionPath: "immediate" });
  });

  test("records the polling fallback path for a resumed request in the JSONL event log", async () => {
    const harness = await makeHarness();
    await harness.store.acquireBrowserLease(harness.requestId, OWNER_A);
    await harness.store.recordBrowserProgress(harness.requestId, OWNER_A, { phase: "awaiting_browser" });
    const capability = await harness.store.beginBrowserSubmission(harness.requestId, OWNER_A);
    await harness.store.confirmBrowserSubmission(
      harness.requestId,
      OWNER_A,
      capability,
      CONVERSATION_URL,
    );
    await harness.store.releaseBrowserLease(harness.requestId, OWNER_A);
    harness.automation.runImpl = async (input) => ({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: responseEnvelope(input.requestId, harness.revision),
      collectionPath: "polling",
    });

    const result = await harness.job.run(harness.requestId, OWNER_B);

    expect(result.kind).toBe("completed");
    expect(harness.automation.calls[0]).toMatchObject({ mode: "collect_only" });
    const events = (await readFile(
      join(harness.project.stateDir, "events", `${harness.requestId}.jsonl`),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    const completedEvent = events.find((line) => line.event === "completed");
    expect(completedEvent?.metadata).toMatchObject({ collectionPath: "polling" });
  });

  test("a needs_manual recovery after a proven submission resumes collection only on the next open, never resubmission", async () => {
    let harness!: Harness;
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "recovery",
        phase: "needs_manual",
        reason: "ui_changed",
        certainty: "submitted",
        conversationUrl: CONVERSATION_URL,
      };
    });
    harness = await makeHarness({ automation });

    const stalled = await harness.job.run(harness.requestId, OWNER_A);

    expect(stalled).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_manual",
      reason: "ui_changed",
    });
    expect(await harness.store.get(harness.requestId)).toMatchObject({
      conversationUrl: CONVERSATION_URL,
      browserExecution: {
        phase: "needs_manual",
        lease: null,
        submission: { certainty: "submitted" },
      },
    });

    automation.runImpl = async (input) => ({
      kind: "completed",
      conversationUrl: CONVERSATION_URL,
      responseText: responseEnvelope(input.requestId, harness.revision),
    });

    const resumed = await harness.job.run(harness.requestId, OWNER_B);

    expect(resumed).toEqual({ kind: "completed", requestId: harness.requestId });
    expect(automation.calls).toHaveLength(2);
    expect(automation.calls[1]).toMatchObject({
      mode: "collect_only",
      targetKind: "conversation",
      targetUrl: CONVERSATION_URL,
    });
  });

  test("a stale worker cannot complete or clear the replacement owner's lease", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let authoritativeFiles!: [string, string];
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      now = new Date(now.getTime() + 30_001);
      await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
      authoritativeFiles = await Promise.all([
        readFile(join(harness.project.stateDir, "requests", `${harness.requestId}.json`), "utf8"),
        readFile(join(harness.project.stateDir, "events", `${harness.requestId}.jsonl`), "utf8"),
      ]);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
      };
    });
    harness = await makeHarness({ now: () => now, automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_manual",
      reason: "invalid_response",
    });
    expect(await harness.store.getCompletion(harness.requestId)).toBeNull();
    expect(await Promise.all([
      readFile(join(harness.project.stateDir, "requests", `${harness.requestId}.json`), "utf8"),
      readFile(join(harness.project.stateDir, "events", `${harness.requestId}.jsonl`), "utf8"),
    ])).toEqual(authoritativeFiles);
    expect((await harness.store.get(harness.requestId)).browserExecution).toMatchObject({
      attempt: 2,
      lease: { ownerId: OWNER_B },
      submission: { certainty: "submitted" },
    });
  });

  test("uncertain submission never automates, including a repeated run by the same owner", async () => {
    const harness = await makeHarness();
    await harness.store.acquireBrowserLease(harness.requestId, OWNER_A);
    await harness.store.recordBrowserProgress(harness.requestId, OWNER_A, {
      phase: "needs_manual",
      reason: "submission_uncertain",
      submissionCertainty: "uncertain",
    });
    await harness.store.releaseBrowserLease(harness.requestId, OWNER_A);

    const first = await harness.job.run(harness.requestId, OWNER_B);
    const second = await harness.job.run(harness.requestId, OWNER_B);
    const restartedAutomation = new FakeAutomation();
    const restarted = new BrowserJob({
      project: harness.project,
      store: harness.store,
      projectUrl: PROJECT_URL,
      automation: restartedAutomation,
      sessionManager: new FakeSessions(),
      preparePackage: async () => { throw new Error("uncertain restart must not package"); },
      cleanupPackage: async () => { throw new Error("uncertain restart must not clean"); },
    });
    const third = await restarted.run(harness.requestId, OWNER_B);

    expect(first).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_manual",
      reason: "submission_uncertain",
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(harness.automation.calls).toHaveLength(0);
    expect(restartedAutomation.calls).toHaveLength(0);
    expect(harness.packages).toHaveLength(0);
  });

  test("an expired worker lease is recoverable by a new owner", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const harness = await makeHarness({ now: () => now });
    await harness.store.acquireBrowserLease(harness.requestId, OWNER_A, 30_000);
    now = new Date(now.getTime() + 30_001);
    harness.automation.runImpl = async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
      };
    };

    expect(await harness.job.run(harness.requestId, OWNER_B)).toEqual({
      kind: "completed",
      requestId: harness.requestId,
    });
    expect((await harness.store.get(harness.requestId)).browserExecution?.attempt).toBe(2);
  });

  test("cancellation between browser actions stops completion and cleans up", async () => {
    let harness!: Harness;
    const automation = new FakeAutomation(async (_input, hooks) => {
      await harness.store.cancel(harness.requestId);
      expect(await hooks.isCancelled()).toBe(true);
      return { kind: "recovery", phase: "needs_manual", reason: "timed_out", certainty: "not_submitted" };
    });
    harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({ kind: "cancelled", requestId: harness.requestId });
    expect(harness.cleaned).toEqual([harness.packages[0]!]);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease).toBeNull();
  });

  test("request expiry between actions returns expired and still cleans up", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    const automation = new FakeAutomation(async (_input, hooks) => {
      now = new Date(now.getTime() + 101);
      expect(await hooks.isCancelled()).toBe(true);
      return { kind: "recovery", phase: "needs_manual", reason: "timed_out", certainty: "not_submitted" };
    });
    harness = await makeHarness({
      now: () => now,
      automation,
      input: { budget: { ...DEFAULT_BUDGET, expiresAfterMs: 100 } },
    });

    expect(await harness.job.run(harness.requestId, OWNER_A)).toEqual({
      kind: "expired",
      requestId: harness.requestId,
    });
    expect(harness.cleaned).toEqual([harness.packages[0]!]);
  });

  test("a completion revision conflict becomes sanitized invalid-response recovery", async () => {
    let harness!: Harness;
    const automation = new FakeAutomation(async (input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      await harness.store.claim(harness.requestId, harness.claimToken);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
      };
    });
    harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_manual",
      reason: "invalid_response",
    });
    expect(await harness.store.getCompletion(harness.requestId)).toBeNull();
    expect(harness.cleaned).toEqual([harness.packages[0]!]);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease).toBeNull();
    expect(await Bun.file(
      join(harness.project.stateDir, "rejected", `${harness.requestId}.json`),
    ).exists()).toBe(false);
  });

  for (const mismatch of ["request", "revision"] as const) {
    test(`a wrong completion ${mismatch} envelope never completes`, async () => {
      let harness!: Harness;
      const answer = `unusable ${mismatch} envelope answer`;
      const automation = new FakeAutomation(async (input, hooks) => {
        await hooks.beforeSubmission();
        await hooks.submissionConfirmed(CONVERSATION_URL);
        return {
          kind: "completed",
          conversationUrl: CONVERSATION_URL,
          responseText: responseEnvelope(
            mismatch === "request" ? "f".repeat(32) : input.requestId,
            mismatch === "revision" ? harness.revision + 1 : harness.revision,
            { ...completion, answer },
          ),
        };
      });
      harness = await makeHarness({ automation });

      const result = await harness.job.run(harness.requestId, OWNER_A);

      expect(result).toMatchObject({ kind: "recovery", reason: "invalid_response" });
      expect(await harness.store.getCompletion(harness.requestId)).toBeNull();
      expect(harness.cleaned).toEqual([harness.packages[0]!]);
      const rejected = JSON.parse(await readFile(
        join(harness.project.stateDir, "rejected", `${harness.requestId}.json`),
        "utf8",
      )) as { requestId: string; text: string };
      expect(rejected.requestId).toBe(harness.requestId);
      expect(rejected.text).toContain(answer);
    });
  }

  test("an event-path invalid_response recovery with observed text retains it as a rejected completion", async () => {
    let harness!: Harness;
    const observedText = "an unmatched final answer observed over the event path";
    const automation = new FakeAutomation(async (_input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "recovery",
        phase: "needs_manual",
        reason: "invalid_response",
        certainty: "submitted",
        conversationUrl: CONVERSATION_URL,
        collectionPath: "event",
        rejectedText: observedText,
      };
    });
    harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_manual",
      reason: "invalid_response",
    });
    const rejected = JSON.parse(await readFile(
      join(harness.project.stateDir, "rejected", `${harness.requestId}.json`),
      "utf8",
    )) as { requestId: string; text: string };
    expect(rejected.requestId).toBe(harness.requestId);
    expect(rejected.text).toContain(observedText);
  });

  test("an event-path recovery without observed text writes nothing to rejected", async () => {
    let harness!: Harness;
    const automation = new FakeAutomation(async (_input, hooks) => {
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "recovery",
        phase: "needs_manual",
        reason: "timed_out",
        certainty: "submitted",
        conversationUrl: CONVERSATION_URL,
        collectionPath: "event",
      };
    });
    harness = await makeHarness({ automation });

    await harness.job.run(harness.requestId, OWNER_A);

    expect(await Bun.file(
      join(harness.project.stateDir, "rejected", `${harness.requestId}.json`),
    ).exists()).toBe(false);
  });

  test("heartbeat renews the live lease for the same worker", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    const automation = new FakeAutomation(async (input, hooks) => {
      now = new Date(now.getTime() + 10_000);
      await hooks.heartbeat();
      expect((await harness.store.get(input.requestId)).browserExecution?.lease).toEqual({
        ownerId: OWNER_A,
        expiresAt: "2026-08-31T12:00:40.000Z",
      });
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
      };
    });
    harness = await makeHarness({ now: () => now, automation });

    expect((await harness.job.run(harness.requestId, OWNER_A)).kind).toBe("completed");
  });

  test("renews throughout package preparation lasting longer than the base lease", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let packaging = false;
    let ticks = 0;
    let takeoverRejected = false;
    const gate = deferred<void>();
    const fallback = setTimeout(() => gate.resolve(), 2_000);
    harness = await makeHarness({
      now: () => now,
      preparePackageImpl: async (value) => {
        packaging = true;
        await gate.promise;
        packaging = false;
        return value;
      },
      leaseWait: async (milliseconds, signal) => {
        if (!packaging) return waitForAbort(signal);
        now = new Date(now.getTime() + milliseconds);
        ticks++;
        if (ticks === 4) {
          try {
            await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
          } catch {
            takeoverRejected = true;
          }
          gate.resolve();
        }
      },
    });

    const result = await harness.job.run(harness.requestId, OWNER_A);
    clearTimeout(fallback);

    expect(result.kind).toBe("completed");
    expect(ticks).toBeGreaterThanOrEqual(4);
    expect(takeoverRejected).toBe(true);
    expect(harness.cleaned[0]).toBe(harness.packages[0]);
  });

  test("package-preparation takeover fails closed and cleans the exact late package", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let packaging = false;
    const gate = deferred<void>();
    const fallback = setTimeout(() => gate.resolve(), 2_000);
    harness = await makeHarness({
      now: () => now,
      preparePackageImpl: async (value) => {
        packaging = true;
        await gate.promise;
        packaging = false;
        return value;
      },
      leaseWait: async (_milliseconds, signal) => {
        if (!packaging) return waitForAbort(signal);
        now = new Date(now.getTime() + 30_001);
        await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
        gate.resolve();
      },
    });

    const result = await harness.job.run(harness.requestId, OWNER_A);
    clearTimeout(fallback);

    expect(result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(harness.sessions.ensureCalls).toHaveLength(0);
    expect(harness.automation.calls).toHaveLength(0);
    expect(harness.cleaned).toHaveLength(1);
    expect(harness.cleaned[0]).toBe(harness.packages[0]);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease)
      .toMatchObject({ ownerId: OWNER_B });
  });

  test("cancellation during package preparation stops before session mutation and cleans", async () => {
    let harness!: Harness;
    let packaging = false;
    const gate = deferred<void>();
    const fallback = setTimeout(() => gate.resolve(), 2_000);
    harness = await makeHarness({
      preparePackageImpl: async (value) => {
        packaging = true;
        await gate.promise;
        packaging = false;
        return value;
      },
      leaseWait: async (_milliseconds, signal) => {
        if (!packaging) return waitForAbort(signal);
        await harness.store.cancel(harness.requestId);
        gate.resolve();
      },
    });

    const result = await harness.job.run(harness.requestId, OWNER_A);
    clearTimeout(fallback);

    expect(result).toEqual({ kind: "cancelled", requestId: harness.requestId });
    expect(harness.sessions.ensureCalls).toHaveLength(0);
    expect(harness.automation.calls).toHaveLength(0);
    expect(harness.cleaned).toHaveLength(1);
    expect(harness.cleaned[0]).toBe(harness.packages[0]);
  });

  test("detaches a stuck package after lease loss and cleans its exact late fulfillment once", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let latePackage!: BrowserRequestPackage;
    let lossTriggered = false;
    const late = deferred<BrowserRequestPackage>();
    const leaseLost = deferred<void>();
    const lateCleaned = deferred<void>();
    harness = await makeHarness({
      now: () => now,
      preparePackageImpl: async (value) => {
        latePackage = value;
        return late.promise;
      },
      leaseWait: async (_milliseconds, signal) => {
        if (lossTriggered) return waitForAbort(signal);
        lossTriggered = true;
        now = new Date(now.getTime() + 30_001);
        leaseLost.resolve();
      },
      drainWait: async () => {},
      cleanupPackageImpl: async () => { lateCleaned.resolve(); },
    });

    const running = harness.job.run(harness.requestId, OWNER_A);
    await leaseLost.promise;
    const timely = await Promise.race([
      running.then((result) => ({ kind: "result" as const, result })),
      Bun.sleep(500).then(() => ({ kind: "blocked" as const })),
    ]);
    if (timely.kind === "blocked") {
      late.resolve(latePackage);
      await running;
    }

    expect(timely.kind).toBe("result");
    if (timely.kind !== "result") return;
    expect(timely.result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(harness.sessions.ensureCalls).toHaveLength(0);
    expect(harness.automation.calls).toHaveLength(0);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease).toBeNull();
    expect(harness.cleaned).toHaveLength(0);

    late.resolve(latePackage);
    await Promise.race([lateCleaned.promise, Bun.sleep(100)]);
    expect(harness.cleaned).toHaveLength(1);
    expect(harness.cleaned[0]).toBe(latePackage);
  });

  test("detaches a stuck session after takeover and consumes its late rejection", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let lossTriggered = false;
    let sessionStarted = false;
    const late = deferred<ChromeSession>();
    const leaseLost = deferred<void>();
    const sessions = new FakeSessions();
    sessions.ensureImpl = async () => {
      sessionStarted = true;
      return late.promise;
    };
    harness = await makeHarness({
      now: () => now,
      sessions,
      leaseWait: async (_milliseconds, signal) => {
        if (!sessionStarted) return waitForAbort(signal);
        if (lossTriggered) return waitForAbort(signal);
        lossTriggered = true;
        now = new Date(now.getTime() + 30_001);
        await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
        leaseLost.resolve();
      },
      drainWait: async () => {},
    });

    const running = harness.job.run(harness.requestId, OWNER_A);
    await leaseLost.promise;
    const timely = await Promise.race([
      running.then((result) => ({ kind: "result" as const, result })),
      Bun.sleep(500).then(() => ({ kind: "blocked" as const })),
    ]);
    if (timely.kind === "blocked") {
      late.reject(new Error("late private session failure"));
      await running;
    }

    expect(timely.kind).toBe("result");
    if (timely.kind !== "result") return;
    expect(timely.result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(harness.automation.calls).toHaveLength(0);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease)
      .toMatchObject({ ownerId: OWNER_B });

    late.reject(new Error("late private session failure"));
    await Bun.sleep(0);
    expect(harness.automation.calls).toHaveLength(0);
  });

  test("post-error lease validation wins over recovery persistence", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const harness = await makeHarness({
      now: () => now,
      preparePackageImpl: async () => {
        now = new Date(now.getTime() + 30_001);
        throw new Error("private package failure at lease expiry");
      },
    });
    const originalProgress = harness.store.recordBrowserProgress.bind(harness.store);
    let recoveryPersistenceCalls = 0;
    harness.store.recordBrowserProgress = async (...args) => {
      recoveryPersistenceCalls++;
      return originalProgress(...args);
    };

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(recoveryPersistenceCalls).toBe(0);
    expect(harness.sessions.ensureCalls).toHaveLength(0);
    expect((await harness.store.get(harness.requestId)).browserExecution).toMatchObject({
      phase: "preparing",
      lease: null,
    });
  });

  test("renews throughout session startup lasting longer than the base lease", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let starting = false;
    let ticks = 0;
    let takeoverRejected = false;
    const gate = deferred<void>();
    const fallback = setTimeout(() => gate.resolve(), 2_000);
    const sessions = new FakeSessions();
    sessions.ensureImpl = async () => {
      starting = true;
      await gate.promise;
      starting = false;
      return ownedSession();
    };
    harness = await makeHarness({
      now: () => now,
      sessions,
      leaseWait: async (milliseconds, signal) => {
        if (!starting) return waitForAbort(signal);
        now = new Date(now.getTime() + milliseconds);
        ticks++;
        if (ticks === 4) {
          try {
            await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
          } catch {
            takeoverRejected = true;
          }
          gate.resolve();
        }
      },
    });

    const result = await harness.job.run(harness.requestId, OWNER_A);
    clearTimeout(fallback);

    expect(result.kind).toBe("completed");
    expect(ticks).toBeGreaterThanOrEqual(4);
    expect(takeoverRejected).toBe(true);
  });

  test("session-start takeover fails closed before automation", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    let starting = false;
    let takeoverAttempted = false;
    const gate = deferred<void>();
    const fallback = setTimeout(() => gate.resolve(), 2_000);
    const sessions = new FakeSessions();
    sessions.ensureImpl = async () => {
      starting = true;
      await gate.promise;
      starting = false;
      return ownedSession();
    };
    harness = await makeHarness({
      now: () => now,
      sessions,
      leaseWait: async (_milliseconds, signal) => {
        if (!starting) return waitForAbort(signal);
        now = new Date(now.getTime() + 30_001);
        await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
        takeoverAttempted = true;
        gate.resolve();
      },
    });

    const result = await harness.job.run(harness.requestId, OWNER_A);
    clearTimeout(fallback);

    expect(takeoverAttempted).toBe(true);
    expect(result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(harness.automation.calls).toHaveLength(0);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease)
      .toMatchObject({ ownerId: OWNER_B });
  });

  test("needs-login switches atomically, waits exactly fifteen minutes, renews, and resumes", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    const automation = new FakeAutomation(async (input, hooks) => {
      if (automation.calls.length === 1) {
        return { kind: "recovery", phase: "needs_login", reason: "login_required", certainty: "not_submitted" };
      }
      expect(input.session.visibility).toBe("headed");
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, harness.revision),
      };
    });
    automation.probeImpl = async (input, hooks) => {
      expect(input.deadlineMs).toBe(15 * 60_000);
      now = new Date(now.getTime() + 10_000);
      await hooks.heartbeat();
      return "authenticated";
    };
    harness = await makeHarness({ now: () => now, automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result.kind).toBe("completed");
    expect(harness.sessions.ensureCalls).toEqual(["headless"]);
    expect(harness.sessions.switchCalls).toBe(1);
    expect(automation.probeCalls).toEqual([{
      session: ownedSession("headed"),
      projectUrl: PROJECT_URL,
      deadlineMs: 15 * 60_000,
    }]);
    expect(automation.calls).toHaveLength(2);
  });

  test("lease takeover after needs-login persistence prevents headed switch and probe", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const automation = new FakeAutomation(async () => ({
      kind: "recovery",
      phase: "needs_login",
      reason: "login_required",
      certainty: "not_submitted",
    }));
    const harness = await makeHarness({ now: () => now, automation });
    const originalRecord = harness.store.recordBrowserProgress.bind(harness.store);
    let tookOver = false;
    harness.store.recordBrowserProgress = async (requestId, ownerId, input) => {
      const updated = await originalRecord(requestId, ownerId, input);
      if (!tookOver && input.phase === "needs_login") {
        tookOver = true;
        now = new Date(now.getTime() + 30_001);
        await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
      }
      return updated;
    };

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(harness.sessions.switchCalls).toBe(0);
    expect(automation.probeCalls).toHaveLength(0);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease)
      .toMatchObject({ ownerId: OWNER_B });
  });

  test("lease takeover during headed switch prevents the authentication probe", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let harness!: Harness;
    const automation = new FakeAutomation(async () => ({
      kind: "recovery",
      phase: "needs_login",
      reason: "login_required",
      certainty: "not_submitted",
    }));
    const sessions = new FakeSessions();
    sessions.switchImpl = async () => {
      now = new Date(now.getTime() + 30_001);
      await harness.store.acquireBrowserLease(harness.requestId, OWNER_B, 30_000);
      return ownedSession("headed");
    };
    harness = await makeHarness({ now: () => now, automation, sessions });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toMatchObject({ kind: "recovery", reason: "browser_unavailable" });
    expect(sessions.switchCalls).toBe(1);
    expect(automation.probeCalls).toHaveLength(0);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease)
      .toMatchObject({ ownerId: OWNER_B });
  });

  test("renews through long headed switch and authentication probe", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    let active: "switch" | "probe" | null = null;
    const ticks = { switch: 0, probe: 0 };
    const switchGate = deferred<void>();
    const probeGate = deferred<void>();
    const switchFallback = setTimeout(() => switchGate.resolve(), 2_000);
    const probeFallback = setTimeout(() => probeGate.resolve(), 4_000);
    const automation = new FakeAutomation(async (input, hooks) => {
      if (automation.calls.length === 1) {
        return { kind: "recovery", phase: "needs_login", reason: "login_required", certainty: "not_submitted" };
      }
      await hooks.beforeSubmission();
      await hooks.submissionConfirmed(CONVERSATION_URL);
      return {
        kind: "completed",
        conversationUrl: CONVERSATION_URL,
        responseText: responseEnvelope(input.requestId, 0),
      };
    });
    const sessions = new FakeSessions();
    sessions.switchImpl = async () => {
      active = "switch";
      await switchGate.promise;
      active = null;
      return ownedSession("headed");
    };
    automation.probeImpl = async () => {
      active = "probe";
      await probeGate.promise;
      active = null;
      return "authenticated";
    };
    const harness = await makeHarness({
      now: () => now,
      automation,
      sessions,
      leaseWait: async (milliseconds, signal) => {
        if (active === null) return waitForAbort(signal);
        const step = active;
        now = new Date(now.getTime() + milliseconds);
        ticks[step]++;
        if (ticks[step] === 4) {
          if (step === "switch") switchGate.resolve();
          else probeGate.resolve();
        }
      },
    });

    const result = await harness.job.run(harness.requestId, OWNER_A);
    clearTimeout(switchFallback);
    clearTimeout(probeFallback);

    expect(result.kind).toBe("completed");
    expect(ticks).toEqual({ switch: 4, probe: 4 });
    expect(automation.probeCalls).toHaveLength(1);
  });

  test("login timeout retains needs-login and releases package and lease", async () => {
    const automation = new FakeAutomation(async () => ({
      kind: "recovery",
      phase: "needs_login",
      reason: "login_required",
      certainty: "not_submitted",
    }));
    automation.probeImpl = async () => "timed_out";
    const harness = await makeHarness({ automation });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_login",
      reason: "login_required",
    });
    expect(automation.calls).toHaveLength(1);
    expect((await harness.store.get(harness.requestId)).browserExecution).toMatchObject({
      phase: "needs_login",
      reason: "login_required",
      lease: null,
    });
    expect(harness.cleaned).toEqual([harness.packages[0]!]);
  });

  test("all thrown browser errors remain sanitized while package cleanup and lease release both run", async () => {
    const secret = "/private/staging/001-review.pdf";
    const automation = new FakeAutomation(async () => {
      throw new Error(`browser dumped ${secret} and raw page output`);
    });
    const harness = await makeHarness({ automation, cleanupError: new Error(`cleanup ${secret}`) });

    const result = await harness.job.run(harness.requestId, OWNER_A);

    expect(result).toEqual({
      kind: "recovery",
      requestId: harness.requestId,
      phase: "needs_manual",
      reason: "browser_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("raw page output");
    expect(harness.cleaned).toEqual([harness.packages[0]!]);
    expect((await harness.store.get(harness.requestId)).browserExecution?.lease).toBeNull();
    const events = await readFile(join(
      harness.project.stateDir,
      "events",
      `${harness.requestId}.jsonl`,
    ), "utf8");
    expect(events).not.toContain(secret);
    expect(events).not.toContain("raw page output");
    expect(events).not.toContain(harness.packages[0]!.prompt);
  });

  test("package preparation and headed-switch failures still release every acquired resource", async () => {
    const prepareFailure = await makeHarness({ prepareError: new Error("private package detail") });
    expect((await prepareFailure.job.run(prepareFailure.requestId, OWNER_A)).kind).toBe("recovery");
    expect((await prepareFailure.store.get(prepareFailure.requestId)).browserExecution?.lease).toBeNull();

    const automation = new FakeAutomation(async () => ({
      kind: "recovery",
      phase: "needs_login",
      reason: "login_required",
      certainty: "not_submitted",
    }));
    const switchFailure = await makeHarness({ automation });
    switchFailure.sessions.switchError = new Error("private browser profile path");
    expect((await switchFailure.job.run(switchFailure.requestId, OWNER_A)).kind).toBe("recovery");
    expect(switchFailure.cleaned).toEqual([switchFailure.packages[0]!]);
    expect((await switchFailure.store.get(switchFailure.requestId)).browserExecution?.lease).toBeNull();
  });
});
