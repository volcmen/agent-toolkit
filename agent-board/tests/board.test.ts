import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardRevision, Store } from "../src/store.ts";
import { LeaseDb } from "../src/lease.ts";
import { CONFIG_FILE, defaultConfig, loadConfig } from "../src/config.ts";
import { inspectRoles, loadRoles, seedRoles } from "../src/roles.ts";
import { seedPrompts, loadPrompts } from "../src/prompts.ts";
import { ancestry, extractBlocked, extractHandoff, parentHandoffs, workerPrompt } from "../src/context.ts";
import { cardsById, dispatchPreview, parentsSatisfied, pickReady, tick } from "../src/dispatcher.ts";
import {
  claudeArgv,
  codexArgv,
  effectiveSkills,
  logPathFor,
  ProcessGroupTerminationError,
  previewArgv,
  promptWithSkills,
  terminateProcessGroup,
  type RunnerOutput,
} from "../src/runners.ts";
import { attachPlan } from "../src/attach.ts";
import { resolveWorkspace } from "../src/workspace.ts";
import * as limits from "../src/limits.ts";
import { triageCard } from "../src/triage.ts";
import type { BoardConfig, Card } from "../src/types.ts";
import {
  allowedLifecycleActions,
  lifecycleActionForStatus,
  lifecycleStatus,
  sessionSurvivesRuntime,
  validateParents,
} from "../src/domain.ts";

let root: string;
let store: Store;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ab-test-"));
  store = new Store(root);
  store.ensureDirs();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function concurrentClaims(
  inputs: Record<string, unknown>[],
): Promise<(string | null)[]> {
  const modulePath = new URL("../src/lease.ts", import.meta.url).pathname;
  const script = join(root, "contender.ts");
  writeFileSync(
    script,
    `import { LeaseDb } from ${JSON.stringify(modulePath)};
const [root, raw] = process.argv.slice(2);
await Bun.stdin.text();
const db = new LeaseDb(root);
const input = JSON.parse(raw);
const result = db.claimCapacity(input);
db.close();
console.log(JSON.stringify(result));
`,
    "utf8",
  );
  const children = inputs.map((input) => Bun.spawn(
    ["bun", script, root, JSON.stringify(input)],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  ));
  for (const child of children) child.stdin.end();
  return Promise.all(children.map(async (child) => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`contender exited ${exitCode}: ${stderr}`);
    expect(stderr).toBe("");
    const value = JSON.parse(stdout) as string | { runId: string } | null;
    return value && typeof value === "object" ? value.runId : value;
  }));
}

describe("store", () => {
  test("creates a card as a markdown file and reads it back", () => {
    const card = store.create({ title: "Add /health", body: "**Goal** x", role: "backend" });
    expect(card.status).toBe("triage");
    const reloaded = store.byId(card.id);
    expect(reloaded?.title).toBe("Add /health");
    expect(reloaded?.body.trim()).toBe("**Goal** x");
    expect(reloaded?.role).toBe("backend");
  });

  test("a short id tail resolves to the card", () => {
    const card = store.create({ title: "t" });
    expect(store.byId(card.id.slice(-4))?.id).toBe(card.id);
  });

  test("update rewrites frontmatter and bumps updated_at", async () => {
    const card = store.create({ title: "t" });
    await Bun.sleep(2);
    const updated = store.update(card.id, { status: "ready", role: "qa" });
    expect(updated.status).toBe("ready");
    expect(store.byId(card.id)?.role).toBe("qa");
    expect(store.byId(card.id)?.updatedAt).not.toBe(card.createdAt);
  });

  test("unknown ids raise", () => {
    expect(() => store.requireById("c_nope")).toThrow(/no such card/);
  });

  test("hand-edited files are respected (files are the source of truth)", async () => {
    const card = store.create({ title: "t", body: "old" });
    const text = await Bun.file(card.path).text();
    await Bun.write(card.path, text.replace("old", "hand edited"));
    expect(store.byId(card.id)?.body.trim()).toBe("hand edited");
  });
});

describe("persisted config", () => {
  test("loads a supported partial config after merging defaults", () => {
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify({
      name: "strict",
      workdir: root,
      maxRunning: 4,
      maxTurns: 12,
    }));
    const config = loadConfig(root);
    expect(config.name).toBe("strict");
    expect(config.maxRunning).toBe(4);
    expect(config.maxTurns).toBe(12);
  });

  test("loads old money config without preserving dollar admission", () => {
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify({
      workdir: root,
      budget: { perCardUsd: 1.5, perDayUsd: 10, perCardTurns: 7, perRunReserveUsd: 1.5 },
      triageChain: [{ kind: "codex", model: "gpt-5.6-sol", maxUsd: 0.05 }],
    }));
    const config = loadConfig(root);
    expect(config.maxTurns).toBe(7);
    expect(config.triageChain).toEqual([{ kind: "codex", model: "gpt-5.6-sol" }]);
    expect(config).not.toHaveProperty("budget");
  });

  test("fails closed with field-specific errors for unsafe values and shapes", () => {
    const cases: [unknown, RegExp][] = [
      [null, /config must be an object/],
      [{ maxRunning: 0 }, /maxRunning must be a finite number >= 1/],
      [{ maxRunningPerRole: 1.5 }, /maxRunningPerRole must be an integer/],
      [{ tickSeconds: 0 }, /tickSeconds must be a finite number >= 1/],
      [{ staleSeconds: -1 }, /staleSeconds must be a finite number >= 1/],
      [{ failureLimit: 0 }, /failureLimit must be a finite number >= 1/],
      [{ defaultRuntime: "shell" }, /defaultRuntime must be one of/],
      [{ workdir: "relative" }, /workdir must be an absolute path/],
      [{ workdir: join(root, "missing") }, /workdir must name an existing directory/],
      [{ maxTurns: 1.5 }, /maxTurns must be an integer/],
      [{ context: { bodyChars: 0 } }, /context\.bodyChars must be a finite number >= 1/],
      [{ triageChain: [] }, /triageChain must be a non-empty array/],
      [{ triageChain: [{ kind: "shell", model: "x" }] }, /triageChain\[0\]\.kind/],
      [{ triageChain: [{ kind: "codex", model: "x", baseUrl: "http:\/\/x" }] }, /baseUrl is only supported/],
      [{ surprise: true }, /surprise is not supported/],
    ];
    for (const [patch, expected] of cases) {
      writeFileSync(join(root, CONFIG_FILE), JSON.stringify(patch));
      expect(() => loadConfig(root)).toThrow(expected);
    }
  });
});

describe("leases", () => {
  test("a second claim on the same card fails", () => {
    const db = new LeaseDb(root);
    expect(db.claim("c_1", "owner-a")).toBeTruthy();
    expect(db.claim("c_1", "owner-b")).toBeNull();
    db.release("c_1");
    expect(db.claim("c_1", "owner-b")).toBeTruthy();
    db.close();
  });

  test("a lease serializes user mutation and admission validates the card snapshot", () => {
    seedRoles(root);
    const card = store.create({ title: "snapshot", body: "old", role: "backend", status: "ready" });
    const db = new LeaseDb(root);
    const before = readFileSync(card.path, "utf8");
    const changed = db.mutateUnleased(card.id, () => store.update(card.id, { body: "new" }));
    expect(changed.ok).toBe(true);
    const claim = db.claimCapacity({
      cardId: card.id, owner: "dispatcher", role: "backend", pid: null,
      maxRunning: 1, maxRunningPerRole: 1,
      snapshotValid: () => readFileSync(card.path, "utf8") === before,
    });
    expect(claim).toBeNull();
    expect(db.lease(card.id)).toBeNull();

    const admitted = db.claim(card.id, "worker", null, "backend");
    expect(admitted).not.toBeNull();
    const rejected = db.mutateUnleased(card.id, () => store.update(card.id, { body: "stale" }));
    expect(rejected.ok).toBe(false);
    expect(store.requireById(card.id).body.trim()).toBe("new");
    db.close();
  });

  test("stale leases surface once the heartbeat is old", () => {
    const db = new LeaseDb(root);
    db.claim("c_1", "owner");
    expect(db.staleLeases(60)).toHaveLength(0);
    // Simulate a lease claimed an hour ago by looking further back in time.
    expect(db.staleLeases(60, Math.floor(Date.now() / 1000) + 3600)).toHaveLength(1);
    db.close();
  });

  test("failures accumulate and reset", () => {
    const db = new LeaseDb(root);
    expect(db.recordFailure("c_1", "boom")).toBe(1);
    expect(db.recordFailure("c_1", "boom")).toBe(2);
    db.clearFailures("c_1");
    expect(db.failureCount("c_1")).toBe(0);
    db.close();
  });

  test("the ledger tracks cost and tokens per card and per day", () => {
    const db = new LeaseDb(root);
    db.spend("c_1", "triage:codex", 0, 1200);
    db.spend("c_1", "run:claude", 0.25, 800);
    expect(db.spentOnCard("c_1")).toBeCloseTo(0.25);
    expect(db.tokensOnCard("c_1")).toBe(2000);
    expect(db.spentToday()).toBeCloseTo(0.25);
    expect(db.ledgerByKind()["run:claude"]).toBeCloseTo(0.25);
    db.close();
  });

  test("arbitrarily large recorded usage never blocks worker admission", async () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const card = store.create({ title: "unmetered admission", role: "backend", status: "ready" });
    db.spend(card.id, "historical", 1_000_000, 1_000_000_000);

    const report = await tick(store, db, defaultConfig(root), {
      runner: async () => successfulRun({ handoff: "usage remained telemetry-only" }),
    });

    expect(report.started).toEqual([card.id]);
    expect(report.finished).toContainEqual({ cardId: card.id, ok: true, usd: 0, status: "review" });
    expect(store.requireById(card.id).status).toBe("review");
    expect(db.spentOnCard(card.id)).toBe(1_000_000);
    expect(db.tokensOnCard(card.id)).toBe(1_000_000_010);
    db.close();
  });
});

describe("process-group shutdown", () => {
  test("waits a bounded TERM grace then escalates to KILL", async () => {
    const signals: string[] = [];
    let alive = true;
    let waits = 0;
    const stopped = await terminateProcessGroup(42, {
      graceMs: 2,
      killGraceMs: 2,
      pollMs: 1,
      signal: (_pgid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      alive: () => alive,
      wait: async () => { waits += 1; },
    });
    expect(stopped).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(waits).toBe(2);
  });

  test("stale recovery retains ownership when group death is unconfirmed", async () => {
    seedRoles(root);
    const card = store.create({ title: "still alive", role: "backend", status: "running" });
    const db = new LeaseDb(root);
    const runId = db.claim(card.id, "dead-dispatcher", 7, "backend");
    if (!runId) throw new Error("claim failed");
    db.setProcessGroup(card.id, runId, 777);
    const report = await tick(store, db, { ...defaultConfig(root), staleSeconds: -1 }, {
      terminateGroup: async (pgid) => {
        expect(pgid).toBe(777);
        return false;
      },
    });
    expect(report.reclaimed).toHaveLength(0);
    expect(report.skipped).toContainEqual({
      cardId: card.id,
      reason: "stale worker process group could not be confirmed stopped; lease retained",
    });
    expect(db.lease(card.id)?.runId).toBe(runId);
    expect(store.requireById(card.id).status).toBe("running");
    expect(db.failureCount(card.id)).toBe(0);
    db.close();
  });

  test("stale recovery releases only after process-group termination completes", async () => {
    seedRoles(root);
    const card = store.create({ title: "ordered shutdown", role: "backend", status: "running" });
    const db = new LeaseDb(root);
    const runId = db.claim(card.id, "dead-dispatcher", 7, "backend");
    if (!runId) throw new Error("claim failed");
    db.setProcessGroup(card.id, runId, 888);
    let entered!: () => void;
    const terminating = new Promise<void>((resolve) => { entered = resolve; });
    let stopped!: (value: boolean) => void;
    const stop = new Promise<boolean>((resolve) => { stopped = resolve; });
    const running = tick(
      store,
      db,
      { ...defaultConfig(root), staleSeconds: -1, failureLimit: 1 },
      {
        terminateGroup: async () => {
          entered();
          return stop;
        },
      },
    );
    await terminating;
    expect(db.lease(card.id)?.runId).toBe(runId);
    expect(store.requireById(card.id).status).toBe("running");
    stopped(true);
    const report = await running;
    expect(report.reclaimed).toContain(card.id);
    expect(db.lease(card.id)).toBeNull();
    expect(store.requireById(card.id).status).toBe("blocked");
    db.close();
  });

  test("stale recovery releases a run interrupted before spawn", async () => {
    seedRoles(root);
    const card = store.create({ title: "never spawned", role: "backend", status: "running" });
    const db = new LeaseDb(root);
    const runId = db.claim(card.id, "dead-dispatcher", 7, "backend");
    if (!runId) throw new Error("claim failed");
    db.startRun({
      runId,
      cardId: card.id,
      role: "backend",
      runtime: "codex",
      model: "(role default)",
      startedAt: 1,
      sessionId: null,
    });
    expect(db.markLaunchPrepared(card.id, runId)).toBe(true);
    const report = await tick(store, db, {
      ...defaultConfig(root), staleSeconds: -1, maxRunning: 0,
    });
    expect(report.reclaimed).toContain(card.id);
    expect(db.lease(card.id)).toBeNull();
    expect(store.requireById(card.id).status).toBe("ready");
    db.close();
  });

  test("a released spawning wrapper cannot start an unowned worker", async () => {
    seedRoles(root);
    const card = store.create({ title: "registration interruption", role: "backend", status: "running" });
    const db = new LeaseDb(root);
    const runId = db.claim(card.id, "dead-dispatcher", 7, "backend");
    if (!runId) throw new Error("claim failed");
    db.startRun({
      runId,
      cardId: card.id,
      role: "backend",
      runtime: "codex",
      model: "(role default)",
      startedAt: 1,
      sessionId: null,
    });
    expect(db.markLaunchPrepared(card.id, runId)).toBe(true);
    expect(db.beginSpawn(card.id, runId)).toBe(true);

    await tick(store, db, { ...defaultConfig(root), staleSeconds: -1, maxRunning: 0 });
    const marker = join(root, "worker-started");
    const helper = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "../src/launch-worker.ts"),
      root,
      card.id,
      runId,
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(marker)}, "unsafe")`,
    ]);
    expect(await helper.exited).toBe(75);
    expect(existsSync(marker)).toBe(false);
    expect(db.lease(card.id)).toBeNull();
    db.close();
  });

  test("process-group registration wins a concurrent stale reclaim", async () => {
    seedRoles(root);
    const card = store.create({ title: "registration wins", role: "backend", status: "running" });
    const db = new LeaseDb(root);
    const runId = db.claim(card.id, "dead-dispatcher", 7, "backend");
    if (!runId) throw new Error("claim failed");
    db.startRun({
      runId,
      cardId: card.id,
      role: "backend",
      runtime: "codex",
      model: "(role default)",
      startedAt: 1,
      sessionId: null,
    });
    expect(db.markLaunchPrepared(card.id, runId)).toBe(true);
    expect(db.beginSpawn(card.id, runId)).toBe(true);
    const owned = db.withOwnedLease.bind(db);
    let injected = false;
    db.withOwnedLease = ((cardId, ownerRunId, mutation) => {
      if (!injected) {
        injected = true;
        expect(db.setProcessGroup(cardId, ownerRunId, 999)).toBe(true);
      }
      return owned(cardId, ownerRunId, mutation);
    }) as LeaseDb["withOwnedLease"];

    const report = await tick(store, db, {
      ...defaultConfig(root), staleSeconds: -1, maxRunning: 0,
    });
    expect(report.reclaimed).not.toContain(card.id);
    expect(report.skipped).toContainEqual({
      cardId: card.id,
      reason: "worker process group registered during recovery; lease retained",
    });
    expect(db.lease(card.id)?.pgid).toBe(999);
    expect(store.requireById(card.id).status).toBe("running");
    db.close();
  });

  test("an unconfirmed runner shutdown retains its lease", async () => {
    seedRoles(root);
    const card = store.create({ title: "timeout survivor", role: "backend", status: "ready" });
    const db = new LeaseDb(root);
    const report = await tick(store, db, defaultConfig(root), {
      runner: async () => { throw new ProcessGroupTerminationError(999); },
    });
    expect(report.started).toContain(card.id);
    expect(db.lease(card.id)).not.toBeNull();
    expect(store.requireById(card.id).status).toBe("running");
    db.close();
  });
});

describe("cross-process capacity and owner fencing", () => {
  test("simultaneous dispatcher processes cannot exceed global or per-role caps", async () => {
    const base = { pid: null };
    const global = await concurrentClaims([
      { ...base, cardId: "c_global_a", owner: "dispatcher-a", role: "backend", maxRunning: 1, maxRunningPerRole: 1 },
      { ...base, cardId: "c_global_b", owner: "dispatcher-b", role: "qa", maxRunning: 1, maxRunningPerRole: 1 },
    ]);
    expect(global.filter(Boolean)).toHaveLength(1);

    const db = new LeaseDb(root);
    for (const lease of db.activeLeases()) db.release(lease.cardId, lease.runId);
    db.close();

    const perRole = await concurrentClaims([
      { ...base, cardId: "c_role_a", owner: "dispatcher-a", role: "backend", maxRunning: 2, maxRunningPerRole: 1 },
      { ...base, cardId: "c_role_b", owner: "dispatcher-b", role: "backend", maxRunning: 2, maxRunningPerRole: 1 },
    ]);
    expect(perRole.filter(Boolean)).toHaveLength(1);
  });

  test("two database handles cannot exceed global or per-role capacity", () => {
    const first = new LeaseDb(root);
    const second = new LeaseDb(root);
    const one = first.claimCapacity({
      cardId: "c_one", owner: "d1", role: "backend", pid: 1,
      maxRunning: 2, maxRunningPerRole: 1,
    });
    expect(one).not.toBeNull();
    expect(second.claimCapacity({
      cardId: "c_two", owner: "d2", role: "backend", pid: 2,
      maxRunning: 2, maxRunningPerRole: 1,
    })).toBeNull();
    expect(second.claimCapacity({
      cardId: "c_three", owner: "d2", role: "qa", pid: 2,
      maxRunning: 1, maxRunningPerRole: 1,
    })).toBeNull();
    first.close();
    second.close();
  });

  test("a superseded run cannot heartbeat, mutate, or release its replacement", () => {
    const db = new LeaseDb(root);
    const old = db.claim("c_card", "old", 1, "backend");
    expect(old).not.toBeNull();
    expect(db.release("c_card", old as string)).toBe(true);
    const replacement = db.claim("c_card", "new", 2, "backend");
    expect(replacement).not.toBeNull();
    let mutated = false;
    expect(db.heartbeat("c_card", old as string)).toBe(false);
    expect(db.withOwnedLease("c_card", old as string, () => { mutated = true; })).toBe(false);
    expect(mutated).toBe(false);
    expect(db.release("c_card", old as string)).toBe(false);
    expect(db.lease("c_card")?.runId).toBe(replacement as string);
    db.close();
  });

  test("a stale worker completion cannot overwrite or release its replacement", async () => {
    seedRoles(root);
    const card = store.create({
      title: "fenced worker",
      body: "prove replacement ownership",
      role: "backend",
      status: "ready",
    });
    const first = new LeaseDb(root);
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (result: RunnerOutput) => void;
    const gate = new Promise<RunnerOutput>((resolve) => { finish = resolve; });
    const oldTick = tick(store, first, defaultConfig(root), {
      owner: "old-dispatcher",
      runner: async () => {
        entered();
        return gate;
      },
    });
    await running;
    const oldLease = first.lease(card.id);
    expect(oldLease).not.toBeNull();
    expect(first.release(card.id, oldLease?.runId)).toBe(true);
    const replacementDb = new LeaseDb(root);
    const replacement = replacementDb.claim(card.id, "replacement", 2, "backend");
    expect(replacement).not.toBeNull();
    finish({
      ok: true, text: "stale done", handoff: "stale handoff", blocked: null,
      sessionId: "stale-session", usd: 0.1, tokens: 10, turns: 1, error: null,
    });
    await oldTick;
    expect(store.requireById(card.id)).toMatchObject({
      status: "running",
      handoff: null,
      sessionId: null,
    });
    expect(replacementDb.lease(card.id)?.runId).toBe(replacement as string);
    expect(replacementDb.spentOnCard(card.id)).toBe(0);
    replacementDb.release(card.id, replacement as string);
    replacementDb.close();
    first.close();
  });

  test("failed workspace setup and runner crashes release leases without recording usage", async () => {
    seedRoles(root);
    const brokenWorkspace = store.create({
      title: "bad workspace", body: "must not launch", role: "backend",
      status: "ready", workspace: "worktree",
    });
    const db = new LeaseDb(root);
    let launched = false;
    await tick(store, db, { ...defaultConfig(root), workdir: join(root, "not-a-repository") }, {
      runner: async () => {
        launched = true;
        throw new Error("must not launch");
      },
    });
    expect(launched).toBe(false);
    expect(db.lease(brokenWorkspace.id)).toBeNull();

    const crash = store.create({
      title: "runner crash", body: "throw deterministically", role: "qa", status: "ready",
    });
    await tick(store, db, defaultConfig(root), {
      runner: async () => { throw new Error("deterministic crash"); },
    });
    expect(db.spentOnCard(crash.id)).toBe(0);
    expect(db.lease(crash.id)).toBeNull();
    db.close();
  });

  test("triage has one durable claim and an idempotent stored result", () => {
    const first = new LeaseDb(root);
    const second = new LeaseDb(root);
    const claim = first.claimTriage("c_triage", "cli");
    expect(claim).not.toBeNull();
    expect(second.claimTriage("c_triage", "daemon")).toBeNull();
    expect(first.finishTriage("c_triage", claim as string, { ok: true, created: ["c_child"] })).toBe(true);
    expect(second.triageState("c_triage")).toEqual({
      state: "done",
      result: { ok: true, created: ["c_child"] },
    });
    first.close();
    second.close();
  });

  test("triage ownership blocks edits and stale promise output is revision-fenced", async () => {
    const card = store.create({ title: "original", body: "keep me" });
    const db = new LeaseDb(root);
    const expectedRevision = cardRevision(card);
    const claim = db.claimTriage(card.id, "triager", card.updatedAt);

    let release!: () => void;
    const interrupted = new Promise<void>((resolve) => { release = resolve; });
    const completion = (async () => {
      await interrupted;
      return db.completeTriage(
        card.id,
        claim as string,
        { kind: "triage:test", usd: 0.2, tokens: 20 },
        () => store.update(card.id, { title: "stale model", status: "ready" }),
        () => cardRevision(store.requireById(card.id)) === expectedRevision
          && store.requireById(card.id).status === "triage",
      );
    })();

    const rejected = db.mutateUnleased(card.id, () => store.update(card.id, { title: "user edit" }));
    expect(rejected.ok).toBe(false);
    store.update(card.id, { title: "direct replacement" });
    release();
    expect(await completion).toBeNull();
    expect(store.requireById(card.id).title).toBe("direct replacement");
    expect(db.spentOnCard(card.id)).toBe(0.2);
    expect(db.hasActiveTriage(card.id)).toBe(false);
    db.close();
  });

  test("a restarted owner reclaims a stale triage claim", () => {
    const crashed = new LeaseDb(root);
    const restarted = new LeaseDb(root);
    const oldClaim = crashed.claimTriage("c_restart", "old-process", "same-input", 60, 100);
    expect(oldClaim).not.toBeNull();

    expect(restarted.claimTriage("c_restart", "competitor", "same-input", 60, 160)).toBeNull();
    const replacement = restarted.claimTriage("c_restart", "restarted", "same-input", 60, 161);
    expect(replacement).not.toBeNull();

    let staleMutation = false;
    expect(crashed.completeTriage(
      "c_restart",
      oldClaim as string,
      { kind: "triage:old", usd: 0.4, tokens: 40 },
      () => { staleMutation = true; return { ok: true, owner: "old" }; },
    )).toBeNull();
    expect(staleMutation).toBe(false);
    expect(crashed.spentOnCard("c_restart")).toBe(0);
    expect(crashed.heartbeatTriage("c_restart", oldClaim as string, 200)).toBe(false);
    expect(crashed.finishTriage("c_restart", oldClaim as string, { ok: true, owner: "old" })).toBe(false);
    expect(crashed.releaseTriage("c_restart", oldClaim as string)).toBe(false);

    let replacementMutations = 0;
    expect(restarted.completeTriage(
      "c_restart",
      replacement as string,
      { kind: "triage:new", usd: 0.2, tokens: 20 },
      () => {
        replacementMutations += 1;
        return { ok: true, owner: "restarted" };
      },
    )).toEqual({ ok: true, owner: "restarted" });
    expect(replacementMutations).toBe(1);
    expect(restarted.spentOnCard("c_restart")).toBe(0.2);
    expect(restarted.claimTriage("c_restart", "late", "same-input", 60, 500)).toBeNull();
    expect(restarted.triageState("c_restart")).toEqual({
      state: "done",
      result: { ok: true, owner: "restarted" },
    });
    crashed.close();
    restarted.close();
  });

  test("only the current triage owner can release a claim", () => {
    const db = new LeaseDb(root);
    const claim = db.claimTriage("c_release", "owner", "input", 60, 100);
    expect(db.releaseTriage("c_release", "t_not-owner")).toBe(false);
    expect(db.releaseTriage("c_release", claim as string)).toBe(true);
    expect(db.triageState("c_release")).toBeNull();
    db.close();
  });

  test("dispatcher restart reclaims stale triage without a second result", async () => {
    seedRoles(root);
    const card = store.create({ title: "resume abandoned triage" });
    const crashed = new LeaseDb(root);
    const oldClaim = crashed.claimTriage(card.id, "crashed", card.updatedAt, 60, 100);
    crashed.close();

    const restarted = new LeaseDb(root);
    const report = await tick(
      store,
      restarted,
      { ...defaultConfig(root), staleSeconds: 60, triageChain: [] },
      { owner: "restarted" },
    );
    expect(report.triaged).toEqual([{
      cardId: card.id,
      created: [],
      provider: "none",
      usd: 0,
      ok: false,
    }]);
    expect(restarted.triageState(card.id)?.state).toBe("done");
    expect(store.requireById(card.id).blockedReason).toBe("triage failed: no triage provider configured");
    restarted.close();
  });

  test("CLI, server, and daemon triage owners cannot duplicate one call", async () => {
    seedRoles(root);
    const card = store.create({ title: "triage once" });
    const config = { ...defaultConfig(root), triageChain: [] };
    const databases = [new LeaseDb(root), new LeaseDb(root), new LeaseDb(root)];
    const outcomes = await Promise.all(
      ["cli", "server", "daemon"].map((owner, index) =>
        triageCard(store, databases[index] as LeaseDb, config, loadRoles(root), card, { owner }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.error === "triage already in progress")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.error === "no triage provider configured")).toHaveLength(1);
    expect(databases[0]?.triageState(card.id)?.state).toBe("done");
    for (const db of databases) db.close();
  });
});

describe("malformed persisted cards", () => {
  test("malformed hand-edited role contracts quarantine cards assigned to them", () => {
    seedRoles(root);
    writeFileSync(
      join(root, "board", "roles", "backend", "SOUL.md"),
      "---\nname: backend\ndescription: broken\nruntime: shell\nmax_turns: 1.5\n---\nunsafe",
      "utf8",
    );
    const card = store.create({ title: "unsafe role", role: "backend", status: "ready" });
    const reloaded = store.requireById(card.id);
    expect(reloaded.status).toBe("blocked");
    expect(reloaded.invalidReason).toContain("unknown role backend");
  });

  test("invalid status/runtime/workspace/numbers are quarantined before dispatch", async () => {
    seedRoles(root);
    writeFileSync(
      join(store.cardsDir, "bad.md"),
      "---\nid: c_bad\ntitle: bad\nstatus: scheduled\nrole: backend\nruntime: shell\nworkspace: host\nmax_turns: 1.5\n---\nunsafe",
      "utf8",
    );
    const card = store.requireById("c_bad");
    expect(card.status).toBe("blocked");
    expect(card.invalidReason).toContain("status");
    expect(card.invalidReason).toContain("runtime");
    expect(card.invalidReason).toContain("workspace");
    expect(card.invalidReason).toContain("max_turns");
    const db = new LeaseDb(root);
    const report = await tick(store, db, defaultConfig(root), {
      runner: async () => { throw new Error("must not launch"); },
    });
    expect(report.started).not.toContain("c_bad");
    expect(db.lease("c_bad")).toBeNull();
    db.close();
  });
});

describe("execution limits", () => {
  test("card override beats the board default for the turn cap", () => {
    const config = defaultConfig(root);
    const card = store.create({ title: "t", maxTurns: 3 });
    expect(limits.turnCap(card, config)).toBe(3);
    expect(limits.turnCap(store.create({ title: "u" }), config)).toBe(config.maxTurns);
  });
});

describe("context packs", () => {
  test("ancestry walks from the card up to the root goal", () => {
    const root1 = store.create({ title: "mission" });
    const mid = store.create({ title: "middle", parents: [root1.id], root: root1.id });
    const leaf = store.create({ title: "leaf", parents: [mid.id], root: root1.id });
    const chain = ancestry(leaf, cardsById(store.list()));
    expect(chain.map((card) => card.title)).toEqual(["mission", "middle"]);
  });

  test("a cycle cannot hang the walk", () => {
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b", parents: [a.id] });
    store.update(a.id, { parents: [b.id] });
    expect(ancestry(store.requireById(b.id), cardsById(store.list())).length).toBeLessThanOrEqual(2);
  });

  test("parent handoffs are clipped to the configured budget", () => {
    const config = { ...defaultConfig(root), context: { ...defaultConfig(root).context, handoffChars: 20 } };
    const parent = store.create({ title: "p" });
    store.update(parent.id, { status: "done", handoff: "x".repeat(500) });
    const child = store.create({ title: "c", parents: [parent.id] });
    const pack = parentHandoffs(child, cardsById(store.list()), config);
    expect(pack.length).toBeLessThan(120);
    expect(pack).toContain("…");
  });

  test("worker prompt carries spec, mission and the read-only rule", () => {
    const config = defaultConfig(root);
    seedRoles(root);
    const reviewer = loadRoles(root).find((role) => role.name === "reviewer") ?? null;
    const mission = store.create({ title: "ship the thing" });
    const card = store.create({ title: "review it", body: "**Goal** review", parents: [mission.id], root: mission.id });
    const { system, prompt } = workerPrompt(card, reviewer, cardsById(store.list()), config);
    expect(system).toContain("independent reviewer");
    expect(prompt).toContain("ship the thing");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("HANDOFF");
  });

  test("an oversized body is truncated to the cap", () => {
    const config = { ...defaultConfig(root), context: { ...defaultConfig(root).context, bodyChars: 50 } };
    const card = store.create({ title: "t", body: "y".repeat(5000) });
    const { prompt } = workerPrompt(card, null, cardsById(store.list()), config);
    expect(prompt.length).toBeLessThan(700);
  });
});

describe("handoff extraction", () => {
  test("takes at most six lines after the marker", () => {
    const handoff = extractHandoff("work log\nHANDOFF\n- a\n- b\n- c\n- d\n- e\n- f\n- g");
    expect(handoff?.split("\n")).toHaveLength(6);
  });

  test("normalises literal backslash-n that models emit", () => {
    expect(extractHandoff("HANDOFF\\n- one\\n- two")).toBe("- one\n- two");
  });

  test("the LAST marker wins so narration is not captured", () => {
    const output = [
      "I will finish with a HANDOFF block once tests pass.",
      "ran the tests",
      "HANDOFF",
      "- added GET /health",
      "- bun test 1/1",
    ].join("\n");
    expect(extractHandoff(output)).toBe("- added GET /health\n- bun test 1/1");
  });

  test("no marker means no handoff", () => {
    expect(extractHandoff("just some output")).toBeNull();
  });

  test("BLOCKED is read as an honest stop", () => {
    expect(extractBlocked("tried things\nBLOCKED: need the API key")).toBe("need the API key");
    expect(extractBlocked("all good")).toBeNull();
  });
});

describe("workspace enforcement", () => {
  test("repo is the default and points at the checkout", async () => {
    const card = store.create({ title: "t" });
    expect(card.workspace).toBe("repo");
    const resolved = await resolveWorkspace(root, "/some/repo", card);
    expect(resolved.cwd).toBe("/some/repo");
    expect(resolved.note).toContain("project checkout");
  });

  test("scratch really is outside the repo", async () => {
    const card = store.create({ title: "t", workspace: "scratch" });
    const resolved = await resolveWorkspace(root, "/some/repo", card);
    expect(resolved.cwd).not.toBe("/some/repo");
    expect(resolved.cwd).toContain("scratch");
    expect(resolved.note).toContain("NOT in the project repo");
    expect(existsSync(resolved.cwd)).toBe(true);
  });

  test("worktree creates a branch-isolated checkout", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await Bun.spawn(["git", "init", "-q", "."], { cwd: repo }).exited;
    await Bun.write(join(repo, "README.md"), "# demo\n");
    await Bun.spawn(["git", "add", "-A"], { cwd: repo }).exited;
    await Bun.spawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    }).exited;

    const card = store.create({ title: "t", workspace: "worktree" });
    const resolved = await resolveWorkspace(root, repo, card);
    expect(resolved.branch).toBe(`ab/${card.id.replace("c_", "")}`);
    expect(existsSync(join(resolved.cwd, "README.md"))).toBe(true);
    expect(resolved.cwd).not.toBe(repo);
  });

  test("preview mode creates nothing on disk", async () => {
    const scratchCard = store.create({ title: "t", workspace: "scratch" });
    const preview = await resolveWorkspace(root, "/some/repo", scratchCard, { create: false });
    expect(existsSync(preview.cwd)).toBe(false);
    expect(preview.note).toContain("NOT in the project repo");

    const worktreeCard = store.create({ title: "t", workspace: "worktree" });
    const wtPreview = await resolveWorkspace(root, join(root, "not-a-repo"), worktreeCard, { create: false });
    expect(wtPreview.branch).toBe(`ab/${worktreeCard.id.replace("c_", "")}`);
    expect(existsSync(wtPreview.cwd)).toBe(false);
  });

  test("a worktree request against a non-repo fails loudly", async () => {
    const card = store.create({ title: "t", workspace: "worktree" });
    await expect(resolveWorkspace(root, join(root, "not-a-repo"), card)).rejects.toThrow(/worktree/);
  });
});

describe("dispatcher scheduling", () => {
  const cardWith = (over: Partial<Card>): Card => ({
    id: "c_x",
    path: "/dev/null",
    title: "t",
    body: "",
    status: "ready",
    role: "backend",
    runtime: "codex",
    model: null,
    parents: [],
    root: null,
    handoff: null,
    skills: [],
    workspace: "scratch",
    maxTurns: null,
    goal: false,
    priority: 0,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    blockedReason: null,
    sessionId: null,
    ...over,
  });

  test("a card waits while any parent is open", () => {
    const parent = cardWith({ id: "c_p", status: "running" });
    const child = cardWith({ id: "c_c", parents: ["c_p"] });
    const all = cardsById([parent, child]);
    expect(parentsSatisfied(child, all)).toBe(false);
    expect(parentsSatisfied(cardWith({ parents: [] }), all)).toBe(true);
  });

  test("a done or archived parent unblocks the child", () => {
    for (const status of ["done", "archived"] as const) {
      const parent = cardWith({ id: "c_p", status });
      const child = cardWith({ id: "c_c", parents: ["c_p"] });
      expect(parentsSatisfied(child, cardsById([parent, child]))).toBe(true);
    }
  });

  test("a missing legacy parent remains gated", () => {
    const child = cardWith({ parents: ["c_ghost"] });
    expect(parentsSatisfied(child, cardsById([child]))).toBe(false);
  });

  test("maxRunning caps how many cards start", () => {
    const config = { ...defaultConfig(root), maxRunning: 2, maxRunningPerRole: 2 };
    const cards = [
      cardWith({ id: "c_1" }),
      cardWith({ id: "c_2" }),
      cardWith({ id: "c_3" }),
    ];
    expect(pickReady(cards, cardsById(cards), config, new Map())).toHaveLength(2);
  });

  test("one card per role by default", () => {
    const config = { ...defaultConfig(root), maxRunning: 3, maxRunningPerRole: 1 };
    const cards = [cardWith({ id: "c_1" }), cardWith({ id: "c_2" })];
    const picked = pickReady(cards, cardsById(cards), config, new Map());
    expect(picked).toHaveLength(1);
  });

  test("already-running work consumes the role slot", () => {
    const config = { ...defaultConfig(root), maxRunning: 3, maxRunningPerRole: 1 };
    const cards = [cardWith({ id: "c_1" })];
    expect(pickReady(cards, cardsById(cards), config, new Map([["backend", 1]]))).toHaveLength(0);
  });

  test("higher priority goes first", () => {
    const config = { ...defaultConfig(root), maxRunning: 1, maxRunningPerRole: 1 };
    const cards = [cardWith({ id: "c_low", priority: 0 }), cardWith({ id: "c_high", priority: 5 })];
    expect(pickReady(cards, cardsById(cards), config, new Map())[0]?.id).toBe("c_high");
  });
});

describe("dry-run tick", () => {
  test("reports promotions while leaving cards, leases, failures, and spend untouched", async () => {
    const db = new LeaseDb(root);
    seedRoles(root);
    const config = { ...defaultConfig(root), staleSeconds: -1 };
    const parent = store.create({ title: "p", role: "backend", status: "done" });
    const child = store.create({ title: "c", role: "docs", status: "todo", parents: [parent.id] });
    const idea = store.create({ title: "vague idea" });
    const running = store.create({ title: "running", role: "qa", status: "running" });
    db.claim(running.id, "quiet-worker");
    const before = store.list().map((card) => [card.id, card.status, card.updatedAt]);

    const report = await tick(store, db, config, { dryRun: true });
    expect(report.promoted).toContain(child.id);
    expect(report.reclaimed).toContain(running.id);
    expect(report.skipped.some((skip) => skip.cardId === idea.id)).toBe(true);
    expect(report.started).toHaveLength(0);
    expect(store.list().map((card) => [card.id, card.status, card.updatedAt])).toEqual(before);
    expect(db.lease(running.id)).not.toBeNull();
    expect(db.failureCount(running.id)).toBe(0);
    expect(db.spentToday()).toBe(0);
    db.close();
  });

});

describe("goal roots", () => {
  test("preview reports a completed graph root without mutating it", () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const config = defaultConfig(root);
    const leaf = store.create({ title: "leaf", role: "backend", status: "done" });
    const rootCard = store.create({ title: "goal", role: "orchestrator", status: "todo", parents: [leaf.id] });
    store.update(rootCard.id, { root: rootCard.id });

    const preview = dispatchPreview(store, db, config);
    expect(preview.promote).toContain(rootCard.id);
    expect(preview.start.some((item) => item.cardId === rootCard.id)).toBe(false);
    expect(store.byId(rootCard.id)?.status).toBe("todo");
    db.close();
  });

  test("preview includes an ordinary newly-unblocked card in start candidates", () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const parent = store.create({ title: "p", role: "backend", status: "done" });
    const child = store.create({ title: "c", role: "docs", status: "todo", parents: [parent.id] });
    const preview = dispatchPreview(store, db, defaultConfig(root));
    expect(preview.promote).toContain(child.id);
    expect(preview.start.some((item) => item.cardId === child.id)).toBe(true);
    expect(store.byId(child.id)?.status).toBe("todo");
    db.close();
  });
});

describe("domain invariants", () => {
  test("dependency edits reject missing ids, self edges, and cycles", () => {
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b", parents: [a.id] });
    expect(() => validateParents(store, ["c_missing"], b.id)).toThrow(/no such parent/);
    expect(() => validateParents(store, [b.id], b.id)).toThrow(/itself/);
    expect(() => validateParents(store, [b.id], a.id)).toThrow(/cycle/);
  });

  test("manual running and illegal transitions are rejected centrally", () => {
    const ready = store.create({ title: "ready", status: "ready" });
    expect(() => lifecycleActionForStatus(ready, "running")).toThrow(/lease-controlled/);
    expect(allowedLifecycleActions(ready, true)).toEqual([]);
    expect(() => lifecycleStatus(ready, "reopen", false)).toThrow(/not allowed/);
  });

  test("running without a lease is recovered before dispatch", async () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const card = store.create({ title: "orphan", role: "backend", status: "running" });
    const report = await tick(store, db, defaultConfig(root), {
      runner: async () => successfulRun({ handoff: "recovered safely" }),
    });
    expect(report.recovered).toContain(card.id);
    expect(report.started).toContain(card.id);
    expect(store.byId(card.id)?.status).toBe("review");
    db.close();
  });
});

describe("CLI mutation invariants", () => {
  const cli = async (...args: string[]) => {
    const process = Bun.spawn(["bun", join(import.meta.dir, "../bin/ab.ts"), ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  test("add/set reject invalid dependency, running, and lease mutations", async () => {
    seedRoles(root);
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
    const a = store.create({ title: "a", role: "backend", status: "ready" });
    const b = store.create({ title: "b", role: "backend", status: "todo", parents: [a.id] });

    expect((await cli("add", "bad", "--role", "backend", "--parent", "c_missing")).stderr).toContain("no such parent");
    expect((await cli("set", a.id, "--parent", b.id)).stderr).toContain("cycle");
    expect((await cli("set", a.id, "--status", "running")).stderr).toContain("lease-controlled");

    const db = new LeaseDb(root);
    db.claim(a.id, "active");
    const leased = await cli("set", a.id, "--priority", "4");
    expect(leased.exitCode).toBe(1);
    expect(leased.stderr).toContain("being worked");

    const triaging = store.create({ title: "triaging" });
    db.claimTriage(triaging.id, "active-triage", triaging.updatedAt);
    const triageEdit = await cli("set", triaging.id, "--title", "stale edit");
    expect(triageEdit.exitCode).toBe(1);
    expect(triageEdit.stderr).toContain("being worked");
    db.close();
  });

  test("log output bounds oversized single-line worker events", async () => {
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
    const card = store.create({ title: "large log", role: "reviewer", status: "ready" });
    writeFileSync(
      logPathFor(root, card.id),
      `${JSON.stringify({ type: "item.completed", output: "x".repeat(100_000) })}\nfinal verdict\n`,
      "utf8",
    );

    const result = await cli("log", card.id, "--tail", "40");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("chars omitted");
    expect(result.stdout).toContain("final verdict");
    expect(result.stdout.length).toBeLessThan(21_000);
  });
});

function successfulRun(overrides: Partial<RunnerOutput> = {}): RunnerOutput {
  return {
    ok: true,
    text: "completed",
    handoff: null,
    blocked: null,
    sessionId: "session-1",
    usd: 0,
    tokens: 10,
    turns: 1,
    error: null,
    ...overrides,
  };
}

describe("worker completion lifecycle", () => {
  test("successful implementation is review-gated even with a HANDOFF", async () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const role = loadRoles(root).find((candidate) => candidate.name === "backend");
    if (!role) throw new Error("backend role was not seeded");
    const card = store.create({
      title: "implement",
      role: "backend",
      status: "ready",
      skills: ["agent-board"],
    });
    let deliveredSystem = "";
    let deliveredSkills: string[] = [];
    await tick(store, db, defaultConfig(root), {
      runner: async (input) => {
        deliveredSystem = input.system;
        deliveredSkills = input.skills;
        return successfulRun({ handoff: "- changed code\n- tests pass" });
      },
    });
    expect(deliveredSystem).toBe(role.soul);
    expect(deliveredSkills).toEqual(["agent-board"]);
    expect(store.byId(card.id)?.status).toBe("review");
    expect(store.byId(card.id)?.handoff).toContain("tests pass");
    db.close();
  });

  test("a successful implementation without a HANDOFF cannot become done", async () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const card = store.create({ title: "implement", role: "backend", status: "ready" });
    await tick(store, db, defaultConfig(root), { runner: async () => successfulRun() });
    expect(store.byId(card.id)?.status).toBe("review");
    expect(store.byId(card.id)?.handoff).toBeNull();
    db.close();
  });

  test("read-only review completion may become done while BLOCKED stays first-class", async () => {
    seedRoles(root);
    const db = new LeaseDb(root);
    const review = store.create({ title: "review", role: "reviewer", status: "ready" });
    await tick(store, db, defaultConfig(root), {
      runner: async () => successfulRun({ text: "no blocking findings" }),
    });
    expect(store.byId(review.id)?.status).toBe("done");

    const blocked = store.create({ title: "blocked review", role: "reviewer", status: "ready" });
    await tick(store, db, defaultConfig(root), {
      runner: async () => successfulRun({ blocked: "missing immutable snapshot" }),
    });
    expect(store.byId(blocked.id)?.status).toBe("blocked");
    expect(store.byId(blocked.id)?.blockedReason).toBe("missing immutable snapshot");
    db.close();
  });
});

describe("runner argv", () => {
  const base = {
    model: "gpt-5.6-sol",
    system: "s",
    prompt: "p",
    cwd: "/repo",
    maxTurns: 6,
    skills: [] as string[],
    resumeSessionId: null,
    timeoutMs: 1000,
    logPath: "/dev/null",
  };

  test("codex writes in the workdir unless the role is read-only", () => {
    const write = previewArgv({ ...base, runtime: "codex", readOnly: false });
    expect(write).toContain("workspace-write");
    expect(write).toContain("-C");
    const read = previewArgv({ ...base, runtime: "codex", readOnly: true });
    expect(read).toContain("read-only");
  });

  test("codex resume keeps global sandbox, cwd, and complete SOUL before exec", () => {
    const soul = "role line\n".repeat(1_000);
    const argv = previewArgv({ ...base, runtime: "codex", readOnly: false, resumeSessionId: "thread-1" });
    const withSoul = previewArgv({
      ...base,
      runtime: "codex",
      readOnly: true,
      system: soul,
      resumeSessionId: "thread-1",
    });
    expect(argv.slice(argv.indexOf("exec"), argv.indexOf("exec") + 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(withSoul.slice(0, 5)).toEqual(["codex", "-s", "read-only", "-C", "/repo"]);
    const configValue = withSoul[withSoul.indexOf("-c") + 1] ?? "";
    expect(JSON.parse(configValue.replace("developer_instructions=", ""))).toBe(soul);
  });

  test("read-only claude gets no write tools", () => {
    const argv = previewArgv({ ...base, runtime: "claude", readOnly: true });
    expect(argv.join(" ")).toContain("--allowedTools Read,Grep,Glob,WebFetch,WebSearch");
    expect(argv.join(" ")).not.toContain("acceptEdits");
  });

  test("the turn cap is passed to claude", () => {
    expect(previewArgv({ ...base, runtime: "claude", readOnly: false })).toContain("6");
  });

  test("the claude argv carries the complete soul and a resumable session", () => {
    const argv = previewArgv({
      ...base,
      runtime: "claude",
      readOnly: false,
      system: "you are the reviewer",
      resumeSessionId: "sess-1",
      skills: ["claude-code"],
    });
    const line = argv.join(" ");
    expect(line).toContain("--append-system-prompt you are the reviewer");
    expect(line).toContain("--resume sess-1");
    expect(line).not.toContain("--no-session-persistence");
    expect(line).not.toContain("--skill");
  });

  test("forced skills are additive and use each runtime's prompt trigger", () => {
    expect(effectiveSkills(["card-skill", "shared"], ["role-skill", "shared"])).toEqual([
      "role-skill",
      "shared",
      "card-skill",
    ]);
    expect(promptWithSkills("work", ["agent-board"], "codex")).toContain("$agent-board");
    expect(promptWithSkills("work", ["agent-board"], "claude")).toStartWith("/agent-board");
  });

  test("preview and spawn share one builder per runtime", () => {
    const input = { ...base, runtime: "codex" as const, readOnly: true };
    expect(previewArgv(input)).toEqual(codexArgv(input));
    const claudeInput = { ...base, runtime: "claude" as const, readOnly: true };
    expect(previewArgv(claudeInput)).toEqual(claudeArgv(claudeInput));
  });
});

describe("attach", () => {
  test("resumes the recorded session by default", () => {
    seedRoles(root);
    const config = defaultConfig(root);
    const card = store.create({ title: "t", role: "backend", runtime: "codex" });
    const withSession = store.update(card.id, { sessionId: "thread-9" });
    const plan = attachPlan(withSession, null, config, {});
    const resumeAt = plan.argv.indexOf("resume");
    expect(plan.argv.slice(resumeAt, resumeAt + 2)).toEqual(["resume", "thread-9"]);
    expect(plan.note).toContain("resuming");
  });

  test("--fresh ignores the session and seeds the prompt", () => {
    const config = defaultConfig(root);
    const card = store.update(store.create({ title: "t", runtime: "claude" }).id, { sessionId: "s1" });
    const plan = attachPlan(card, null, config, { fresh: true, prompt: "do the thing" });
    expect(plan.argv).not.toContain("--resume");
    expect(plan.argv).toContain("do the thing");
  });

  test("a read-only role stays read-only in its resolved scratch workspace for both CLIs", async () => {
    seedRoles(root);
    const reviewer = loadRoles(root).find((role) => role.name === "reviewer") ?? null;
    const card = store.create({ title: "t", workspace: "scratch" });
    const workspace = await resolveWorkspace(root, "/repo", card);
    const claude = attachPlan({ ...card, runtime: "claude" }, reviewer, defaultConfig(root), {
      cwd: workspace.cwd,
    });
    expect(claude.cwd).toBe(workspace.cwd);
    expect(claude.argv.join(" ")).toContain("--allowedTools");
    expect(claude.argv.join(" ")).not.toContain("--add-dir");

    const codex = attachPlan({ ...card, runtime: "codex" }, reviewer, defaultConfig(root), {
      cwd: workspace.cwd,
    });
    expect(codex.argv.slice(0, 5)).toEqual(["codex", "-s", "read-only", "-C", workspace.cwd]);
  });

  test("fresh attach receives the same bounded role-aware prompt and forced skills", async () => {
    seedRoles(root);
    const config = {
      ...defaultConfig(root),
      context: { ...defaultConfig(root).context, bodyChars: 40 },
    };
    const role = loadRoles(root).find((candidate) => candidate.name === "backend") ?? null;
    const card = store.create({
      title: "implement",
      body: `acceptance ${"x".repeat(500)}`,
      role: "backend",
      runtime: "codex",
      skills: ["agent-board"],
      workspace: "scratch",
    });
    const workspace = await resolveWorkspace(root, config.workdir, card);
    const context = workerPrompt(card, role, cardsById(store.list()), config, workspace.note);
    const plan = attachPlan(card, role, config, {
      fresh: true,
      prompt: context.prompt,
      system: context.system,
      skills: effectiveSkills(card.skills, role?.skills ?? []),
      cwd: workspace.cwd,
    });
    const line = plan.argv.join("\n");
    const configValue = plan.argv[plan.argv.indexOf("-c") + 1] ?? "";
    expect(JSON.parse(configValue.replace("developer_instructions=", ""))).toBe(role?.soul);
    expect(line).toContain("$agent-board");
    expect(line).toContain("acceptance");
    expect(line).toContain("Scratch workspace");
    expect(line).not.toContain("x".repeat(100));
  });
});

describe("archive", () => {
  test("archiving relocates the card out of the live board and reopening brings it back", () => {
    const card = store.create({ title: "shipped", role: null, status: "done" });
    const livePath = card.path;
    expect(livePath.includes(join("board", "cards"))).toBe(true);

    const archived = store.update(card.id, { status: "archived" });
    expect(archived.path.includes(join("board", "archive"))).toBe(true);
    expect(existsSync(livePath)).toBe(false);
    expect(existsSync(archived.path)).toBe(true);
    expect(store.list().map((entry) => entry.id)).not.toContain(card.id);
    expect(store.listArchived().map((entry) => entry.id)).toEqual([card.id]);
    expect(store.listAll().map((entry) => entry.id)).toEqual([card.id]);
    expect(store.byId(card.id)?.status).toBe("archived");
    expect(store.byId(card.id.replace(/^c_/, ""))?.id).toBe(card.id);

    const reopened = store.update(card.id, { status: "ready" });
    expect(reopened.path).toBe(livePath);
    expect(existsSync(archived.path)).toBe(false);
    expect(store.listArchived()).toHaveLength(0);
    expect(store.list().map((entry) => entry.id)).toEqual([card.id]);
  });

  test("an archived card left in cards/ by an older board still reads as archived", () => {
    const legacy = store.create({ title: "legacy", status: "done" });
    writeFileSync(legacy.path, readFileSync(legacy.path, "utf8").replace("status: done", "status: archived"), "utf8");
    expect(store.listArchived().map((entry) => entry.id)).toEqual([legacy.id]);
    // The next mutation relocates it without any migration step.
    store.update(legacy.id, { priority: 1 });
    expect(store.listArchived()[0]?.path.includes(join("board", "archive"))).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  test("an archived parent still unblocks its child through the store, not just a hand-built map", async () => {
    seedRoles(root);
    const parent = store.create({ title: "parent", role: "backend", status: "done" });
    const child = store.create({ title: "child", role: "backend", status: "todo", parents: [parent.id] });
    store.update(parent.id, { status: "archived" });

    expect(parentsSatisfied(store.requireById(child.id), cardsById(store.listAll()))).toBe(true);
    const db = new LeaseDb(root);
    expect(dispatchPreview(store, db, defaultConfig(root)).promote).toContain(child.id);
    const report = await tick(store, db, defaultConfig(root), {
      runner: async () => successfulRun({ handoff: "child finished" }),
    });
    expect(report.promoted).toContain(child.id);
    expect(store.byId(child.id)?.status).not.toBe("todo");
    db.close();
  });

  test("an archived card stays addressable as a dependency", () => {
    const parent = store.create({ title: "parent", status: "done" });
    store.update(parent.id, { status: "archived" });
    const child = store.create({ title: "child" });
    expect(validateParents(store, [parent.id], child.id)).toEqual([parent.id]);
  });

  test("archive is a terminal state that only reopen leaves", () => {
    const card = store.create({ title: "shipped", status: "done" });
    const archived = store.update(card.id, { status: "archived" });
    expect(allowedLifecycleActions(archived, false)).toEqual(["reopen"]);
    expect(lifecycleStatus(archived, "reopen", false)).toBe("ready");
    expect(() => lifecycleStatus(archived, "archive", false)).toThrow("not allowed");
  });
});

describe("ab archive", () => {
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../bin/ab.ts"), ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  beforeEach(() => {
    seedRoles(root);
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
  });

  test("a named card archives immediately and shows up in --list", async () => {
    const card = store.create({ title: "shipped", role: "backend", status: "done" });
    const run = await cli("archive", card.id);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("1 archived");
    expect(store.byId(card.id)?.status).toBe("archived");
    expect((await cli("archive", "--list")).stdout).toContain("ARCHIVED (1)");
  });

  test("a --done sweep only previews until --yes", async () => {
    const done = store.create({ title: "shipped", role: "backend", status: "done" });
    const open = store.create({ title: "in flight", role: "backend", status: "ready" });

    const preview = await cli("archive", "--done");
    expect(preview.stdout).toContain("would archive 1 done card(s)");
    expect(preview.stdout).toContain("--yes");
    expect(store.byId(done.id)?.status).toBe("done");

    const applied = await cli("archive", "--done", "--yes");
    expect(applied.stdout).toContain("1 archived, 0 skipped");
    expect(store.byId(done.id)?.status).toBe("archived");
    expect(store.byId(open.id)?.status).toBe("ready");
  });

  test("--older-than keeps recently finished work on the board", async () => {
    const card = store.create({ title: "shipped", role: "backend", status: "done" });
    const fresh = await cli("archive", "--done", "--older-than", "7d", "--yes");
    expect(fresh.stdout).toContain("nothing to archive");
    expect(store.byId(card.id)?.status).toBe("done");

    const path = store.requireById(card.id).path;
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    writeFileSync(path, readFileSync(path, "utf8").replace(/^updated_at: .*$/m, `updated_at: ${old}`), "utf8");
    expect((await cli("archive", "--done", "--older-than", "7d", "--yes")).stdout).toContain("1 archived");
    expect(store.byId(card.id)?.status).toBe("archived");

    expect((await cli("archive", "--done", "--older-than", "soon", "--yes")).stderr).toContain("expects a duration");
  });

  test("leased and running cards are never archived out from under a worker", async () => {
    const running = store.create({ title: "in flight", role: "backend", status: "running" });
    const leased = store.create({ title: "held", role: "backend", status: "done" });
    const db = new LeaseDb(root);
    db.claim(leased.id, "active-run");

    const blockedRun = await cli("archive", running.id);
    expect(blockedRun.exitCode).toBe(1);
    expect(blockedRun.stderr).toContain("not allowed from running");

    const blockedLease = await cli("archive", leased.id);
    expect(blockedLease.exitCode).toBe(1);
    expect(blockedLease.stderr).toContain("being worked");
    expect(store.byId(leased.id)?.status).toBe("done");
    db.close();
  });

  test("an empty invocation explains the two supported shapes", async () => {
    const run = await cli("archive");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("ab archive --done");
  });
});

describe("triage confidence gate", () => {
  /** A local OpenAI-compatible stub, so the plan under test is exact and free. */
  function stubProvider(plan: unknown): { config: BoardConfig; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const config: BoardConfig = {
      ...defaultConfig(root),
      triageChain: [{ kind: "local", model: "stub", baseUrl: `${server.url}v1` }],
    };
    return { config, stop: () => void server.stop(true) };
  }

  const plan = (confidence: number, cards: unknown[]) => ({
    fanout: cards.length > 1,
    confidence,
    rationale: "stubbed rationale",
    cards,
  });
  const card = (title: string, role: string, parents: number[] = []) => ({
    title, body: `**Goal** ${title}`, role, parents,
  });

  test("a plan the model does not believe is parked, not dispatched", async () => {
    seedRoles(root);
    const target = store.create({ title: "make the app better", body: "original note" });
    const { config, stop } = stubProvider(plan(0.42, [
      card("Audit the onboarding flow", "designer"),
      card("Fix what the audit found", "frontend", [0]),
    ]));
    const db = new LeaseDb(root);
    try {
      const outcome = await triageCard(store, db, config, loadRoles(root), target);
      expect(outcome.ok).toBe(true);
      expect(outcome.parked).toBe(true);
      expect(outcome.created).toEqual([]);

      const parked = store.requireById(target.id);
      expect(parked.status).toBe("blocked");
      expect(parked.blockedReason).toContain("low triage confidence 0.42 < 0.60");
      expect(parked.title).toBe("make the app better");
      // The proposal survives so the human can accept it by hand.
      expect(parked.body).toContain("original note");
      expect(parked.body).toContain("[designer] Audit the onboarding flow");
      expect(parked.body).toContain("[frontend] Fix what the audit found (after #1)");
      // Nothing else was created, and nothing is dispatchable.
      expect(store.list()).toHaveLength(1);
      expect(dispatchPreview(store, db, config).start).toEqual([]);
    } finally {
      db.close();
      stop();
    }
  });

  test("a confident plan still fans out", async () => {
    seedRoles(root);
    const target = store.create({ title: "ship SSO" });
    const { config, stop } = stubProvider(plan(0.93, [
      card("Implement the SSO backend", "backend"),
      card("Document SSO", "docs", [0]),
    ]));
    const db = new LeaseDb(root);
    try {
      const outcome = await triageCard(store, db, config, loadRoles(root), target);
      expect(outcome.parked).toBeUndefined();
      expect(outcome.created).toHaveLength(2);
      expect(store.requireById(target.id).status).toBe("todo");
    } finally {
      db.close();
      stop();
    }
  });

  test("the bar is configurable and the CLI flag overrides it", async () => {
    seedRoles(root);
    const lenient = store.create({ title: "vague but accepted" });
    const { config, stop } = stubProvider(plan(0.42, [card("Do the vague thing", "generalist")]));
    const db = new LeaseDb(root);
    try {
      const outcome = await triageCard(store, db, { ...config, triageMinConfidence: 0.3 }, loadRoles(root), lenient);
      expect(outcome.parked).toBeUndefined();
      expect(store.requireById(lenient.id).status).toBe("ready");

      const strict = store.create({ title: "confident but held" });
      const held = await triageCard(store, db, config, loadRoles(root), strict, { minConfidence: 0.95 });
      expect(held.parked).toBe(true);
      expect(store.requireById(strict.id).status).toBe("blocked");
    } finally {
      db.close();
      stop();
    }
  });

  test("a single card inherits its role's turn ceiling and skills", async () => {
    seedRoles(root);
    mkdirSync(join(root, "board", "roles", "cheap"), { recursive: true });
    writeFileSync(
      join(root, "board", "roles", "cheap", "SOUL.md"),
      [
        "---",
        "name: cheap",
        "description: A deliberately capped role used to prove role settings reach single cards.",
        "runtime: codex",
        "max_turns: 3",
        "skills:",
        "  - defuddle",
        "---",
        "",
        "Role: frugal worker.",
        "",
      ].join("\n"),
      "utf8",
    );
    const target = store.create({ title: "one capped unit" });
    const { config, stop } = stubProvider(plan(0.9, [card("Do the capped thing", "cheap")]));
    const db = new LeaseDb(root);
    try {
      await triageCard(store, db, config, loadRoles(root), target);
      const routed = store.requireById(target.id);
      expect(routed.role).toBe("cheap");
      expect(routed.status).toBe("ready");
      expect(routed.maxTurns).toBe(3);
      expect(routed.skills).toEqual(["defuddle"]);
    } finally {
      db.close();
      stop();
    }
  });
});

describe("role inspection", () => {
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../bin/ab.ts"), ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  test("a rejected soul reports why instead of vanishing quietly", async () => {
    seedRoles(root);
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
    const soul = join(root, "board", "roles", "reviewer", "SOUL.md");
    writeFileSync(soul, readFileSync(soul, "utf8").replace("runtime: claude", "runtime: cluade"), "utf8");

    const inspection = inspectRoles(root);
    expect(inspection.roles.some((role) => role.name === "reviewer")).toBe(false);
    expect(inspection.rejected).toHaveLength(1);
    expect(inspection.rejected[0]?.name).toBe("reviewer");
    expect(inspection.rejected[0]?.problems.join(" ")).toContain("runtime: must be one of");
    expect(loadRoles(root)).toHaveLength(inspection.roles.length);

    const roles = await cli("roles");
    expect(roles.exitCode).toBe(1);
    expect(roles.stderr).toContain("reviewer is NOT loaded");
    expect(roles.stderr).toContain("runtime: must be one of");

    const doctor = await cli("doctor");
    expect(doctor.stdout).toContain("REJECTED");
    expect(doctor.stdout).toContain("ab roles --reseed --yes");
  });

  test("--reseed previews before it overwrites, and restores the shipped soul", async () => {
    seedRoles(root);
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
    expect((await cli("roles", "--reseed")).stdout).toContain("already matches this version");

    const soul = join(root, "board", "roles", "researcher", "SOUL.md");
    writeFileSync(soul, readFileSync(soul, "utf8").replace("description:", "description: STALE"), "utf8");

    const preview = await cli("roles", "--reseed");
    expect(preview.stdout).toContain("researcher");
    expect(preview.stdout).toContain("--yes");
    expect(readFileSync(soul, "utf8")).toContain("STALE");

    expect((await cli("roles", "--reseed", "--yes")).stdout).toContain("reseeded researcher");
    expect(readFileSync(soul, "utf8")).not.toContain("STALE");
    expect(loadRoles(root).find((role) => role.name === "researcher")?.readOnly).toBe(true);
  });

  test("the roster keeps the vocabulary that routes judgement work away from implementers", () => {
    seedRoles(root);
    const roles = loadRoles(root);
    const reviewer = roles.find((role) => role.name === "reviewer");
    const researcher = roles.find((role) => role.name === "researcher");
    // Live routing sent "review MR !442" to backend and "Temporal vs Airflow" to
    // devops until these trigger words were in the descriptions.
    for (const token of ["MR", "PR", "diff", "audit", "merge"]) {
      expect(reviewer?.description, token).toContain(token);
    }
    for (const token of ["vs", "compar", "recommendation"]) {
      expect(researcher?.description, token).toContain(token);
    }
    expect(reviewer?.readOnly).toBe(true);
    expect(researcher?.readOnly).toBe(true);
    // The implementers have to point at the owner instead of absorbing the work.
    expect(roles.find((role) => role.name === "backend")?.description).toContain("reviewer");
    expect(roles.find((role) => role.name === "devops")?.description).toContain("researcher");
    // And the triage prompt must keep treating a standalone judgement card as valid.
    const prompt = readFileSync(join(import.meta.dir, "../src/triage.ts"), "utf8");
    expect(prompt).toContain("standalone review, audit, or research card");
  });
});

describe("session portability across runtimes", () => {
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../bin/ab.ts"), ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  test("a session only survives while the runtime that made it stays", () => {
    const codexCard = { ...store.create({ title: "t", runtime: "codex" }), sessionId: "codex-thread" };
    expect(sessionSurvivesRuntime(codexCard, "codex")).toBe(true);
    expect(sessionSurvivesRuntime(codexCard, undefined)).toBe(true);
    expect(sessionSurvivesRuntime(codexCard, "claude")).toBe(false);
    expect(sessionSurvivesRuntime(codexCard, "local")).toBe(false);
    // Nothing to lose without a session.
    expect(sessionSurvivesRuntime({ ...codexCard, sessionId: null }, "claude")).toBe(true);
  });

  test("reassigning the role drops the session the other CLI cannot resume", async () => {
    seedRoles(root);
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
    const card = store.create({ title: "review the payments MR", role: "backend", runtime: "codex" });
    store.update(card.id, { sessionId: "019b2f77-codex-thread" });

    // reviewer runs on claude, so `ab set --role` flips the runtime with it.
    const reassigned = await cli("set", card.id, "--role", "reviewer");
    expect(reassigned.exitCode).toBe(0);
    expect(reassigned.stdout).toContain("dropped the codex session id");

    const updated = store.requireById(card.id);
    expect(updated.runtime).toBe("claude");
    expect(updated.sessionId).toBeNull();
    // …and the plan a worker would get no longer smuggles in a codex thread id.
    const plan = attachPlan(updated, loadRoles(root).find((role) => role.name === "reviewer") ?? null, defaultConfig(root), {});
    expect(plan.argv).not.toContain("--resume");
  });

  test("an explicit runtime that matches keeps the session", async () => {
    seedRoles(root);
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify(defaultConfig(root)), "utf8");
    const card = store.create({ title: "keep going", role: "backend", runtime: "codex" });
    store.update(card.id, { sessionId: "still-valid" });
    await cli("set", card.id, "--priority", "3");
    expect(store.requireById(card.id).sessionId).toBe("still-valid");
    await cli("set", card.id, "--runtime", "codex");
    expect(store.requireById(card.id).sessionId).toBe("still-valid");
  });

  test("`ab attach --runtime` never hands a session to the other CLI", () => {
    seedRoles(root);
    const card = { ...store.create({ title: "t", role: "backend", runtime: "codex" }), sessionId: "codex-thread" };
    const config = defaultConfig(root);

    const sameRuntime = attachPlan(card, null, config, { runtime: "codex" });
    expect(sameRuntime.argv).toContain("resume");

    const crossRuntime = attachPlan(card, null, config, { runtime: "claude" });
    expect(crossRuntime.argv).not.toContain("--resume");
    expect(crossRuntime.note).toContain("belongs to codex");
  });

  test("the dispatcher ignores a session id a hand edit left from the other CLI", async () => {
    seedRoles(root);
    const card = store.create({ title: "finish the review", role: "backend", runtime: "codex" });
    const db = new LeaseDb(root);
    try {
      // A completed codex run, exactly as the runner would record it.
      db.startRun({
        runId: "r_codex", cardId: card.id, role: "backend", runtime: "codex",
        model: "-", startedAt: Math.floor(Date.now() / 1000), sessionId: null,
      });
      db.finishRun("r_codex", { ok: true, usd: 0, turns: 1, error: null, sessionId: "codex-thread" });
      // Then a hand edit of the markdown swaps the runtime but keeps the session.
      store.update(card.id, { sessionId: "codex-thread", runtime: "claude", status: "ready" });

      const seen: (string | null)[] = [];
      const lines: string[] = [];
      await tick(store, db, defaultConfig(root), {
        log: (line) => lines.push(line),
        runner: async (input) => {
          seen.push(input.resumeSessionId);
          return successfulRun({ handoff: "done" });
        },
      });
      expect(seen).toEqual([null]);
      expect(lines.join("\n")).toContain("ignoring the codex session id");
    } finally {
      db.close();
    }
  });

  test("a matching runtime still resumes its own session", async () => {
    seedRoles(root);
    const card = store.create({ title: "continue", role: "backend", runtime: "codex", status: "ready" });
    const db = new LeaseDb(root);
    try {
      db.startRun({
        runId: "r_prior", cardId: card.id, role: "backend", runtime: "codex",
        model: "-", startedAt: Math.floor(Date.now() / 1000), sessionId: null,
      });
      db.finishRun("r_prior", { ok: true, usd: 0, turns: 1, error: null, sessionId: "codex-thread" });
      store.update(card.id, { sessionId: "codex-thread", status: "ready" });

      const seen: (string | null)[] = [];
      await tick(store, db, defaultConfig(root), {
        runner: async (input) => {
          seen.push(input.resumeSessionId);
          return successfulRun({ handoff: "done" });
        },
      });
      expect(seen).toEqual(["codex-thread"]);
    } finally {
      db.close();
    }
  });
});

describe("seeds", () => {
  test("roles seed once and are idempotent", () => {
    expect(seedRoles(root).length).toBeGreaterThanOrEqual(10);
    expect(seedRoles(root)).toHaveLength(0);
    const roles = loadRoles(root);
    expect(roles.find((role) => role.name === "reviewer")?.readOnly).toBe(true);
    expect(roles.every((role) => role.description.length > 20)).toBe(true);
  });

  test("prompts seed with variables", () => {
    seedPrompts(root);
    const bugfix = loadPrompts(root).find((prompt) => prompt.name === "bugfix");
    expect(bugfix?.variables).toContain("symptom");
    expect(bugfix?.role).toBe("backend");
  });
});
