/**
 * Triage: the "smart" part of the board. A raw one-liner lands in `triage` and
 * one cheap model call decides three things at once — is this one card or
 * several, what does each card actually require, and which role owns it.
 *
 * Merging specification, decomposition, and routing halves the repeated context
 * for the common case and keeps the routing decision next to the split decision,
 * where it belongs.
 */

import type { LeaseDb } from "./lease.ts";
import { callChain, type JsonResult } from "./llm.ts";
import { clip } from "./context.ts";
import { roster } from "./roles.ts";
import { cardRevision, type Store } from "./store.ts";
import type { BoardConfig, Card, Role } from "./types.ts";

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fanout", "confidence", "rationale", "cards"],
  properties: {
    fanout: { type: "boolean" },
    confidence: { type: "number" },
    rationale: { type: "string" },
    cards: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "role", "parents"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          role: { type: "string" },
          parents: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are the triage brain of an autonomous Kanban board for coding agents.

A human dropped a rough idea into Triage. Decide whether it is one unit of work
or several, write each unit as a spec a fresh worker can execute with no other
context, and route each unit to the best-matching role from the roster.

Return ONE JSON object, nothing else:

{
  "fanout": <true if you split into 2+ cards, false for a single card>,
  "confidence": <0.0-1.0, your confidence in this split AND routing>,
  "rationale": "<one sentence>",
  "cards": [
    {
      "title": "<imperative, <= 80 chars>",
      "body": "**Goal** one sentence.\\n**Approach** 2-5 bullets.\\n**Acceptance criteria** checklist of verifiable conditions.\\n**Out of scope** short list, omit if nothing obvious.",
      "role": "<role name from the roster>",
      "parents": [<0-based indices into this same cards array>]
    }
  ]
}

Rules:
- "parents" expresses real data dependencies only. No parents = runs in parallel.
  Prefer parallelism; a chain longer than 3 is almost always wrong.
- 1 card when the idea is a single unit. 2-6 for normal work. Never 20 tiny cards.
- Match the role by its DESCRIPTION, not its name.
- Decide what the DELIVERABLE is before you look at the subject matter. If the
  deliverable is a judgement or an answer rather than a change to the codebase —
  review or audit an MR/PR/diff/branch, decide between tools, recommend an
  approach, research an open question — route it to the role that owns judgements,
  even when it is the only card and even when the subject is backend, frontend, or
  infrastructure work. A role that writes code is the wrong owner for a card that
  must not write code.
- Within a graph: research before implementation, review after it, docs last,
  design before UI work. A standalone review, audit, or research card with no
  implementation card beside it is normal and complete on its own — never hand it
  to an implementer just because nothing is being built.
- Never invent requirements the human did not hint at. Preserve their substance.
- Be honest in "confidence": below 0.6 if the idea is too vague to route well. A
  low score parks the card for a human instead of guessing, so do not inflate it.
- Output only the JSON object. No preamble, no code fences.`;

export type TriagePlan = {
  fanout: boolean;
  confidence: number;
  rationale: string;
  cards: { title: string; body: string; role: string; parents: number[] }[];
};

function asPlan(
  data: Record<string, unknown> | null,
  roles: Role[],
  fallbackRole: string,
  onUnknownRole?: (name: string) => void,
): TriagePlan | null {
  if (!data) return null;
  const rawCards = Array.isArray(data.cards) ? data.cards : [];
  const known = new Set(roles.map((role) => role.name));
  const cards: TriagePlan["cards"] = [];
  for (const entry of rawCards) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    // Falling back keeps the card, but silently swallowing the name hid a real
    // defect once (a truncated roster made every answer unroutable), so say it.
    if (typeof record.role === "string" && record.role !== "" && !known.has(record.role)) {
      onUnknownRole?.(record.role);
    }
    const role = typeof record.role === "string" && known.has(record.role) ? record.role : fallbackRole;
    const parents = Array.isArray(record.parents)
      ? record.parents
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0 && value < rawCards.length)
      : [];
    cards.push({
      title: clip(title, 80),
      body: typeof record.body === "string" ? record.body.trim() : "",
      role,
      parents,
    });
  }
  if (cards.length === 0) return null;
  const confidence = Number(data.confidence);
  return {
    fanout: cards.length > 1,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    rationale: typeof data.rationale === "string" ? clip(data.rationale, 240) : "",
    cards,
  };
}

/**
 * Make the graph executable without losing edges the model meant.
 *
 * Cards may arrive in any order, so a forward reference ("docs first, depending on
 * the implementation listed below it") is a real dependency, not a mistake.
 * Dropping it would let the docs card run before the code exists. Instead the
 * cards are topologically reordered and their parent indices remapped, which
 * restores the `parents < index` invariant the creation loop relies on. Only an
 * edge that would close a cycle is discarded — that one really would deadlock the
 * dispatcher.
 */
export function sanitizeEdges(cards: TriagePlan["cards"]): TriagePlan["cards"] {
  const edges = cards.map((card, index) => [
    ...new Set(card.parents.filter((parent) => parent !== index && parent >= 0 && parent < cards.length)),
  ]);
  const order: number[] = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();
  // Depth-first in the model's own order: stable output, and an edge is only
  // discarded when following it would revisit a card already on the stack.
  const visit = (index: number): void => {
    if (placed.has(index) || visiting.has(index)) return;
    visiting.add(index);
    for (const parent of edges[index] as number[]) visit(parent);
    visiting.delete(index);
    placed.add(index);
    order.push(index);
  };
  for (let index = 0; index < cards.length; index += 1) visit(index);

  const rankOf = new Map(order.map((index, rank) => [index, rank]));
  return order.map((index) => {
    const card = cards[index] as TriagePlan["cards"][number];
    const rank = rankOf.get(index) as number;
    return {
      ...card,
      parents: (edges[index] as number[])
        .map((parent) => rankOf.get(parent) as number)
        .filter((parentRank) => parentRank < rank)
        .sort((a, b) => a - b),
    };
  });
}

export type TriageOutcome = {
  ok: boolean;
  cardId: string;
  provider: string;
  model: string;
  usd: number;
  tokens: number;
  created: string[];
  plan: TriagePlan | null;
  error: string | null;
  /** The plan parsed but scored below the confidence bar, so it was not applied. */
  parked?: boolean;
  /** Roles the model named that this board does not have; each fell back. */
  unknownRoles?: string[];
};

async function triageCardClaimed(
  config: BoardConfig,
  roles: Role[],
  card: Card,
  options: { minConfidence?: number; log?: (line: string) => void } = {},
): Promise<TriageOutcome> {
  const user = [
    `Card id: ${card.id}`,
    `Idea: ${card.title}`,
    card.body ? `Notes:\n${clip(card.body, 2000)}` : "",
    "",
    `Available roles:\n${roster(roles)}`,
    `Fallback role when nothing matches: ${config.defaultRole}`,
  ]
    .filter(Boolean)
    .join("\n");

  const attempts: JsonResult[] = [];
  const result = await callChain(
    config.triageChain,
    { system: SYSTEM, user, schema: TRIAGE_SCHEMA, maxOutputTokens: 1600 },
    {
      minConfidence: options.minConfidence ?? config.triageMinConfidence,
      onAttempt: (attempt) => {
        attempts.push(attempt);
        options.log?.(
          `triage ${attempt.provider}/${attempt.model}: ${attempt.ok ? "ok" : `failed — ${attempt.error}`}`,
        );
      },
    },
  );
  const totalUsd = attempts.reduce((sum, attempt) => sum + attempt.usd, 0);
  const totalTokens = attempts.reduce((sum, attempt) => sum + attempt.tokens, 0);

  const unknownRoles: string[] = [];
  const plan = asPlan(result.data, roles, config.defaultRole, (name) => {
    if (!unknownRoles.includes(name)) unknownRoles.push(name);
    options.log?.(`triage asked for role "${name}", which is not on this board — fell back to ${config.defaultRole}`);
  });
  if (!result.ok || !plan) {
    return {
      ok: false,
      cardId: card.id,
      provider: result.provider,
      model: result.model,
      usd: totalUsd,
      tokens: totalTokens,
      created: [],
      plan: null,
      error: result.error ?? "unparseable plan",
    };
  }

  plan.cards = sanitizeEdges(plan.cards);
  return {
    ok: true,
    cardId: card.id,
    provider: result.provider,
    model: result.model,
    usd: totalUsd,
    tokens: totalTokens,
    created: [],
    plan,
    error: null,
    ...(unknownRoles.length > 0 ? { unknownRoles } : {}),
  };
}

/** Human-readable proposal left on a card whose plan scored too low to apply. */
function parkedProposal(card: Card, plan: TriagePlan, minConfidence: number): string {
  const lines = plan.cards.map((child, index) => {
    const parents = child.parents.length > 0
      ? ` (after ${child.parents.map((parent) => `#${parent + 1}`).join(", ")})`
      : "";
    return `${index + 1}. [${child.role}] ${child.title}${parents}`;
  });
  return [
    card.body ? card.body.trim() : "",
    "",
    `**Triage parked** confidence ${plan.confidence.toFixed(2)} is below the ${minConfidence.toFixed(2)} bar,`,
    "so nothing was created. Sharpen this card, then send it back to triage",
    "(`ab set <id> --action send_to_triage`) or accept the proposal by hand.",
    "",
    plan.rationale ? `Rationale: ${plan.rationale}` : "",
    "",
    `Proposed ${plan.cards.length === 1 ? "card" : `${plan.cards.length} cards`}:`,
    ...lines,
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n")
    .trim();
}

function applyTriageOutcome(
  store: Store,
  config: BoardConfig,
  roles: Role[],
  card: Card,
  outcome: TriageOutcome,
  minConfidence: number,
): TriageOutcome {
  const plan = outcome.plan;
  if (!outcome.ok || !plan) {
    // Failing triage must never lose the idea: park it for a human instead.
    store.update(card.id, {
      status: "blocked",
      blockedReason: `triage failed: ${outcome.error ?? "unparseable plan"}`,
    });
    return outcome;
  }
  const created: string[] = [];

  // A guess the model itself does not believe is not worth a paid worker run.
  // The plan is written onto the card as a proposal so no work is lost, but
  // nothing is dispatched and no children appear until a human looks.
  if (plan.confidence < minConfidence) {
    store.update(card.id, {
      status: "blocked",
      blockedReason: `low triage confidence ${plan.confidence.toFixed(2)} < ${minConfidence.toFixed(2)} — needs a clearer spec`,
      body: parkedProposal(card, plan, minConfidence),
    });
    return { ...outcome, created: [], parked: true };
  }

  if (plan.cards.length === 1) {
    const only = plan.cards[0] as TriagePlan["cards"][number];
    const role = roles.find((candidate) => candidate.name === only.role) ?? null;
    store.update(card.id, {
      title: only.title || card.title,
      body: only.body || card.body,
      role: only.role,
      runtime: card.runtime ?? role?.runtime ?? config.defaultRuntime,
      model: card.model ?? role?.model ?? null,
      maxTurns: card.maxTurns ?? role?.maxTurns ?? null,
      skills: card.skills.length > 0 ? card.skills : role?.skills ?? [],
      status: card.parents.length > 0 ? "todo" : "ready",
      blockedReason: null,
    });
    return {
      ...outcome,
      created: [],
    };
  }

  // Fanout: the root stays as the goal anchor and gains every leaf as a parent,
  // so it reopens once the whole graph is done.
  const indexToId = new Map<number, string>();
  plan.cards.forEach((child, index) => {
    const role = roles.find((candidate) => candidate.name === child.role) ?? null;
    const parents = child.parents
      .map((parentIndex) => indexToId.get(parentIndex))
      .filter((id): id is string => id !== undefined);
    const madeCard = store.create({
      title: child.title,
      body: child.body,
      role: child.role,
      runtime: role?.runtime ?? config.defaultRuntime,
      model: role?.model ?? null,
      parents,
      root: card.root ?? card.id,
      status: parents.length > 0 ? "todo" : "ready",
      maxTurns: role?.maxTurns ?? null,
      skills: role?.skills ?? [],
    });
    indexToId.set(index, madeCard.id);
    created.push(madeCard.id);
  });

  const leaves = plan.cards
    .map((_, index) => index)
    .filter((index) => !plan.cards.some((child) => child.parents.includes(index)))
    .map((index) => indexToId.get(index))
    .filter((id): id is string => id !== undefined);

  store.update(card.id, {
    status: "todo",
    role: card.role ?? "orchestrator",
    root: card.root ?? card.id,
    parents: [...new Set([...card.parents, ...leaves])],
    body: `${card.body ? `${card.body}\n\n` : ""}**Decomposed** ${plan.rationale}\n\nChildren: ${created.join(", ")}`,
    blockedReason: null,
  });

  return {
    ...outcome,
    created,
  };
}

/** Cross-process idempotent triage entry point. */
export async function triageCard(
  store: Store,
  db: LeaseDb,
  config: BoardConfig,
  roles: Role[],
  card: Card,
  options: { minConfidence?: number; log?: (line: string) => void; owner?: string } = {},
): Promise<TriageOutcome> {
  const minConfidence = options.minConfidence ?? config.triageMinConfidence;
  if (card.invalidReason) {
    return {
      ok: false, cardId: card.id, provider: "none", model: "", usd: 0, tokens: 0,
      created: [], plan: null, error: `malformed card: ${card.invalidReason}`,
    };
  }
  const expectedRevision = cardRevision(card);
  const snapshotValid = (): boolean => {
    try {
      const latest = store.byId(card.id);
      return latest !== null
        && latest.status === "triage"
        && cardRevision(latest) === expectedRevision;
    } catch {
      return false;
    }
  };
  const claimId = db.claimTriage(
    card.id,
    options.owner ?? `triage@${process.pid}`,
    card.updatedAt,
    config.staleSeconds,
    undefined,
    snapshotValid,
  );
  if (!claimId) {
    const prior = db.triageState(card.id);
    return (prior?.state === "done" && prior.result)
      ? prior.result as TriageOutcome
      : {
          ok: false, cardId: card.id, provider: "none", model: "", usd: 0, tokens: 0,
          created: [], plan: null, error: "triage already in progress",
        };
  }
  let outcome: TriageOutcome;
  const heartbeatMs = Math.max(1_000, Math.floor(config.staleSeconds * 500));
  const heartbeat = setInterval(() => db.heartbeatTriage(card.id, claimId), heartbeatMs);
  try {
    outcome = await triageCardClaimed(config, roles, card, {
      ...options,
      minConfidence,
    });
  } catch (error) {
    outcome = {
      ok: false, cardId: card.id, provider: "none", model: "", usd: 0, tokens: 0,
      created: [], plan: null, error: (error as Error).message,
    };
  } finally {
    clearInterval(heartbeat);
  }
  const completed = db.completeTriage(
    card.id,
    claimId,
    { kind: `triage:${outcome.provider}`, usd: outcome.usd, tokens: outcome.tokens },
    () => applyTriageOutcome(store, config, roles, card, outcome, minConfidence),
    snapshotValid,
  );
  return completed ?? {
    ok: false, cardId: card.id, provider: "none", model: "", usd: 0, tokens: 0,
    created: [], plan: null, error: "triage ownership or card revision lost",
  };
}
