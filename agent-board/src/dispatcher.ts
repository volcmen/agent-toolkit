/**
 * Dispatcher. One tick does five things, in order:
 *
 *   1. reclaim leases whose worker went quiet
 *   2. triage cards sitting in `triage`
 *   3. promote `todo` cards whose parents are all done
 *   4. spawn workers for `ready` cards, up to the concurrency caps
 *   5. record usage, handoffs, and failures
 *
 * The claim is a conditional INSERT in SQLite, so two dispatchers can run
 * against the same board without stepping on each other.
 */

import { findRole, loadRoles } from "./roles.ts";
import { resolveWorkspace } from "./workspace.ts";
import { workerPrompt } from "./context.ts";
import {
  effectiveSkills,
  logPathFor,
  ProcessGroupTerminationError,
  runCard,
  terminateProcessGroup,
  type RunnerInput,
  type RunnerOutput,
} from "./runners.ts";
import { triageCard } from "./triage.ts";
import * as limits from "./limits.ts";
import type { LeaseDb } from "./lease.ts";
import { cardRevision, type Store } from "./store.ts";
import type { BoardConfig, Card, Role } from "./types.ts";
import { nowSeconds } from "./ids.ts";

export type TickReport = {
  reclaimed: string[];
  recovered: string[];
  triaged: { cardId: string; created: string[]; provider: string; usd: number; ok: boolean }[];
  promoted: string[];
  started: string[];
  finished: { cardId: string; ok: boolean; usd: number; status: Card["status"] }[];
  skipped: { cardId: string; reason: string }[];
};

const emptyReport = (): TickReport => ({
  reclaimed: [],
  recovered: [],
  triaged: [],
  promoted: [],
  started: [],
  finished: [],
  skipped: [],
});

export function cardsById(cards: Card[]): Map<string, Card> {
  return new Map(cards.map((card) => [card.id, card]));
}

/** A card is runnable once every parent exists and is done (or archived away). */
export function parentsSatisfied(card: Card, all: Map<string, Card>): boolean {
  return card.parents.every((id) => {
    const parent = all.get(id);
    if (!parent) return false;
    return parent.status === "done" || parent.status === "archived";
  });
}

function invalidForDispatch(card: Card, roles: Role[], config: BoardConfig): string | null {
  if (card.invalidReason) return `malformed card: ${card.invalidReason}`;
  const role = card.role ?? config.defaultRole;
  if (!findRole(roles, role)) return `malformed card: unknown role ${role}`;
  return null;
}

export function pickReady(cards: Card[], all: Map<string, Card>, config: BoardConfig, runningByRole: Map<string, number>): Card[] {
  const running = cards.filter((card) => card.status === "running").length;
  const slots = Math.max(0, config.maxRunning - running);
  if (slots === 0) return [];
  const candidates = cards
    .filter((card) => card.status === "ready" && parentsSatisfied(card, all))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const chosen: Card[] = [];
  const perRole = new Map(runningByRole);
  for (const card of candidates) {
    if (chosen.length >= slots) break;
    const role = card.role ?? config.defaultRole;
    const active = perRole.get(role) ?? 0;
    if (active >= config.maxRunningPerRole) continue;
    perRole.set(role, active + 1);
    chosen.push(card);
  }
  return chosen;
}

export type TickOptions = {
  owner?: string;
  log?: (line: string) => void;
  /** Skip the model calls — used by tests and `ab dispatch --dry-run`. */
  dryRun?: boolean;
  /** Cap how many triage calls one tick makes. */
  maxTriagePerTick?: number;
  timeoutMs?: number;
  /** Deterministic runner seam for lifecycle integration tests. */
  runner?: (input: RunnerInput) => Promise<RunnerOutput>;
  /** Deterministic process-group shutdown seam for stale-recovery tests. */
  terminateGroup?: (pgid: number) => Promise<boolean>;
};

export type DispatchPreview = {
  fingerprint: string;
  triage: string[];
  promote: string[];
  reclaim: string[];
  recover: string[];
  start: {
    cardId: string;
    role: string;
    runtime: string;
    model: string | null;
    workspace: Card["workspace"];
    dependenciesSatisfied: boolean;
  }[];
  skipped: { cardId: string; reason: string }[];
  activeSlots: number;
  maxSlots: number;
};

/** Compute the complete dispatch decision without writing files or SQLite. */
export function dispatchPreview(
  store: Store,
  db: LeaseDb,
  config: BoardConfig,
  options: Pick<TickOptions, "maxTriagePerTick"> = {},
): DispatchPreview {
  const roles = loadRoles(store.root);
  const cards = store.list();
  const all = cardsById(store.listAll());
  const leases = db.activeLeases();
  const leased = new Set(leases.map((lease) => lease.cardId));
  const reclaim = db.staleLeases(config.staleSeconds).map((lease) => lease.cardId).sort();
  const recover = cards
    .filter((card) => card.status === "running" && !leased.has(card.id))
    .map((card) => card.id)
    .sort();
  const triage = cards
    .filter((card) => card.status === "triage")
    .slice(0, options.maxTriagePerTick ?? 2)
    .map((card) => card.id);
  const promote: string[] = [];
  const skipped: { cardId: string; reason: string }[] = [];

  for (const card of cards) {
    if (card.status !== "todo") continue;
    if (parentsSatisfied(card, all)) promote.push(card.id);
    else if (card.parents.some((id) => !all.has(id))) {
      skipped.push({ cardId: card.id, reason: "missing parent" });
    }
  }
  for (const card of cards) {
    if (card.status === "ready" && card.parents.some((id) => !all.has(id))) {
      skipped.push({ cardId: card.id, reason: "missing parent" });
    }
  }

  const virtual = cards.map((card) => {
    if (recover.includes(card.id)) return { ...card, status: "ready" as const };
    if (reclaim.includes(card.id) && db.failureCount(card.id) + 1 < config.failureLimit) {
      return { ...card, status: "ready" as const };
    }
    if (promote.includes(card.id) && card.root !== card.id) return { ...card, status: "ready" as const };
    return card;
  });
  const virtualAll = cardsById(virtual);
  const runningByRole = new Map<string, number>();
  for (const card of virtual) {
    if (card.status !== "running" || reclaim.includes(card.id)) continue;
    const role = card.role ?? config.defaultRole;
    runningByRole.set(role, (runningByRole.get(role) ?? 0) + 1);
  }
  const candidates = pickReady(virtual, virtualAll, config, runningByRole);
  const start: DispatchPreview["start"] = [];
  for (const card of candidates) {
    const role = findRole(roles, card.role ?? config.defaultRole);
    start.push({
      cardId: card.id,
      role: role?.name ?? config.defaultRole,
      runtime: card.runtime ?? role?.runtime ?? config.defaultRuntime,
      model: card.model ?? role?.model ?? null,
      workspace: card.workspace,
      dependenciesSatisfied: parentsSatisfied(card, virtualAll),
    });
  }

  const stable = {
    cards: cards.map((card) => ({
      id: card.id,
      status: card.status,
      role: card.role,
      runtime: card.runtime,
      model: card.model,
      parents: card.parents,
      priority: card.priority,
      workspace: card.workspace,
      maxTurns: card.maxTurns,
      updatedAt: card.updatedAt,
    })),
    leases: leases.map((lease) => lease.cardId).sort(),
    decisions: { triage, promote, reclaim, recover, start: start.map((item) => item.cardId) },
    caps: [config.maxRunning, config.maxRunningPerRole],
  };
  const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify(stable)).digest("hex");
  return {
    fingerprint,
    triage,
    promote,
    reclaim,
    recover,
    start,
    skipped,
    activeSlots: leases.filter((lease) => !reclaim.includes(lease.cardId)).length,
    maxSlots: config.maxRunning,
  };
}

export async function tick(
  store: Store,
  db: LeaseDb,
  config: BoardConfig,
  options: TickOptions = {},
): Promise<TickReport> {
  const log = options.log ?? (() => {});
  const owner = options.owner ?? `ab@${process.pid}`;
  const report = emptyReport();
  const roles = loadRoles(store.root);

  if (options.dryRun) {
    const preview = dispatchPreview(store, db, config, options);
    report.reclaimed.push(...preview.reclaim);
    report.recovered.push(...preview.recover);
    report.promoted.push(...preview.promote);
    report.skipped.push(
      ...preview.skipped,
      ...preview.triage.map((cardId) => ({ cardId, reason: "dry-run: would triage" })),
      ...preview.start.map(({ cardId }) => ({ cardId, reason: "dry-run: would run" })),
    );
    return report;
  }

  // 1. reclaim stale leases
  for (const stale of db.staleLeases(config.staleSeconds)) {
    const lease = db.lease(stale.cardId);
    if (!lease || lease.runId !== stale.runId) continue;
    if (lease.pgid && !await (options.terminateGroup ?? terminateProcessGroup)(lease.pgid)) {
      const reason = "stale worker process group could not be confirmed stopped; lease retained";
      report.skipped.push({ cardId: lease.cardId, reason });
      log(`${lease.cardId}: ${reason}`);
      continue;
    }
    let reclaimed = false;
    let registrationWon = false;
    db.withOwnedLease(lease.cardId, lease.runId, () => {
      // The detached wrapper may have registered after staleLeases() returned.
      // Its registration must win; the next tick will terminate that group.
      if (db.lease(lease.cardId)?.pgid !== lease.pgid) {
        registrationWon = true;
        return;
      }
      const failures = db.recordFailure(lease.cardId, "worker went quiet (stale lease)");
      const card = store.byId(lease.cardId);
      if (card) {
        const tripped = failures >= config.failureLimit;
        store.update(card.id, {
          status: tripped ? "blocked" : "ready",
          blockedReason: tripped ? `stale worker ${failures}x — breaker tripped` : null,
        });
      }
      db.release(lease.cardId, lease.runId);
      reclaimed = true;
    });
    if (registrationWon) {
      const reason = "worker process group registered during recovery; lease retained";
      report.skipped.push({ cardId: lease.cardId, reason });
      log(`${lease.cardId}: ${reason}`);
      continue;
    }
    if (reclaimed) {
      report.reclaimed.push(lease.cardId);
      log(`reclaimed ${lease.cardId}`);
    }
  }

  // A crash between the markdown status write and lease cleanup can leave a
  // permanent phantom runner. No live lease means no worker owns the card.
  for (const card of store.list()) {
    if (card.status !== "running" || db.lease(card.id)) continue;
    store.update(card.id, { status: "ready", blockedReason: null });
    report.recovered.push(card.id);
    log(`recovered ${card.id}: running without lease → ready`);
  }

  // 2. triage
  const triageLimit = options.maxTriagePerTick ?? 2;
  const inTriage = store.list().filter((card) => card.status === "triage").slice(0, triageLimit);
  for (const card of inTriage) {
    const outcome = await triageCard(store, db, config, roles, card, {
      log,
    });
    report.triaged.push({
      cardId: card.id,
      created: outcome.created,
      provider: outcome.provider,
      usd: outcome.usd,
      ok: outcome.ok,
    });
    log(
      outcome.ok
        ? `triaged ${card.id} via ${outcome.provider} → ${outcome.created.length || 1} card(s)`
        : `triage failed for ${card.id}: ${outcome.error}`,
    );
  }

  // 3. promote
  {
    const all = cardsById(store.listAll());
    for (const card of store.list()) {
      if (card.status !== "todo") continue;
      if (!parentsSatisfied(card, all)) continue;
      // A decomposition root (root === own id) is a goal anchor, not work. When
      // its children finish it goes to `review` for a human, never to a worker —
      // otherwise every completed graph spends one extra unbudgeted run on a
      // card whose whole body is "Children: …".
      const isGoalRoot = card.root === card.id && card.parents.length > 0;
      store.update(card.id, { status: isGoalRoot ? "review" : "ready" });
      report.promoted.push(card.id);
      log(isGoalRoot ? `graph complete: ${card.id} → review` : `promoted ${card.id}`);
    }
  }

  // 4 + 5. spawn workers and record results
  const all = cardsById(store.listAll());
  const cards = store.list();
  const runningByRole = new Map<string, number>();
  for (const card of cards) {
    if (card.status !== "running") continue;
    const role = card.role ?? config.defaultRole;
    runningByRole.set(role, (runningByRole.get(role) ?? 0) + 1);
  }

  const chosen = pickReady(cards, all, config, runningByRole);
  const inFlight: Promise<void>[] = [];

  for (const card of chosen) {
    const malformed = invalidForDispatch(card, roles, config);
    if (malformed) {
      if (!card.invalidReason) store.update(card.id, { status: "blocked", blockedReason: malformed });
      report.skipped.push({ cardId: card.id, reason: malformed });
      continue;
    }
    const roleName = card.role ?? config.defaultRole;
    let expectedRevision: string;
    try {
      expectedRevision = cardRevision(card);
    } catch {
      report.skipped.push({ cardId: card.id, reason: "card changed during admission; retry on the next tick" });
      continue;
    }
    const snapshotValid = (): boolean => {
      try {
        const latest = store.byId(card.id);
        return latest !== null && cardRevision(latest) === expectedRevision;
      } catch {
        return false;
      }
    };
    const claimed = db.claimCapacity({
      cardId: card.id,
      owner,
      role: roleName,
      pid: process.pid,
      maxRunning: config.maxRunning,
      maxRunningPerRole: config.maxRunningPerRole,
      snapshotValid,
    });
    if (!claimed) {
      report.skipped.push({
        cardId: card.id,
        reason: snapshotValid()
          ? "capacity or ownership unavailable"
          : "card changed during admission; retry on the next tick",
      });
      continue;
    }
    // The lease now excludes coordinated CLI/dashboard edits. Re-read once
    // after atomic admission so the worker can never launch from a stale card.
    if (!snapshotValid()) {
      db.withOwnedLease(card.id, claimed.runId, () => {
        db.release(card.id, claimed.runId);
      });
      report.skipped.push({ cardId: card.id, reason: "card changed during admission; retry on the next tick" });
      continue;
    }
    report.started.push(card.id);
    inFlight.push(execute(store, db, config, roles, card, claimed.runId, options));
  }

  await Promise.all(inFlight);

  // Re-read to report final statuses without trusting in-memory copies.
  for (const cardId of report.started) {
    const card = store.byId(cardId);
    if (!card) continue;
    const [latest] = db.runs(cardId, 1);
    report.finished.push({
      cardId,
      ok: latest?.ok === 1,
      usd: latest?.usd ?? 0,
      status: card.status,
    });
  }
  return report;
}

async function execute(
  store: Store,
  db: LeaseDb,
  config: BoardConfig,
  roles: Role[],
  card: Card,
  runId: string,
  options: TickOptions,
): Promise<void> {
  const log = options.log ?? (() => {});
  const role = findRole(roles, card.role ?? config.defaultRole);
  const runtime = card.runtime ?? role?.runtime ?? config.defaultRuntime;
  const model = card.model ?? role?.model ?? null;
  const all = cardsById(store.listAll());

  let workspace;
  try {
    workspace = await resolveWorkspace(store.root, config.workdir, card);
  } catch (error) {
    db.withOwnedLease(card.id, runId, () => {
      store.update(card.id, { status: "blocked", blockedReason: (error as Error).message });
      db.release(card.id, runId);
    });
    log(`${card.id} blocked: ${(error as Error).message}`);
    return;
  }
  const { system, prompt } = workerPrompt(card, role, all, config, workspace.note);

  if (!db.withOwnedLease(card.id, runId, () => {
    store.update(card.id, { status: "running", blockedReason: null });
  })) return;
  db.startRun({
    runId,
    cardId: card.id,
    role: role?.name ?? config.defaultRole,
    runtime,
    model: model ?? "(role default)",
    startedAt: nowSeconds(),
    sessionId: card.sessionId,
  });
  if (!db.markLaunchPrepared(card.id, runId)) return;

  // Backstop for a hand-edited card: the CLI and dashboard drop a session when
  // the runtime changes, but a file edit can still leave one from the other CLI.
  // The runs table records which runtime produced the last session, so trust it
  // over the card rather than feeding a foreign id to `--resume`.
  const [previousRun] = db.runs(card.id, 1);
  const foreignSession = previousRun !== undefined
    && previousRun.sessionId !== null
    && previousRun.sessionId === card.sessionId
    && previousRun.runtime !== runtime;
  if (foreignSession) {
    log(`${card.id}: ignoring the ${previousRun?.runtime} session id — this run is ${runtime}`);
  }

  const heartbeat = setInterval(() => db.heartbeat(card.id, runId), 15_000);
  const input: RunnerInput = {
    runtime,
    model,
    system,
    prompt,
    cwd: workspace.cwd,
    maxTurns: limits.turnCap(card, config),
    readOnly: role?.readOnly ?? false,
    skills: effectiveSkills(card.skills, role?.skills ?? []),
    resumeSessionId: foreignSession ? null : card.sessionId,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    logPath: logPathFor(store.root, card.id),
    launchRegistration: { root: store.root, cardId: card.id, runId },
    onBeforeSpawn: () => db.beginSpawn(card.id, runId),
    onSpawn: (pgid) => db.setProcessGroup(card.id, runId, pgid),
  };

  let releaseLease = true;
  try {
    const result = await (options.runner ?? runCard)(input);
    db.withOwnedLease(card.id, runId, () => {
      if (result.usd > 0 || result.tokens > 0) {
        db.spend(card.id, `run:${runtime}`, result.usd, result.tokens);
      }
      db.finishRun(runId, {
        ok: result.ok && !result.blocked,
        usd: result.usd,
        turns: result.turns,
        error: result.error,
        sessionId: result.sessionId,
      });

      if (result.blocked) {
        db.clearFailures(card.id);
        store.update(card.id, {
          status: "blocked",
          blockedReason: result.blocked,
          sessionId: result.sessionId ?? card.sessionId,
          handoff: result.handoff ?? card.handoff,
        });
        log(`${card.id} blocked: ${result.blocked}`);
      } else if (!result.ok) {
        const failures = db.recordFailure(card.id, result.error ?? "run failed");
        const tripped = failures >= config.failureLimit;
        store.update(card.id, {
          status: tripped ? "blocked" : "ready",
          blockedReason: tripped ? `${failures}x failure: ${result.error ?? "run failed"}` : null,
          sessionId: result.sessionId ?? card.sessionId,
        });
        log(`${card.id} failed (${failures}/${config.failureLimit}): ${result.error}`);
      } else {
        db.clearFailures(card.id);
        const status = role?.readOnly ? "done" : "review";
        store.update(card.id, {
          status,
          handoff: result.handoff,
          sessionId: result.sessionId ?? card.sessionId,
          blockedReason: null,
        });
        log(
          role?.readOnly
            ? `${card.id} done ($${result.usd.toFixed(4)}, ${result.turns} turn(s))`
            : `${card.id} completed → review${result.handoff ? "" : " (no HANDOFF)"}`,
        );
      }
    });
  } catch (error) {
    if (error instanceof ProcessGroupTerminationError) {
      releaseLease = false;
      log(`${card.id}: ${error.message}; lease retained`);
      return;
    }
    const message = (error as Error).message;
    db.withOwnedLease(card.id, runId, () => {
      db.finishRun(runId, { ok: false, usd: 0, turns: 0, error: message, sessionId: null });
      const failures = db.recordFailure(card.id, message);
      store.update(card.id, {
        status: failures >= config.failureLimit ? "blocked" : "ready",
        blockedReason: failures >= config.failureLimit ? `crash: ${message}` : null,
      });
    });
    log(`${card.id} crashed: ${message}`);
  } finally {
    clearInterval(heartbeat);
    if (releaseLease) db.release(card.id, runId);
  }
}
