#!/usr/bin/env bun
/**
 * Grade triage routing against `evals/routing.json`.
 *
 * This spends one real triage call per ticket through the board's configured
 * provider chain, so it is deliberately NOT part of `bun run check`. Run it
 * after editing role descriptions or the triage prompt — those are the two
 * things that decide routing, and neither can be unit-tested for judgement.
 *
 *   bun run scripts/routing-eval.ts                  # all tickets
 *   bun run scripts/routing-eval.ts standalone-review # one ticket by id
 *   bun run scripts/routing-eval.ts --json
 *
 * Every run uses a fresh temporary board seeded with the shipped roles, so the
 * result reflects this checkout and never touches a real board or its ledger.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, defaultConfig, findRoot, loadConfig } from "../src/config.ts";
import { LeaseDb } from "../src/lease.ts";
import { loadRoles, seedRoles } from "../src/roles.ts";
import { Store } from "../src/store.ts";
import { triageCard } from "../src/triage.ts";
import type { BoardConfig } from "../src/types.ts";

type Ticket = {
  id: string;
  idea: string;
  expect?: string;
  alsoAcceptable?: string[];
  expectCards?: number;
  expectFanout?: boolean;
  expectRoles?: string[];
  expectParked?: boolean;
  readOnlyRequired?: boolean;
  why?: string;
};

type Grade = {
  id: string;
  ok: boolean;
  detail: string;
  routed: string[];
  confidence: number;
  parked: boolean;
  usd: number;
};

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const wanted = args.filter((arg) => !arg.startsWith("--"));

const fixture = JSON.parse(
  await Bun.file(join(import.meta.dir, "..", "evals", "routing.json")).text(),
) as { tickets: Ticket[] };
const tickets = wanted.length > 0
  ? fixture.tickets.filter((ticket) => wanted.includes(ticket.id))
  : fixture.tickets;
if (tickets.length === 0) {
  console.error(`no such ticket id; known: ${fixture.tickets.map((ticket) => ticket.id).join(", ")}`);
  process.exit(2);
}

/**
 * Borrow the real board's provider chain when one is reachable, so the eval
 * grades the models actually in use, but keep the scratch board's own ledger.
 */
function chainFrom(root: string, fallback: BoardConfig): BoardConfig {
  const boardRoot = findRoot();
  if (!boardRoot) return fallback;
  try {
    const live = loadConfig(boardRoot);
    return { ...fallback, triageChain: live.triageChain, triageMinConfidence: live.triageMinConfidence };
  } catch {
    return fallback;
  }
}

function gradeOne(ticket: Ticket, routed: string[], readOnly: boolean[], confidence: number, parked: boolean): { ok: boolean; detail: string } {
  if (ticket.expectParked) {
    return parked
      ? { ok: true, detail: `parked at ${confidence.toFixed(2)}` }
      : { ok: false, detail: `dispatchable at ${confidence.toFixed(2)} — expected a park` };
  }
  if (parked) return { ok: false, detail: `parked at ${confidence.toFixed(2)} — expected a routed card` };

  if (ticket.expectFanout) {
    const missing = (ticket.expectRoles ?? []).filter((role) => !routed.includes(role));
    if (routed.length < 2) return { ok: false, detail: `no fanout: ${routed.join(", ")}` };
    return missing.length === 0
      ? { ok: true, detail: `split into ${routed.join(", ")}` }
      : { ok: false, detail: `split into ${routed.join(", ")} — missing ${missing.join(", ")}` };
  }

  if (ticket.expectCards !== undefined && routed.length !== ticket.expectCards) {
    return { ok: false, detail: `${routed.length} card(s), expected ${ticket.expectCards}: ${routed.join(", ")}` };
  }
  const actual = routed[0] ?? "(none)";
  const accepted = [ticket.expect, ...(ticket.alsoAcceptable ?? [])].filter(Boolean) as string[];
  if (!accepted.includes(actual)) {
    return { ok: false, detail: `routed to ${actual}, expected ${accepted.join(" or ")}` };
  }
  if (ticket.readOnlyRequired && !readOnly.every(Boolean)) {
    return { ok: false, detail: `routed to ${actual}, which can write — this card must not` };
  }
  return { ok: true, detail: `routed to ${actual}` };
}

const root = mkdtempSync(join(tmpdir(), "ab-routing-eval-"));
const store = new Store(root);
store.ensureDirs();
seedRoles(root);
const base = defaultConfig(root);
const config = chainFrom(root, base);
writeFileSync(join(root, CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
const roles = loadRoles(root);
const db = new LeaseDb(root);
const grades: Grade[] = [];

try {
  for (const ticket of tickets) {
    const card = store.create({ title: ticket.idea });
    const outcome = await triageCard(store, db, config, roles, card, {
      log: asJson ? undefined : (line) => console.log(`  ${line}`),
    });
    const produced = outcome.created.length > 0
      ? outcome.created.map((id) => store.requireById(id))
      : [store.requireById(card.id)];
    const routed = produced.map((entry) => entry.role ?? "(unrouted)");
    const readOnly = produced.map((entry) => roles.find((role) => role.name === entry.role)?.readOnly ?? false);
    const confidence = outcome.plan?.confidence ?? 0;
    const parked = outcome.parked === true;
    const { ok, detail } = outcome.ok
      ? gradeOne(ticket, routed, readOnly, confidence, parked)
      : { ok: false, detail: `triage failed: ${outcome.error}` };
    grades.push({ id: ticket.id, ok, detail, routed, confidence, parked, usd: outcome.usd });
    if (!asJson) {
      console.log(`${ok ? "ok  " : "FAIL"} ${ticket.id.padEnd(20)} ${detail}  (conf ${confidence.toFixed(2)})`);
      if (!ok && ticket.why) console.log(`     why it matters: ${ticket.why}`);
    }
  }
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

const passed = grades.filter((grade) => grade.ok).length;
const usd = grades.reduce((sum, grade) => sum + grade.usd, 0);
if (asJson) {
  console.log(JSON.stringify({ passed, total: grades.length, usd, grades }, null, 2));
} else {
  console.log(`\n${passed}/${grades.length} routed as specified  (tracked spend $${usd.toFixed(4)})`);
}
process.exit(passed === grades.length ? 0 : 1);
