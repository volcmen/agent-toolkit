/**
 * Lease + ledger sidecar. Everything here is derived state: leases, heartbeats,
 * run history, and the token/cost ledger. Cards (the source of truth) stay in
 * markdown; this DB is gitignored and safe to delete.
 *
 * The claim is a single conditional UPDATE, which is what makes concurrent
 * dispatchers safe without a lock file.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_FILE } from "./config.ts";
import { nowSeconds, runId as newRunId } from "./ids.ts";

const BUSY_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function enableWal(db: Database): void {
  const deadline = Date.now() + 4_000;
  while (true) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      // journal_mode can return SQLITE_BUSY immediately instead of honoring
      // busy_timeout when two fresh processes initialize the same database.
      Atomics.wait(BUSY_RETRY_WAIT, 0, 0, 10);
    }
  }
}

export type Lease = {
  cardId: string;
  runId: string;
  owner: string;
  claimedAt: number;
  heartbeatAt: number;
  pid: number | null;
  pgid: number | null;
  launchState: "claimed" | "prepared" | "spawning" | "registered";
};

export type RunRecord = {
  runId: string;
  cardId: string;
  role: string;
  runtime: string;
  model: string;
  startedAt: number;
  endedAt: number | null;
  ok: number | null;
  usd: number;
  turns: number;
  error: string | null;
  sessionId: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leases (
  card_id      TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  owner        TEXT NOT NULL,
  claimed_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  pid          INTEGER
  ,pgid        INTEGER
  ,role        TEXT NOT NULL DEFAULT ''
  ,launch_state TEXT NOT NULL DEFAULT 'claimed'
);
CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  runtime    TEXT NOT NULL,
  model      TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  ok         INTEGER,
  usd        REAL NOT NULL DEFAULT 0,
  turns      INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS runs_card ON runs(card_id, started_at DESC);
CREATE TABLE IF NOT EXISTS failures (
  card_id TEXT PRIMARY KEY,
  count   INTEGER NOT NULL DEFAULT 0,
  last    TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  day     TEXT NOT NULL,
  card_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  usd     REAL NOT NULL,
  tokens  INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_day ON ledger(day);
CREATE INDEX IF NOT EXISTS ledger_card ON ledger(card_id);
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  usd             REAL NOT NULL,
  day             TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_day ON reservations(day);
CREATE INDEX IF NOT EXISTS reservations_card ON reservations(card_id);
CREATE TABLE IF NOT EXISTS triage_claims (
  card_id      TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  owner        TEXT NOT NULL,
  state        TEXT NOT NULL,
  result_json  TEXT,
  idempotency_key TEXT NOT NULL DEFAULT '',
  claimed_at   INTEGER NOT NULL,
  reservation_id TEXT
);
`;

export function today(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export class LeaseDb {
  private readonly db: Database;

  constructor(root: string) {
    const path = join(root, DB_FILE);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 4000");
    enableWal(this.db);
    this.db.exec(SCHEMA);
    for (const migration of [
      "ALTER TABLE leases ADD COLUMN pgid INTEGER",
      "ALTER TABLE leases ADD COLUMN role TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE leases ADD COLUMN launch_state TEXT NOT NULL DEFAULT 'claimed'",
      "ALTER TABLE triage_claims ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE triage_claims ADD COLUMN reservation_id TEXT",
    ]) {
      try { this.db.exec(migration); } catch {}
    }
  }

  close(): void {
    this.db.close();
  }

  /** Claim a card. Returns the run id, or null when someone else holds it. */
  claim(cardId: string, owner: string, pid: number | null = null, role = ""): string | null {
    const runId = newRunId();
    const at = nowSeconds();
    try {
      this.db
        .query(
          `INSERT INTO leases (card_id, run_id, owner, claimed_at, heartbeat_at, pid, role)
           VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
        )
        .run(cardId, runId, owner, at, pid, role);
      return runId;
    } catch {
      return null; // primary-key conflict = already claimed
    }
  }

  heartbeat(cardId: string, runId?: string): boolean {
    const result = runId
      ? this.db.query("UPDATE leases SET heartbeat_at = ?3 WHERE card_id = ?1 AND run_id = ?2").run(cardId, runId, nowSeconds())
      : this.db.query("UPDATE leases SET heartbeat_at = ?2 WHERE card_id = ?1").run(cardId, nowSeconds());
    return result.changes === 1;
  }

  release(cardId: string, runId?: string): boolean {
    const result = runId
      ? this.db.query("DELETE FROM leases WHERE card_id = ?1 AND run_id = ?2").run(cardId, runId)
      : this.db.query("DELETE FROM leases WHERE card_id = ?1").run(cardId);
    return result.changes === 1;
  }

  lease(cardId: string): Lease | null {
    const row = this.db
      .query("SELECT card_id, run_id, owner, claimed_at, heartbeat_at, pid, pgid, launch_state FROM leases WHERE card_id = ?1")
      .get(cardId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      cardId: String(row.card_id),
      runId: String(row.run_id),
      owner: String(row.owner),
      claimedAt: Number(row.claimed_at),
      heartbeatAt: Number(row.heartbeat_at),
      pid: row.pid === null ? null : Number(row.pid),
      pgid: row.pgid === null ? null : Number(row.pgid),
      launchState: String(row.launch_state) as Lease["launchState"],
    };
  }

  owns(cardId: string, runId: string): boolean {
    return this.db.query("SELECT 1 AS ok FROM leases WHERE card_id = ?1 AND run_id = ?2").get(cardId, runId) !== null;
  }

  setProcessGroup(cardId: string, runId: string, pgid: number): boolean {
    return this.db.query(
      `UPDATE leases SET pgid = ?3, pid = ?3, launch_state = 'registered'
       WHERE card_id = ?1 AND run_id = ?2
         AND (launch_state != 'registered' OR pgid = ?3)`,
    )
      .run(cardId, runId, pgid).changes === 1;
  }

  markLaunchPrepared(cardId: string, runId: string): boolean {
    return this.db.query(
      "UPDATE leases SET launch_state = 'prepared' WHERE card_id = ?1 AND run_id = ?2 AND launch_state = 'claimed'",
    ).run(cardId, runId).changes === 1;
  }

  beginSpawn(cardId: string, runId: string): boolean {
    return this.db.query(
      "UPDATE leases SET launch_state = 'spawning' WHERE card_id = ?1 AND run_id = ?2 AND launch_state = 'prepared'",
    ).run(cardId, runId).changes === 1;
  }

  /** Serialize a markdown/status mutation with ownership changes in SQLite. */
  withOwnedLease(cardId: string, runId: string, mutation: () => void): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.owns(cardId, runId)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      mutation();
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Serialize a user card edit against worker and triage ownership. */
  mutateUnleased<T>(cardId: string, mutation: () => T): { ok: true; value: T } | { ok: false } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.lease(cardId) || this.hasActiveTriage(cardId)) {
        this.db.exec("ROLLBACK");
        return { ok: false };
      }
      const value = mutation();
      this.db.exec("COMMIT");
      return { ok: true, value };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Atomically enforce capacity and reserve spend before launching a worker. */
  claimWithReservation(input: {
    cardId: string; owner: string; role: string; pid: number | null;
    maxRunning: number; maxRunningPerRole: number;
    reserveUsd: number; cardMaxUsd: number; dayMaxUsd: number;
    /** Re-read markdown while the admission lock is held. */
    snapshotValid?: () => boolean;
  }): { runId: string; reservationId: string } | null {
    const runId = newRunId();
    const reservationId = `z_${crypto.randomUUID()}`;
    const at = nowSeconds();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const global = Number((this.db.query("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n);
      const perRole = Number((this.db.query("SELECT COUNT(*) AS n FROM leases WHERE role = ?1").get(input.role) as { n: number }).n);
      const cardUsed = Number((this.db.query(
        `SELECT COALESCE((SELECT SUM(usd) FROM ledger WHERE card_id=?1),0)
              + COALESCE((SELECT SUM(usd) FROM reservations WHERE card_id=?1),0) AS total`,
      ).get(input.cardId) as { total: number }).total);
      const dayUsed = Number((this.db.query(
        `SELECT COALESCE((SELECT SUM(usd) FROM ledger WHERE day=?1),0)
              + COALESCE((SELECT SUM(usd) FROM reservations WHERE day=?1),0) AS total`,
      ).get(today()) as { total: number }).total);
      if (global >= input.maxRunning || perRole >= input.maxRunningPerRole
        || cardUsed + input.reserveUsd > input.cardMaxUsd
        || dayUsed + input.reserveUsd > input.dayMaxUsd
        || this.lease(input.cardId)
        || (input.snapshotValid && !input.snapshotValid())) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.query(
        `INSERT INTO leases(card_id,run_id,owner,claimed_at,heartbeat_at,pid,role)
         VALUES(?1,?2,?3,?4,?4,?5,?6)`,
      ).run(input.cardId, runId, input.owner, at, input.pid, input.role);
      this.db.query(
        "INSERT INTO reservations(reservation_id,card_id,kind,usd,day,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
      ).run(reservationId, input.cardId, `run:${input.role}`, input.reserveUsd, today(), at);
      this.db.exec("COMMIT");
      return { runId, reservationId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reserve(cardId: string, kind: string, amount: number, cardMax: number, dayMax: number): string | null {
    const id = `z_${crypto.randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cardUsed = this.spentOnCard(cardId) + this.reservedOnCard(cardId);
      const dayUsed = this.spentToday() + this.reservedToday();
      if (cardUsed + amount > cardMax || dayUsed + amount > dayMax) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.query(
        "INSERT INTO reservations(reservation_id,card_id,kind,usd,day,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
      ).run(id, cardId, kind, amount, today(), nowSeconds());
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reconcile(
    reservationId: string,
    cardId: string,
    kind: string,
    usd: number,
    tokens = 0,
    inTransaction = false,
  ): boolean {
    if (!inTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.db.query("DELETE FROM reservations WHERE reservation_id=?1 AND card_id=?2")
        .run(reservationId, cardId).changes;
      if (removed !== 1) {
        if (!inTransaction) this.db.exec("ROLLBACK");
        return false;
      }
      if (usd > 0 || tokens > 0) this.spend(cardId, kind, usd, tokens);
      if (!inTransaction) this.db.exec("COMMIT");
      return true;
    } catch (error) {
      if (!inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancelReservation(reservationId: string): void {
    this.db.query("DELETE FROM reservations WHERE reservation_id=?1").run(reservationId);
  }

  cancelReservationsForCard(cardId: string): void {
    this.db.query("DELETE FROM reservations WHERE card_id=?1").run(cardId);
  }

  reservedOnCard(cardId: string): number {
    return Number((this.db.query("SELECT COALESCE(SUM(usd),0) AS total FROM reservations WHERE card_id=?1")
      .get(cardId) as { total: number }).total);
  }

  reservedToday(day = today()): number {
    return Number((this.db.query("SELECT COALESCE(SUM(usd),0) AS total FROM reservations WHERE day=?1")
      .get(day) as { total: number }).total);
  }

  claimTriage(
    cardId: string,
    owner: string,
    idempotencyKey = cardId,
    staleSeconds = Number.POSITIVE_INFINITY,
    at = nowSeconds(),
    snapshotValid?: () => boolean,
  ): string | null {
    const claimId = `t_${crypto.randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.query(
        "SELECT state,idempotency_key,claimed_at,reservation_id FROM triage_claims WHERE card_id=?1",
      ).get(cardId) as {
        state: string; idempotency_key: string; claimed_at: number; reservation_id: string | null;
      } | null;
      const stale = prior?.state === "running" && at - prior.claimed_at > staleSeconds;
      const reusable = !prior || stale || (prior.state === "done" && prior.idempotency_key !== idempotencyKey);
      if (!reusable || (snapshotValid && !snapshotValid())) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (prior?.reservation_id) {
        this.db.query("DELETE FROM reservations WHERE reservation_id=?1").run(prior.reservation_id);
      }
      this.db.query(
        `INSERT INTO triage_claims(card_id,claim_id,owner,state,claimed_at,idempotency_key)
         VALUES(?1,?2,?3,'running',?4,?5)
         ON CONFLICT(card_id) DO UPDATE SET claim_id=?2,owner=?3,state='running',
           claimed_at=?4,idempotency_key=?5,result_json=NULL,reservation_id=NULL`,
      ).run(cardId, claimId, owner, at, idempotencyKey);
      this.db.exec("COMMIT");
      return claimId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatTriage(cardId: string, claimId: string, at = nowSeconds()): boolean {
    return this.db.query(
      "UPDATE triage_claims SET claimed_at=?3 WHERE card_id=?1 AND claim_id=?2 AND state='running'",
    ).run(cardId, claimId, at).changes === 1;
  }

  reserveTriage(
    cardId: string,
    claimId: string,
    amount: number,
    cardMax: number,
    dayMax: number,
    at = nowSeconds(),
  ): string | null {
    const reservationId = `z_${crypto.randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.query(
        "SELECT 1 FROM triage_claims WHERE card_id=?1 AND claim_id=?2 AND state='running' AND reservation_id IS NULL",
      ).get(cardId, claimId);
      const cardUsed = this.spentOnCard(cardId) + this.reservedOnCard(cardId);
      const dayUsed = this.spentToday() + this.reservedToday();
      if (!owned || cardUsed + amount > cardMax || dayUsed + amount > dayMax) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.query(
        "INSERT INTO reservations(reservation_id,card_id,kind,usd,day,created_at) VALUES(?1,?2,'triage',?3,?4,?5)",
      ).run(reservationId, cardId, amount, today(new Date(at * 1000)), at);
      this.db.query(
        "UPDATE triage_claims SET reservation_id=?3 WHERE card_id=?1 AND claim_id=?2 AND state='running'",
      ).run(cardId, claimId, reservationId);
      this.db.exec("COMMIT");
      return reservationId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeTriage<T>(
    cardId: string,
    claimId: string,
    reservationId: string,
    charge: { kind: string; usd: number; tokens: number },
    mutation: () => T,
    snapshotValid?: () => boolean,
  ): T | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.query(
        `SELECT 1 FROM triage_claims
         WHERE card_id=?1 AND claim_id=?2 AND state='running' AND reservation_id=?3`,
      ).get(cardId, claimId, reservationId);
      if (!owned) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (snapshotValid && !snapshotValid()) {
        this.db.query(
          "DELETE FROM reservations WHERE reservation_id=?1 AND card_id=?2",
        ).run(reservationId, cardId);
        if (charge.usd > 0 || charge.tokens > 0) {
          this.spend(cardId, charge.kind, charge.usd, charge.tokens);
        }
        this.db.query(
          "DELETE FROM triage_claims WHERE card_id=?1 AND claim_id=?2",
        ).run(cardId, claimId);
        this.db.exec("COMMIT");
        return null;
      }
      const result = mutation();
      const removed = this.db.query(
        "DELETE FROM reservations WHERE reservation_id=?1 AND card_id=?2",
      ).run(reservationId, cardId).changes;
      if (removed !== 1) throw new Error("triage reservation disappeared before completion");
      if (charge.usd > 0 || charge.tokens > 0) {
        this.spend(cardId, charge.kind, charge.usd, charge.tokens);
      }
      this.db.query(
        `UPDATE triage_claims SET state='done',result_json=?3,reservation_id=NULL
         WHERE card_id=?1 AND claim_id=?2 AND state='running'`,
      ).run(cardId, claimId, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeUnreservedTriage<T>(
    cardId: string,
    claimId: string,
    mutation: () => T,
    snapshotValid?: () => boolean,
  ): T | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.query(
        `SELECT 1 FROM triage_claims
         WHERE card_id=?1 AND claim_id=?2 AND state='running' AND reservation_id IS NULL`,
      ).get(cardId, claimId);
      if (!owned) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (snapshotValid && !snapshotValid()) {
        this.db.query(
          "DELETE FROM triage_claims WHERE card_id=?1 AND claim_id=?2",
        ).run(cardId, claimId);
        this.db.exec("COMMIT");
        return null;
      }
      const result = mutation();
      this.db.query(
        `UPDATE triage_claims SET state='done',result_json=?3
         WHERE card_id=?1 AND claim_id=?2 AND state='running' AND reservation_id IS NULL`,
      ).run(cardId, claimId, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishTriage(cardId: string, claimId: string, result: unknown): boolean {
    return this.db.query(
      "UPDATE triage_claims SET state='done', result_json=?3 WHERE card_id=?1 AND claim_id=?2 AND state='running'",
    ).run(cardId, claimId, JSON.stringify(result)).changes === 1;
  }

  releaseTriage(cardId: string, claimId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.query(
        "SELECT reservation_id FROM triage_claims WHERE card_id=?1 AND claim_id=?2 AND state='running'",
      ).get(cardId, claimId) as { reservation_id: string | null } | null;
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (row.reservation_id) {
        this.db.query("DELETE FROM reservations WHERE reservation_id=?1").run(row.reservation_id);
      }
      this.db.query("DELETE FROM triage_claims WHERE card_id=?1 AND claim_id=?2").run(cardId, claimId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  triageState(cardId: string): { state: string; result: unknown } | null {
    const row = this.db.query("SELECT state,result_json FROM triage_claims WHERE card_id=?1").get(cardId) as
      | { state: string; result_json: string | null }
      | null;
    return row ? { state: row.state, result: row.result_json ? JSON.parse(row.result_json) : null } : null;
  }

  hasActiveTriage(cardId: string): boolean {
    return this.db.query(
      "SELECT 1 FROM triage_claims WHERE card_id=?1 AND state='running'",
    ).get(cardId) !== null;
  }

  activeLeases(): Lease[] {
    const rows = this.db.query("SELECT card_id FROM leases").all() as { card_id: string }[];
    return rows.map((row) => this.lease(row.card_id)).filter((l): l is Lease => l !== null);
  }

  /** Leases whose heartbeat went quiet — the dispatcher reclaims these. */
  staleLeases(staleSeconds: number, at = nowSeconds()): Lease[] {
    return this.activeLeases().filter((lease) => at - lease.heartbeatAt > staleSeconds);
  }

  startRun(record: Omit<RunRecord, "endedAt" | "ok" | "usd" | "turns" | "error">): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO runs (run_id, card_id, role, runtime, model, started_at, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(
        record.runId,
        record.cardId,
        record.role,
        record.runtime,
        record.model,
        record.startedAt,
        record.sessionId,
      );
  }

  finishRun(
    runId: string,
    result: { ok: boolean; usd: number; turns: number; error: string | null; sessionId: string | null },
  ): void {
    this.db
      .query(
        `UPDATE runs SET ended_at = ?2, ok = ?3, usd = ?4, turns = ?5, error = ?6, session_id = ?7
         WHERE run_id = ?1`,
      )
      .run(
        runId,
        nowSeconds(),
        result.ok ? 1 : 0,
        result.usd,
        result.turns,
        result.error,
        result.sessionId,
      );
  }

  runs(cardId: string, limit = 10): RunRecord[] {
    const rows = this.db
      .query(
        `SELECT run_id, card_id, role, runtime, model, started_at, ended_at, ok, usd, turns, error, session_id
         FROM runs WHERE card_id = ?1 ORDER BY started_at DESC LIMIT ?2`,
      )
      .all(cardId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      runId: String(row.run_id),
      cardId: String(row.card_id),
      role: String(row.role),
      runtime: String(row.runtime),
      model: String(row.model),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      ok: row.ok === null ? null : Number(row.ok),
      usd: Number(row.usd ?? 0),
      turns: Number(row.turns ?? 0),
      error: row.error === null ? null : String(row.error),
      sessionId: row.session_id === null ? null : String(row.session_id),
    }));
  }

  /** Consecutive failures per card. Reset on success; trips the breaker. */
  recordFailure(cardId: string, error: string): number {
    this.db
      .query(
        `INSERT INTO failures (card_id, count, last) VALUES (?1, 1, ?2)
         ON CONFLICT(card_id) DO UPDATE SET count = count + 1, last = ?2`,
      )
      .run(cardId, error.slice(0, 400));
    return this.failureCount(cardId);
  }

  clearFailures(cardId: string): void {
    this.db.query("DELETE FROM failures WHERE card_id = ?1").run(cardId);
  }

  failureCount(cardId: string): number {
    const row = this.db.query("SELECT count FROM failures WHERE card_id = ?1").get(cardId) as
      | { count: number }
      | null;
    return row ? Number(row.count) : 0;
  }

  spend(cardId: string, kind: string, usd: number, tokens = 0): void {
    this.db
      .query("INSERT INTO ledger (day, card_id, kind, usd, tokens, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .run(today(), cardId, kind, usd, tokens, nowSeconds());
  }

  spentOnCard(cardId: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(usd), 0) AS total FROM ledger WHERE card_id = ?1")
      .get(cardId) as { total: number };
    return Number(row.total);
  }

  spentToday(day = today()): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(usd), 0) AS total FROM ledger WHERE day = ?1")
      .get(day) as { total: number };
    return Number(row.total);
  }

  tokensToday(day = today()): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(tokens), 0) AS total FROM ledger WHERE day = ?1")
      .get(day) as { total: number };
    return Number(row.total);
  }

  tokensOnCard(cardId: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(tokens), 0) AS total FROM ledger WHERE card_id = ?1")
      .get(cardId) as { total: number };
    return Number(row.total);
  }

  ledgerByKind(day = today()): Record<string, number> {
    const rows = this.db
      .query("SELECT kind, COALESCE(SUM(usd),0) AS total FROM ledger WHERE day = ?1 GROUP BY kind")
      .all(day) as { kind: string; total: number }[];
    return Object.fromEntries(rows.map((row) => [row.kind, Number(row.total)]));
  }
}
