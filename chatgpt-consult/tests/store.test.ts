import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET, HARD_BUDGET, type ConsultationCompletion } from "../src/core/schema";
import { RequestStore, type BrowserProgressInput, type CreateRequestInput } from "../src/core/store";
import { resolveProject } from "../src/security/project";

const temporaryPaths: string[] = [];
const fixedTime = new Date("2026-08-30T12:00:00.000Z");

const validCreateInput = (
  overrides: Partial<CreateRequestInput> = {},
): CreateRequestInput => ({
  projectName: "Example project",
  goal: "Review the queue implementation",
  profile: "analysis",
  parentId: null,
  conversationUrl: "https://chatgpt.com/g/g-example/project?private=query",
  idempotencyKey: "store-test-1",
  budget: DEFAULT_BUDGET,
  contextManifest: {
    selectors: ["src/core/store.ts"],
    paths: [],
    smartSelection: false,
    exclusions: [],
  },
  diff: null,
  attachments: [],
  sensitivity: [],
  connectorAllowlist: [],
  ...overrides,
});

const validCompletion = (
  overrides: Partial<ConsultationCompletion> = {},
): ConsultationCompletion => ({
  summary: "Queue review",
  answer: "Use the queue.",
  evidence: [],
  assumptions: [],
  risks: [],
  recommendations: [],
  followUpQuestions: [],
  ...overrides,
});

const makeStore = async (options: { now?: () => Date; fill?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-store-"));
  temporaryPaths.push(root);
  const project = await resolveProject(root);
  let randomCall = 0;
  const store = new RequestStore(project, {
    now: options.now ?? (() => fixedTime),
    randomBytes: (size) => Buffer.alloc(size, (options.fill ?? 7) + randomCall++),
  });
  await store.init();
  return { root, project, store };
};

const confirmBrowserSubmission = async (
  store: RequestStore,
  requestId: string,
  ownerId: string,
): Promise<void> => {
  await store.recordBrowserProgress(requestId, ownerId, { phase: "awaiting_browser" });
  const capability = await store.beginBrowserSubmission(requestId, ownerId);
  await store.confirmBrowserSubmission(
    requestId,
    ownerId,
    capability,
    "https://chatgpt.com/c/proven-store-result",
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("request store", () => {
  test("creates, claims, and idempotently completes without persisting the raw claim", async () => {
    const { project, store } = await makeStore();
    const input = validCreateInput();
    const created = await store.create(input);

    expect(created.request.state).toBe("pending");
    expect(created.claimToken).toHaveLength(43);
    expect(JSON.stringify(await store.get(created.request.id))).not.toContain(created.claimToken);

    const repeatedCreate = await store.create(input);
    expect(repeatedCreate).toEqual(created);

    const claimed = await store.claim(created.request.id, created.claimToken);
    expect(claimed).toMatchObject({ state: "claimed", revision: 1 });
    expect(await store.claim(created.request.id, created.claimToken)).toEqual(claimed);

    const completion = validCompletion();
    const done = await store.complete(created.request.id, created.claimToken, 1, completion);
    expect(done.request).toMatchObject({ state: "completed", revision: 2 });
    expect(done.result).toMatchObject({ completion, source: "mcp" });
    expect(await store.getCompletion(created.request.id)).toEqual(done.result);
    expect(await store.complete(created.request.id, created.claimToken, 1, completion)).toEqual(done);
    await expect(store.complete(created.request.id, created.claimToken, 0, completion))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(store.complete(created.request.id, created.claimToken, 2, completion))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store.complete(
        created.request.id,
        created.claimToken,
        1,
        validCompletion({ answer: "Different" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const requestText = await readFile(
      join(project.stateDir, "requests", `${created.request.id}.json`),
      "utf8",
    );
    const eventText = await readFile(
      join(project.stateDir, "events", `${created.request.id}.jsonl`),
      "utf8",
    );
    const forbiddenEventValues = [
      created.claimToken,
      createHash("sha256").update(created.claimToken).digest("hex"),
      input.goal,
      completion.answer,
      "private=query",
    ];
    expect(requestText).not.toContain(created.claimToken);
    for (const value of forbiddenEventValues) expect(eventText).not.toContain(value);
    for (const line of eventText.trim().split("\n")) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual([
        "event",
        "metadata",
        "requestId",
        "revision",
        "state",
        "timestamp",
      ]);
    }
    expect(await store.listRecent(10)).toEqual([done.request]);
  });

  test("returns an idempotent claim only for the identical immutable request payload", async () => {
    const { project, store } = await makeStore();
    const input = validCreateInput({ idempotencyKey: "payload-aware" });
    const created = await store.create(input);

    expect(await store.create(input)).toEqual(created);
    await expect(store.create({ ...input, goal: "A different goal" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await store.get(created.request.id)).toMatchObject({ goal: input.goal });

    const restarted = await RequestStore.init(project, {
      now: () => fixedTime,
      randomBytes: (size) => Buffer.alloc(size, 91),
    });
    const recovered = await restarted.create(input);
    expect(recovered.request).toMatchObject({ id: created.request.id, state: "pending", revision: 1 });
    expect(recovered.claimToken).not.toBe(created.claimToken);
    await expect(restarted.create({ ...input, goal: "A different goal" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("does not recover a one-time claim after a claimed request is restarted", async () => {
    const { project, store } = await makeStore();
    const input = validCreateInput({ idempotencyKey: "claimed-restart" });
    const created = await store.create(input);
    await store.claim(created.request.id, created.claimToken);

    const restarted = await RequestStore.init(project, { now: () => fixedTime });
    await expect(restarted.create(input)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("rejects exact, embedded, and pathological claim material before persisting a result", async () => {
    const { project, store } = await makeStore();
    const created = await store.create(validCreateInput({ idempotencyKey: "claim-material" }));
    const claimed = await store.claim(created.request.id, created.claimToken);
    const resultPath = join(project.stateDir, "results", `${created.request.id}.json`);

    for (const answer of [
      created.claimToken,
      `x${created.claimToken}x`,
      "a".repeat(20_000),
    ]) {
      await expect(store.complete(
        created.request.id,
        created.claimToken,
        claimed.revision,
        validCompletion({ answer }),
      )).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await Bun.file(resultPath).exists()).toBe(false);
    }

    const local = await store.create(validCreateInput({ idempotencyKey: "claim-material-local" }));
    await expect(store.completeLocal(
      local.request.id,
      local.request.revision,
      validCompletion({ answer: `prefix${local.claimToken}suffix` }),
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await store.getCompletion(local.request.id)).toBeNull();
  });

  test("rejects a bad claim without changing a pending request", async () => {
    const { store } = await makeStore();
    const created = await store.create(validCreateInput());

    await expect(store.claim(created.request.id, "not-the-claim"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.get(created.request.id)).toMatchObject({ state: "pending", revision: 0 });
  });

  test("authenticates before disclosing state, budget, revision, or completion size", async () => {
    const { store } = await makeStore();
    const wrongClaim = "A".repeat(43);

    const pending = await store.create(validCreateInput({ idempotencyKey: "auth-pending" }));
    await expect(store.claim(pending.request.id, wrongClaim))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    const claimed = await store.create(validCreateInput({
      idempotencyKey: "auth-claimed",
      budget: { ...DEFAULT_BUDGET, maxCompletionBytes: 32 },
    }));
    await store.claim(claimed.request.id, claimed.claimToken);
    for (const operation of [
      () => store.authorize(claimed.request.id, wrongClaim),
      () => store.consumeTextBudget(claimed.request.id, wrongClaim, 1),
      () => store.consumeSearchHits(claimed.request.id, wrongClaim, 1),
      () => store.consumeRetrievalBudget(claimed.request.id, wrongClaim, 1, 1),
      () => store.complete(claimed.request.id, wrongClaim, 1, validCompletion()),
    ]) await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND" });

    const completed = await store.create(validCreateInput({ idempotencyKey: "auth-completed" }));
    await store.claim(completed.request.id, completed.claimToken);
    await store.complete(completed.request.id, completed.claimToken, 1, validCompletion());
    for (const operation of [
      () => store.claim(completed.request.id, wrongClaim),
      () => store.authorize(completed.request.id, wrongClaim),
      () => store.complete(completed.request.id, wrongClaim, 1, validCompletion()),
    ]) await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND" });

    const cancelled = await store.create(validCreateInput({ idempotencyKey: "auth-cancelled" }));
    await store.claim(cancelled.request.id, cancelled.claimToken);
    await store.cancel(cancelled.request.id);
    for (const operation of [
      () => store.claim(cancelled.request.id, wrongClaim),
      () => store.authorize(cancelled.request.id, wrongClaim),
      () => store.complete(cancelled.request.id, wrongClaim, 1, validCompletion()),
    ]) await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a wrong claim does not materialize expiry while the valid claim still does", async () => {
    let now = fixedTime;
    const { project, store } = await makeStore({ now: () => now });
    const created = await store.create(validCreateInput({
      idempotencyKey: "claim-first-expiry",
      budget: { ...DEFAULT_BUDGET, expiresAfterMs: 1 },
    }));
    now = new Date(fixedTime.getTime() + 2);

    await expect(store.authorize(created.request.id, "A".repeat(43)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const path = join(project.stateDir, "requests", `${created.request.id}.json`);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      state: "pending",
      revision: 0,
    });

    await expect(store.authorize(created.request.id, created.claimToken))
      .rejects.toMatchObject({ code: "EXPIRED" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      state: "expired",
      revision: 1,
      claimHash: null,
    });
    await expect(store.claim(created.request.id, "A".repeat(43)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("cancels once and rejects a late completion", async () => {
    const { store } = await makeStore();
    const created = await store.create(validCreateInput());
    await store.claim(created.request.id, created.claimToken);

    const cancelled = await store.cancel(created.request.id);
    expect(cancelled).toMatchObject({ state: "cancelled", revision: 2, claimHash: null });
    expect(await store.cancel(created.request.id)).toEqual(cancelled);
    await expect(
      store.complete(created.request.id, created.claimToken, 1, validCompletion()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("persists expiry once before rejecting authorized operations", async () => {
    let now = fixedTime;
    const { store } = await makeStore({ now: () => now });
    const created = await store.create(
      validCreateInput({ budget: { ...DEFAULT_BUDGET, expiresAfterMs: 100 } }),
    );
    now = new Date(fixedTime.getTime() + 101);

    await expect(store.authorize(created.request.id, created.claimToken))
      .rejects.toMatchObject({ code: "EXPIRED" });
    expect(await store.get(created.request.id)).toMatchObject({
      state: "expired",
      revision: 1,
      claimHash: null,
    });
    await expect(store.claim(created.request.id, created.claimToken))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await store.get(created.request.id)).revision).toBe(1);
  });

  test("materializes pending and claimed expiry through get and list polling", async () => {
    let now = fixedTime;
    const { project, store } = await makeStore({ now: () => now });
    const budget = { ...DEFAULT_BUDGET, expiresAfterMs: 100 };
    const pending = await store.create(validCreateInput({
      idempotencyKey: "expiry-get",
      budget,
    }));
    const claimed = await store.create(validCreateInput({
      idempotencyKey: "expiry-list",
      budget,
    }));
    await store.claim(claimed.request.id, claimed.claimToken);
    now = new Date(fixedTime.getTime() + 101);

    expect(await store.get(pending.request.id)).toMatchObject({
      state: "expired",
      revision: 1,
      claimHash: null,
    });
    expect(await store.listRecent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: claimed.request.id, state: "expired", claimHash: null }),
    ]));
    expect((await store.get(claimed.request.id)).revision).toBe(2);
    const events = await readFile(
      join(project.stateDir, "events", `${claimed.request.id}.jsonl`),
      "utf8",
    );
    expect(events.match(/"event":"expired"/g)).toHaveLength(1);
    await expect(store.authorize(claimed.request.id, claimed.claimToken))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("rotates pending and explicitly allowed claimed capabilities", async () => {
    const { store } = await makeStore();
    const created = await store.create(validCreateInput());
    const pendingRotation = await store.rotateClaim(created.request.id);

    expect(pendingRotation.request).toMatchObject({ state: "pending", revision: 1 });
    expect(pendingRotation.claimToken).not.toBe(created.claimToken);
    await expect(store.claim(created.request.id, created.claimToken))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const claimed = await store.claim(created.request.id, pendingRotation.claimToken);
    expect(claimed.revision).toBe(2);

    await expect(store.rotateClaim(created.request.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const claimedRotation = await store.rotateClaim(created.request.id, true);
    expect(claimedRotation.request).toMatchObject({ state: "claimed", revision: 3 });
    await expect(store.authorize(created.request.id, pendingRotation.claimToken))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.authorize(created.request.id, claimedRotation.claimToken))
      .toEqual(claimedRotation.request);
  });

  test("updates cumulative budgets atomically without changing claim revision", async () => {
    const { store } = await makeStore();
    const created = await store.create(
      validCreateInput({
        budget: { ...DEFAULT_BUDGET, maxServedTextBytes: 10, maxSearchHits: 2 },
      }),
    );
    await store.claim(created.request.id, created.claimToken);

    const concurrent = await Promise.allSettled([
      store.consumeTextBudget(created.request.id, created.claimToken, 6),
      store.consumeTextBudget(created.request.id, created.claimToken, 6),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(
      (result) => result.status === "rejected" && result.reason.code === "BUDGET_EXCEEDED",
    )).toHaveLength(1);
    expect(await store.get(created.request.id)).toMatchObject({
      revision: 1,
      servedTextBytes: 6,
    });

    expect((await store.consumeSearchHits(created.request.id, created.claimToken, 1)).revision)
      .toBe(1);
    expect((await store.consumeSearchHits(created.request.id, created.claimToken, 1)).revision)
      .toBe(1);
    await expect(store.consumeSearchHits(created.request.id, created.claimToken, 1))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("reserves text bytes and search hits atomically", async () => {
    const { store } = await makeStore();
    const created = await store.create(validCreateInput({
      budget: { ...DEFAULT_BUDGET, maxServedTextBytes: 5, maxSearchHits: 1 },
    }));
    await store.claim(created.request.id, created.claimToken);

    await store.consumeRetrievalBudget(created.request.id, created.claimToken, 4, 1);
    await expect(
      store.consumeRetrievalBudget(created.request.id, created.claimToken, 1, 1),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await store.get(created.request.id)).toMatchObject({
      servedTextBytes: 4,
      servedSearchHits: 1,
    });
  });

  test("rejects request budgets above hard ceilings", async () => {
    const { project, store } = await makeStore();
    await expect(store.create(validCreateInput({
      budget: { ...DEFAULT_BUDGET, maxPaths: HARD_BUDGET.maxPaths + 1 },
    }))).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const created = await store.create(validCreateInput({ idempotencyKey: "hard-persisted" }));
    const path = join(project.stateDir, "requests", `${created.request.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.budget.maxPaths = HARD_BUDGET.maxPaths + 1;
    await writeFile(path, JSON.stringify(persisted));
    await expect(store.get(created.request.id)).rejects.toMatchObject({ code: "CORRUPT_STATE" });
  });

  test("rejects an over-ceiling ChatGPT request projection before persistence", async () => {
    const { project, store } = await makeStore();
    const selectors = Array.from(
      { length: 100 },
      (_, index) => `src/${"x".repeat(4_000)}-${index}`,
    );
    await expect(store.create(validCreateInput({
      idempotencyKey: "oversized-request-projection",
      contextManifest: {
        selectors,
        paths: [],
        smartSelection: false,
        exclusions: ["default-deny paths"],
      },
    }))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await readdir(join(project.stateDir, "requests"))).toEqual([]);

    const existing = await store.create(validCreateInput({ idempotencyKey: "oversized-existing" }));
    const path = join(project.stateDir, "requests", `${existing.request.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.contextManifest.selectors = selectors;
    await writeFile(path, JSON.stringify(persisted));
    await expect(store.claim(existing.request.id, existing.claimToken))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ state: "pending", revision: 0 });
  });

  test("rejects a cross-platform-unsafe POSIX basename before request persistence", async () => {
    const { project, store } = await makeStore();
    let failure: unknown;
    try {
      await store.create(validCreateInput({
        projectName: "legal\\posix-basename",
        idempotencyKey: "unsafe-public-project-name",
      }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(failure)).not.toContain(project.root);
    expect(await readdir(join(project.stateDir, "requests"))).toEqual([]);
  });

  test("validates the whole public request projection before persistence", async () => {
    const { project, store } = await makeStore();
    let failure: unknown;
    try {
      await store.create(validCreateInput({
        idempotencyKey: "unsafe-public-selector",
        contextManifest: {
          selectors: ["/absolute/not-public.txt"],
          paths: [],
          smartSelection: false,
          exclusions: [],
        },
      }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(failure)).not.toContain(project.root);
    expect(await readdir(join(project.stateDir, "requests"))).toEqual([]);
  });

  test("rejects a publicly invalid pending projection before claim mutation", async () => {
    const { project, store } = await makeStore();
    const created = await store.create(validCreateInput({
      idempotencyKey: "unsafe-public-claim",
    }));
    const path = join(project.stateDir, "requests", `${created.request.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.projectName = "legal\\posix-basename";
    await writeFile(path, JSON.stringify(persisted));

    await expect(store.claim(created.request.id, created.claimToken))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      state: "pending",
      revision: 0,
      projectName: "legal\\posix-basename",
    });
  });

  test("serializes concurrent completions and leaves one complete JSON result", async () => {
    const { project, store } = await makeStore();
    const created = await store.create(validCreateInput());
    await store.claim(created.request.id, created.claimToken);

    const outcomes = await Promise.allSettled([
      store.complete(
        created.request.id,
        created.claimToken,
        1,
        validCompletion({ answer: "First" }),
      ),
      store.complete(
        created.request.id,
        created.claimToken,
        1,
        validCompletion({ answer: "Second" }),
      ),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(
      (result) => result.status === "rejected" && result.reason.code === "CONFLICT",
    )).toHaveLength(1);

    const resultText = await readFile(
      join(project.stateDir, "results", `${created.request.id}.json`),
      "utf8",
    );
    expect(() => JSON.parse(resultText)).not.toThrow();
    expect((await store.get(created.request.id)).state).toBe("completed");
  });

  test("applies identical local completion rules with manual authority", async () => {
    const { store } = await makeStore();
    const created = await store.create(validCreateInput());
    const completion = validCompletion({ answer: "Entered manually" });

    const done = await store.completeLocal(created.request.id, 0, completion);
    expect(done).toMatchObject({
      request: { state: "completed", revision: 1 },
      result: { source: "manual", completion },
    });
    expect(await store.completeLocal(created.request.id, 0, completion)).toEqual(done);
    await expect(store.completeLocal(created.request.id, 1, completion))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store.completeLocal(created.request.id, 0, validCompletion({ answer: "Changed" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(store.cancel(created.request.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("rejects oversized completions and malformed persisted JSON", async () => {
    const { project, store } = await makeStore();
    const created = await store.create(
      validCreateInput({ budget: { ...DEFAULT_BUDGET, maxCompletionBytes: 32 } }),
    );
    await store.claim(created.request.id, created.claimToken);
    await expect(store.complete(created.request.id, created.claimToken, 1, validCompletion()))
      .rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    await writeFile(
      join(project.stateDir, "requests", `${created.request.id}.json`),
      "{not-json",
    );
    await expect(store.get(created.request.id)).rejects.toMatchObject({ code: "CORRUPT_STATE" });
  });

  test("creates only private real directories and rejects a symlinked state directory", async () => {
    const { project } = await makeStore();
    for (const directory of ["requests", "results", "attachments", "events", "locks", "rejected"]) {
      const info = await stat(join(project.stateDir, directory));
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }

    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-store-link-"));
    const target = await mkdtemp(join(tmpdir(), "chatgpt-consult-store-target-"));
    temporaryPaths.push(root, target);
    await symlink(target, join(root, ".chatgpt-consult"));
    expect((await lstat(join(root, ".chatgpt-consult"))).isSymbolicLink()).toBe(true);
    const linkedProject = await resolveProject(root);
    const linkedStore = new RequestStore(linkedProject);
    await expect(linkedStore.init()).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
  });

  test("does not follow a symlinked event file outside private state", async () => {
    const { project, store } = await makeStore();
    const created = await store.create(validCreateInput());
    await store.claim(created.request.id, created.claimToken);
    const outside = join(project.root, "outside-events.jsonl");
    const eventPath = join(project.stateDir, "events", `${created.request.id}.jsonl`);
    await writeFile(outside, "sentinel\n");
    await rm(eventPath);
    await symlink(outside, eventPath);

    await expect(store.consumeSearchHits(created.request.id, created.claimToken, 1))
      .rejects.toMatchObject({ code: "CORRUPT_STATE" });
    expect(await readFile(outside, "utf8")).toBe("sentinel\n");
  });

  test("pins an immutable canonical project and rejects redirected state", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-store-project-"));
    const outside = await mkdtemp(join(tmpdir(), "chatgpt-consult-store-redirect-"));
    temporaryPaths.push(root, outside);
    const project = await resolveProject(root);
    const originalStateDir = project.stateDir;
    const store = new RequestStore(project);

    (project as { stateDir: string }).stateDir = join(outside, ".chatgpt-consult");
    await store.init();
    expect((await stat(originalStateDir)).isDirectory()).toBe(true);
    await expect(lstat(join(outside, ".chatgpt-consult"))).rejects.toMatchObject({ code: "ENOENT" });

    const redirectedStore = new RequestStore({
      ...project,
      root,
      stateDir: join(outside, ".chatgpt-consult"),
    });
    await expect(redirectedStore.init()).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    await expect(lstat(join(outside, ".chatgpt-consult"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("recovers the same in-memory claim when initial event append fails", async () => {
    const { project, store } = await makeStore();
    const input = validCreateInput();
    const eventsPath = join(project.stateDir, "events");
    await rm(eventsPath, { recursive: true });
    await writeFile(eventsPath, "not a directory");

    await expect(store.create(input)).rejects.toBeDefined();
    await rm(eventsPath);
    await mkdir(eventsPath, { mode: 0o700 });

    const recovered = await store.create(input);
    expect(recovered.claimToken).toBe(Buffer.alloc(32, 8).toString("base64url"));
    expect(recovered.request).toMatchObject({ state: "pending", revision: 0 });
    expect(
      await readFile(
        join(project.stateDir, "events", `${recovered.request.id}.jsonl`),
        "utf8",
      ),
    ).toContain('"event":"created"');
  });

  test("does not acquire a released lock at its deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-store-deadline-"));
    temporaryPaths.push(root);
    const project = await resolveProject(root);
    let clock = 0;
    const waits: number[] = [];
    let lockPath = "";
    const store = new RequestStore(project, {
      now: () => fixedTime,
      randomBytes: (size) => Buffer.alloc(size, 17),
      lockNow: () => clock,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
        if (clock >= 2_000) await rm(lockPath, { force: true, recursive: true });
      },
    });
    await store.init();
    const created = await store.create(validCreateInput());
    lockPath = join(project.stateDir, "locks", `${created.request.id}.lock`);
    await mkdir(lockPath, { mode: 0o700 });

    await expect(store.claim(created.request.id, created.claimToken))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(2_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(25);
  });

  describe("setConversationUrl", () => {
    test("canonicalizes query/fragment and persists only exact ChatGPT URL", async () => {
      let now = fixedTime;
      const { project, store } = await makeStore({ now: () => now });
      const created = await store.create(validCreateInput({ conversationUrl: null }));
      now = new Date(fixedTime.getTime() + 1_000);

      const updated = await store.setConversationUrl(
        created.request.id,
        "https://chatgpt.com/c/abc-123?claim=secret#frag",
      );

      expect(updated.conversationUrl).toBe("https://chatgpt.com/c/abc-123");
      expect(updated.state).toBe(created.request.state);
      expect(updated.claimHash).toBe(created.request.claimHash);
      expect(updated.revision).toBe(created.request.revision);
      expect(updated.servedTextBytes).toBe(0);
      expect(updated.servedSearchHits).toBe(0);
      expect(updated.updatedAt).not.toBe(created.request.updatedAt);

      const persisted = JSON.parse(await readFile(
        join(project.stateDir, "requests", `${created.request.id}.json`),
        "utf8",
      ));
      expect(persisted.conversationUrl).toBe("https://chatgpt.com/c/abc-123");

      const events = await readFile(
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
        "utf8",
      );
      const urlEventLine = events.trim().split("\n").find((l) => l.includes("conversation_url_updated"));
      expect(urlEventLine).toBeDefined();
      const parsed = JSON.parse(urlEventLine!);
      expect(parsed.metadata).toEqual({});
      expect(events).not.toContain("chatgpt.com");
      expect(events).not.toContain("abc-123");
      expect(events).not.toContain("secret");
    });

    test("same canonical URL is idempotent with no second event or timestamp churn", async () => {
      let now = fixedTime;
      const { project, store } = await makeStore({ now: () => now });
      const created = await store.create(validCreateInput({ conversationUrl: null }));

      const first = await store.setConversationUrl(created.request.id, "https://chatgpt.com/c/abc");
      const firstUpdatedAt = first.updatedAt;

      now = new Date(fixedTime.getTime() + 5_000);

      const second = await store.setConversationUrl(created.request.id, "https://chatgpt.com/c/abc");
      expect(second.conversationUrl).toBe(first.conversationUrl);
      expect(second.updatedAt).toBe(firstUpdatedAt);

      const events = await readFile(
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
        "utf8",
      );
      const matches = events.match(/conversation_url_updated/g);
      expect(matches).toHaveLength(1);
    });

    test("rejects invalid URLs without changing request or event file", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ conversationUrl: null }));

      const before = await store.get(created.request.id);
      const eventsBefore = await readFile(
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
        "utf8",
      );

      for (const invalid of [
        "http://chatgpt.com/c/abc",
        "https://evil.chatgpt.com/c/abc",
        "https://chatgpt.com/",
        "https://chatgpt.com/auth/login",
        "https://user:pass@chatgpt.com/c/abc",
        "https://chatgpt.com:443/c/abc",
        "https://chatgpt.com.evil.test/c/abc",
        "not-a-url",
      ]) {
        await expect(store.setConversationUrl(created.request.id, invalid))
          .rejects.toMatchObject({ code: "INVALID_INPUT" });
      }

      const after = await store.get(created.request.id);
      expect(after.conversationUrl).toBe(before.conversationUrl);
      expect(after.updatedAt).toBe(before.updatedAt);

      const eventsAfter = await readFile(
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
        "utf8",
      );
      expect(eventsAfter).toBe(eventsBefore);
    });

    test("idempotent replay returns original claim after setConversationUrl changed stored URL", async () => {
      const { store } = await makeStore();
      const input = validCreateInput({
        idempotencyKey: "idempotent-after-url-change",
        conversationUrl: null,
      });
      const original = await store.create(input);

      await store.setConversationUrl(original.request.id, "https://chatgpt.com/c/new-conv");

      const replayed = await store.create(input);
      expect(replayed.request.id).toBe(original.request.id);
      expect(replayed.claimToken).toBe(original.claimToken);

      await expect(store.create({ ...input, goal: "Different goal" }))
        .rejects.toMatchObject({ code: "CONFLICT" });

      await expect(store.create({ ...input, conversationUrl: "https://chatgpt.com/c/other" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("browser execution", () => {
    test("queues eligible requests durably without changing lifecycle revision or claim authority", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-queue" }));
      const originalClaimHash = created.request.claimHash;

      const queued = await store.queueBrowserExecution(created.request.id);

      expect(queued).toMatchObject({
        state: "pending",
        revision: created.request.revision,
        claimHash: originalClaimHash,
        browserExecution: {
          phase: "queued",
          reason: null,
          attempt: 0,
          lease: null,
          submission: { certainty: "not_submitted", attemptedAt: null },
        },
      });
      expect(await store.queueBrowserExecution(created.request.id)).toEqual(queued);

      const claimed = await store.create(validCreateInput({ idempotencyKey: "browser-queue-claimed" }));
      const claimedRequest = await store.claim(claimed.request.id, claimed.claimToken);
      expect(await store.queueBrowserExecution(claimed.request.id)).toMatchObject({
        state: "claimed",
        revision: claimedRequest.revision,
        claimHash: claimedRequest.claimHash,
        browserExecution: { phase: "queued", lease: null },
      });
    });

    test("records launcher failure only while execution is unleased and queued", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-launch-failure" }));
      const queued = await store.queueBrowserExecution(created.request.id);

      const failed = await store.recordBrowserLaunchFailure(created.request.id);

      expect(failed).toMatchObject({
        state: created.request.state,
        revision: created.request.revision,
        claimHash: created.request.claimHash,
        browserExecution: {
          phase: "needs_manual",
          reason: "browser_unavailable",
          attempt: 0,
          lease: null,
        },
      });
      expect(queued.claimHash).toBe(failed.claimHash);
      const events = await readFile(
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
        "utf8",
      );
      expect(events).toContain('"event":"browser_launch_failed"');
      expect(events).toContain('"reason":"browser_unavailable"');

      const active = await store.create(validCreateInput({ idempotencyKey: "browser-live-launch" }));
      await store.queueBrowserExecution(active.request.id);
      const leased = await store.acquireBrowserLease(active.request.id, "a".repeat(32));
      expect(await store.recordBrowserLaunchFailure(active.request.id)).toEqual(leased);

      await store.recordBrowserProgress(active.request.id, "a".repeat(32), {
        phase: "needs_login",
        reason: "login_required",
      });
      const recovery = await store.releaseBrowserLease(active.request.id, "a".repeat(32));
      expect(recovery.browserExecution).toMatchObject({
        phase: "needs_login",
        reason: "login_required",
        lease: null,
      });
      expect(await store.recordBrowserLaunchFailure(active.request.id)).toEqual(recovery);
    });

    test("refuses to queue terminal requests", async () => {
      const { store } = await makeStore();
      const cancelled = await store.create(validCreateInput({ idempotencyKey: "queue-cancelled" }));
      await store.cancel(cancelled.request.id);
      await expect(store.queueBrowserExecution(cancelled.request.id))
        .rejects.toMatchObject({ code: "CONFLICT" });

      const completed = await store.create(validCreateInput({ idempotencyKey: "queue-completed" }));
      await store.completeLocal(completed.request.id, completed.request.revision, validCompletion());
      await expect(store.queueBrowserExecution(completed.request.id))
        .rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("allows one live browser lease and recovers an expired lease", async () => {
      let now = fixedTime;
      const { store } = await makeStore({ now: () => now });
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-lease" }));
      const first = await store.acquireBrowserLease(created.request.id, "a".repeat(32), 30_000);
      expect(first.browserExecution?.attempt).toBe(1);
      expect(first.revision).toBe(created.request.revision);
      await expect(store.acquireBrowserLease(created.request.id, "b".repeat(32), 30_000))
        .rejects.toMatchObject({ code: "CONFLICT" });
      now = new Date(fixedTime.getTime() + 30_001);
      const recovered = await store.acquireBrowserLease(created.request.id, "b".repeat(32), 30_000);
      expect(recovered.browserExecution?.lease?.ownerId).toBe("b".repeat(32));
      expect(recovered.browserExecution?.attempt).toBe(2);
    });

    test("validates owners, ceilings, and preserves revision across renewals and progress", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-owner" }));
      await expect(store.acquireBrowserLease(created.request.id, "bad", 30_000))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await store.acquireBrowserLease(created.request.id, "a".repeat(32), 30_000);
      await expect(store.renewBrowserLease(created.request.id, "b".repeat(32), 30_000))
        .rejects.toMatchObject({ code: "CONFLICT" });
      await expect(store.renewBrowserLease(created.request.id, "a".repeat(32), 60_001))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      const progress: BrowserProgressInput = {
        phase: "awaiting_browser",
        reason: "browser_unavailable",
        conversationUrl: "https://chatgpt.com/c/browser-owner?secret=redact#fragment",
      };
      // Keep the injected clock deterministic while still proving the write refreshes metadata.
      // (The store must not manufacture time when its clock is fixed.)
      const updated = await store.recordBrowserProgress(created.request.id, "a".repeat(32), progress);
      expect(updated.revision).toBe(created.request.revision);
      expect(updated.conversationUrl).toBe("https://chatgpt.com/c/browser-owner");
      expect(updated.updatedAt).toBe(created.request.updatedAt);
    });

    test("releases idempotently and clears leases on cancellation, expiry, and completion", async () => {
      let now = fixedTime;
      const { project, store } = await makeStore({ now: () => now });
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-terminal" }));
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      const released = await store.releaseBrowserLease(created.request.id, "a".repeat(32));
      expect(released.browserExecution?.lease).toBeNull();
      expect(await store.releaseBrowserLease(created.request.id, "a".repeat(32))).toEqual(released);
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      const cancelled = await store.cancel(created.request.id);
      expect(cancelled.browserExecution).toMatchObject({ phase: "cancelled", lease: null });

      const expired = await store.create(validCreateInput({
        idempotencyKey: "browser-expired",
        budget: { ...DEFAULT_BUDGET, expiresAfterMs: 100 },
      }));
      await store.acquireBrowserLease(expired.request.id, "a".repeat(32));
      now = new Date(fixedTime.getTime() + 101);
      expect((await store.get(expired.request.id)).browserExecution).toMatchObject({
        phase: "expired",
        lease: null,
      });

      const completed = await store.create(validCreateInput({ idempotencyKey: "browser-completed" }));
      await store.acquireBrowserLease(completed.request.id, "a".repeat(32));
      await confirmBrowserSubmission(store, completed.request.id, "a".repeat(32));
      const done = await store.completeBrowser(completed.request.id, completed.request.revision, validCompletion());
      expect(done.result.source).toBe("browser");
      expect(done.request.browserExecution).toMatchObject({ phase: "completed", lease: null });
      const events = await readFile(join(project.stateDir, "events", `${completed.request.id}.jsonl`), "utf8");
      expect(events).not.toContain("browser-owner");
      expect(events).not.toContain("secret");
    });

    test("imports browser completion only after proven response collection", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-completion" }));
      const before = await store.get(created.request.id);
      await expect(store.completeBrowser(created.request.id, before.revision, validCompletion()))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await store.get(created.request.id)).toEqual(before);
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      await confirmBrowserSubmission(store, created.request.id, "a".repeat(32));
      const ready = await store.get(created.request.id);
      const completed = await store.completeBrowser(created.request.id, ready.revision, validCompletion());
      expect(completed.result.source).toBe("browser");
      expect(completed.request.state).toBe("completed");
      expect(completed.request.revision).toBe(before.revision + 1);
    });

    test("rejects browser replay of a legacy manual completion without writes", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-replay-legacy" }));
      const completion = validCompletion({ answer: "Manual legacy answer" });
      const manuallyCompleted = await store.completeLocal(
        created.request.id,
        created.request.revision,
        completion,
      );
      expect(manuallyCompleted).toMatchObject({
        request: { browserExecution: null },
        result: { source: "manual" },
      });

      const paths = [
        join(project.stateDir, "requests", `${created.request.id}.json`),
        join(project.stateDir, "results", `${created.request.id}.json`),
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));

      await expect(store.completeBrowser(created.request.id, created.request.revision, completion))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
    });

    test("requires a browser-source result for proven browser replay without writes", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-replay-source" }));
      const completion = validCompletion({ answer: "Manually imported browser answer" });
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      await confirmBrowserSubmission(store, created.request.id, "a".repeat(32));
      const manuallyCompleted = await store.completeLocal(
        created.request.id,
        created.request.revision,
        completion,
      );
      expect(manuallyCompleted).toMatchObject({
        request: {
          browserExecution: {
            phase: "completed",
            lease: null,
            submission: { certainty: "submitted" },
          },
        },
        result: { source: "manual" },
      });

      const paths = [
        join(project.stateDir, "requests", `${created.request.id}.json`),
        join(project.stateDir, "results", `${created.request.id}.json`),
        join(project.stateDir, "events", `${created.request.id}.jsonl`),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));

      await expect(store.completeBrowser(created.request.id, created.request.revision, completion))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
    });

    test("idempotently replays a proven browser-source completion", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-replay-valid" }));
      const completion = validCompletion({ answer: "Browser answer" });
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      await confirmBrowserSubmission(store, created.request.id, "a".repeat(32));
      const completed = await store.completeBrowser(
        created.request.id,
        created.request.revision,
        completion,
      );
      const eventPath = join(project.stateDir, "events", `${created.request.id}.jsonl`);
      const eventsBefore = await readFile(eventPath, "utf8");

      expect(await store.completeBrowser(created.request.id, created.request.revision, completion))
        .toEqual(completed);
      expect(await readFile(eventPath, "utf8")).toBe(eventsBefore);
    });

    test("owner-and-attempt-bound browser completion rejects a stale worker without writes", async () => {
      let now = fixedTime;
      const { project, store } = await makeStore({ now: () => now });
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-owned-completion" }));
      const firstOwner = "a".repeat(32);
      const nextOwner = "b".repeat(32);
      const completion = validCompletion({ answer: "Owned browser answer" });

      const firstLease = await store.acquireBrowserLease(created.request.id, firstOwner, 30_000);
      const firstAttempt = firstLease.browserExecution!.attempt;
      await confirmBrowserSubmission(store, created.request.id, firstOwner);
      const requestPath = join(project.stateDir, "requests", `${created.request.id}.json`);
      const resultPath = join(project.stateDir, "results", `${created.request.id}.json`);
      const eventPath = join(project.stateDir, "events", `${created.request.id}.jsonl`);
      const activeBefore = await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]);
      await expect(store.completeBrowserOwned(
        created.request.id,
        created.request.revision,
        nextOwner,
        firstAttempt,
        completion,
      )).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(store.completeBrowserOwned(
        created.request.id,
        created.request.revision,
        firstOwner,
        firstAttempt + 1,
        completion,
      )).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]))
        .toEqual(activeBefore);
      await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" });

      now = new Date(fixedTime.getTime() + 30_001);
      const nextLease = await store.acquireBrowserLease(created.request.id, nextOwner, 30_000);
      const nextAttempt = nextLease.browserExecution!.attempt;

      const before = await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]);
      await expect(store.completeBrowserOwned(
        created.request.id,
        created.request.revision,
        firstOwner,
        firstAttempt,
        completion,
      )).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]))
        .toEqual(before);
      await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" });

      const completed = await store.completeBrowserOwned(
        created.request.id,
        created.request.revision,
        nextOwner,
        nextAttempt,
        completion,
      );
      const eventsBeforeReplay = await readFile(eventPath, "utf8");
      expect(completed).toMatchObject({
        request: { state: "completed", browserExecution: { attempt: nextAttempt, lease: null } },
        result: { source: "browser" },
      });
      expect(await store.completeBrowserOwned(
        created.request.id,
        created.request.revision,
        nextOwner,
        nextAttempt,
        completion,
      )).toEqual(completed);
      expect(await readFile(eventPath, "utf8")).toBe(eventsBeforeReplay);
    });

    test("manual completion resolves recovery phases without resubmitting or retaining a lease", async () => {
      for (const [phase, key] of [["needs_login", "browser-login"], ["needs_manual", "browser-manual"]] as const) {
        const { store } = await makeStore();
        const created = await store.create(validCreateInput({ idempotencyKey: key }));
        await store.acquireBrowserLease(created.request.id, "a".repeat(32));
        await store.recordBrowserProgress(created.request.id, "a".repeat(32), { phase });
        const done = await store.completeLocal(created.request.id, created.request.revision, validCompletion());
        expect(done.request.browserExecution).toMatchObject({ phase: "completed", lease: null });
      }
    });

    test("manual completion resolves uncertain recovery while browser completion is rejected", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-uncertain" }));
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      await store.recordBrowserProgress(created.request.id, "a".repeat(32), {
        phase: "needs_manual",
        submissionCertainty: "uncertain",
        reason: "submission_uncertain",
      });
      await expect(store.completeBrowser(created.request.id, created.request.revision, validCompletion()))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await store.get(created.request.id)).toMatchObject({
        state: "pending",
        browserExecution: {
          phase: "needs_manual",
          submission: { certainty: "uncertain" },
          lease: { ownerId: "a".repeat(32) },
        },
      });
      const done = await store.completeLocal(created.request.id, created.request.revision, validCompletion());
      expect(done.request.browserExecution).toMatchObject({
        phase: "completed",
        lease: null,
        submission: { certainty: "submitted" },
      });
    });

    test("MCP completion cannot clear uncertain browser recovery", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "mcp-uncertain" }));
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      await store.recordBrowserProgress(created.request.id, "a".repeat(32), {
        phase: "needs_manual",
        submissionCertainty: "uncertain",
        reason: "submission_uncertain",
      });
      const claimed = await store.claim(created.request.id, created.claimToken);
      await expect(store.complete(created.request.id, created.claimToken, claimed.revision, validCompletion()))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await store.getCompletion(created.request.id)).toBeNull();
      expect((await store.get(created.request.id)).browserExecution).toMatchObject({
        phase: "needs_manual",
        submission: { certainty: "uncertain" },
      });
    });

    test("rejects terminal progress and wrong-owner mutations without inconsistent state", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-terminal-progress" }));
      await store.acquireBrowserLease(created.request.id, "a".repeat(32));
      for (const phase of ["cancelled", "expired", "completed"] as const) {
        await expect(store.recordBrowserProgress(created.request.id, "a".repeat(32), { phase }))
          .rejects.toMatchObject({ code: "CONFLICT" });
      }
      await expect(store.recordBrowserProgress(created.request.id, "b".repeat(32), { phase: "awaiting_browser" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
      await expect(store.releaseBrowserLease(created.request.id, "b".repeat(32)))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await store.get(created.request.id)).toMatchObject({
        state: "pending",
        browserExecution: { phase: "preparing", lease: { ownerId: "a".repeat(32) } },
      });
    });

    test("confirms an uncertain submission only with the live per-attempt capability", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-confirm-capability" }));
      const owner = "a".repeat(32);
      await store.acquireBrowserLease(created.request.id, owner);
      await store.recordBrowserProgress(created.request.id, owner, { phase: "awaiting_browser" });

      const capability = await store.beginBrowserSubmission(created.request.id, owner);
      expect((await store.get(created.request.id)).browserExecution).toMatchObject({
        phase: "needs_manual",
        reason: "submission_uncertain",
        submission: {
          certainty: "uncertain",
          attemptedAt: fixedTime.toISOString(),
        },
      });
      await expect(store.confirmBrowserSubmission(
        created.request.id,
        "b".repeat(32),
        capability,
        "https://chatgpt.com/c/proven",
      )).rejects.toMatchObject({ code: "CONFLICT" });

      const confirmed = await store.confirmBrowserSubmission(
        created.request.id,
        owner,
        capability,
        "https://chatgpt.com/c/proven",
      );
      expect(confirmed).toMatchObject({
        conversationUrl: "https://chatgpt.com/c/proven",
        browserExecution: {
          phase: "awaiting_response",
          reason: null,
          submission: { certainty: "submitted" },
          lease: { ownerId: owner },
        },
      });
      await expect(store.confirmBrowserSubmission(
        created.request.id,
        owner,
        capability,
        "https://chatgpt.com/c/proven",
      )).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("rejects non-canonical submission confirmation URLs without mutation", async () => {
      const { project, store } = await makeStore();

      for (const [index, conversationUrl] of [
        "https://chatgpt.com/c/proven?private=redact",
        "https://chatgpt.com/c/proven#fragment",
        "https://CHATGPT.com/c/proven",
      ].entries()) {
        const created = await store.create(validCreateInput({
          idempotencyKey: `browser-noncanonical-confirm-${index}`,
        }));
        const owner = String.fromCharCode(97 + index).repeat(32);
        await store.acquireBrowserLease(created.request.id, owner);
        await store.recordBrowserProgress(created.request.id, owner, { phase: "awaiting_browser" });
        const capability = await store.beginBrowserSubmission(created.request.id, owner);
        const requestPath = join(project.stateDir, "requests", `${created.request.id}.json`);
        const eventPath = join(project.stateDir, "events", `${created.request.id}.jsonl`);
        const before = await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]);

        await expect(store.confirmBrowserSubmission(
          created.request.id,
          owner,
          capability,
          conversationUrl,
        )).rejects.toMatchObject({ code: "INVALID_INPUT" });

        expect(await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]))
          .toEqual(before);
      }
    });

    test("generic browser progress cannot claim submission confirmation authority", async () => {
      const { store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-generic-submit" }));
      const owner = "a".repeat(32);
      await store.acquireBrowserLease(created.request.id, owner);
      await store.recordBrowserProgress(created.request.id, owner, { phase: "awaiting_browser" });

      await expect(store.recordBrowserProgress(created.request.id, owner, {
        phase: "awaiting_response",
        submissionCertainty: "submitted",
        conversationUrl: "https://chatgpt.com/c/unproven",
      })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await store.get(created.request.id)).toMatchObject({
        conversationUrl: "https://chatgpt.com/g/g-example/project?private=query",
        browserExecution: {
          phase: "awaiting_browser",
          submission: { certainty: "not_submitted" },
        },
      });
    });

    test("generic progress cannot downgrade submitted certainty and writes nothing", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-submit-monotonic" }));
      const owner = "a".repeat(32);
      await store.acquireBrowserLease(created.request.id, owner);
      await confirmBrowserSubmission(store, created.request.id, owner);
      const requestPath = join(project.stateDir, "requests", `${created.request.id}.json`);
      const eventPath = join(project.stateDir, "events", `${created.request.id}.jsonl`);
      const before = await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]);

      for (const submissionCertainty of ["not_submitted", "uncertain"] as const) {
        await expect(store.recordBrowserProgress(created.request.id, owner, {
          phase: submissionCertainty === "uncertain" ? "needs_manual" : "awaiting_response",
          submissionCertainty,
        })).rejects.toMatchObject({ code: "CONFLICT" });
      }

      expect(await Promise.all([readFile(requestPath, "utf8"), readFile(eventPath, "utf8")]))
        .toEqual(before);
    });

    test("rejects forged, restarted, and stale submission confirmations", async () => {
      let now = fixedTime;
      const { project, store } = await makeStore({ now: () => now });
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-stale-confirm" }));
      const firstOwner = "a".repeat(32);
      const nextOwner = "b".repeat(32);
      await store.acquireBrowserLease(created.request.id, firstOwner, 30_000);
      await store.recordBrowserProgress(created.request.id, firstOwner, { phase: "awaiting_browser" });
      await expect(store.confirmBrowserSubmission(
        created.request.id,
        firstOwner,
        {} as never,
        "https://chatgpt.com/c/forged",
      )).rejects.toMatchObject({ code: "CONFLICT" });

      const capability = await store.beginBrowserSubmission(created.request.id, firstOwner);
      const restarted = await RequestStore.init(project, { now: () => now });
      await expect(restarted.confirmBrowserSubmission(
        created.request.id,
        firstOwner,
        capability,
        "https://chatgpt.com/c/restarted",
      )).rejects.toMatchObject({ code: "CONFLICT" });

      now = new Date(fixedTime.getTime() + 30_001);
      await store.acquireBrowserLease(created.request.id, nextOwner, 30_000);
      await expect(store.confirmBrowserSubmission(
        created.request.id,
        firstOwner,
        capability,
        "https://chatgpt.com/c/stale",
      )).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await store.get(created.request.id)).browserExecution).toMatchObject({
        phase: "needs_manual",
        submission: { certainty: "uncertain" },
        lease: { ownerId: nextOwner },
      });
    });

    test("rejects invalid lease durations and mutations on terminal requests", async () => {
      const { store } = await makeStore();
      const cancelled = await store.create(validCreateInput({ idempotencyKey: "browser-cancelled" }));
      await store.cancel(cancelled.request.id);
      for (const duration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.acquireBrowserLease(cancelled.request.id, "a".repeat(32), duration))
          .rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
      await expect(store.acquireBrowserLease(cancelled.request.id, "a".repeat(32)))
        .rejects.toMatchObject({ code: "CONFLICT" });

      const completed = await store.create(validCreateInput({ idempotencyKey: "browser-done" }));
      await store.completeLocal(completed.request.id, completed.request.revision, validCompletion());
      await expect(store.acquireBrowserLease(completed.request.id, "a".repeat(32)))
        .rejects.toMatchObject({ code: "CONFLICT" });
      await expect(store.recordBrowserProgress(completed.request.id, "a".repeat(32), { phase: "completed" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("persists rejected browser completion text redacted and bounded, only under a live lease", async () => {
      const { project, store } = await makeStore();
      const created = await store.create(validCreateInput({ idempotencyKey: "browser-rejected" }));
      const owner = "a".repeat(32);
      const rejectedPath = join(project.stateDir, "rejected", `${created.request.id}.json`);

      await expect(store.persistRejectedBrowserCompletion(created.request.id, owner, "no lease yet"))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await Bun.file(rejectedPath).exists()).toBe(false);

      await store.queueBrowserExecution(created.request.id);
      await store.acquireBrowserLease(created.request.id, owner);
      const leaked = `BEGIN ${created.claimToken} END`;
      await store.persistRejectedBrowserCompletion(created.request.id, owner, leaked);

      const persisted = JSON.parse(await readFile(rejectedPath, "utf8")) as {
        requestId: string;
        rejectedAt: string;
        text: string;
      };
      expect(persisted.requestId).toBe(created.request.id);
      expect(persisted.text).not.toContain(created.claimToken);
      expect(persisted.text).toContain("BEGIN");
      expect(persisted.text).toContain("END");
      expect(() => new Date(persisted.rejectedAt).toISOString()).not.toThrow();

      const word = "boundary ";
      const oversized = word.repeat(Math.ceil((HARD_BUDGET.maxCompletionBytes + 1_000) / word.length));
      await store.persistRejectedBrowserCompletion(created.request.id, owner, oversized);
      const rebounded = JSON.parse(await readFile(rejectedPath, "utf8")) as { text: string };
      expect(Buffer.byteLength(rebounded.text, "utf8")).toBeLessThanOrEqual(HARD_BUDGET.maxCompletionBytes);

      await expect(store.persistRejectedBrowserCompletion(created.request.id, "b".repeat(32), "wrong owner"))
        .rejects.toMatchObject({ code: "CONFLICT" });
    });
  });
});
