/**
 * Budget admission guard. SQLite reserves configured worst-case metered cost
 * against per-card/day ceilings before launch, then reconciles reported actuals.
 * Unknown-price/subscription runtimes still require provider-side limits.
 */

import type { LeaseDb } from "./lease.ts";
import type { BoardConfig, Card } from "./types.ts";

export type BudgetVerdict =
  | { allowed: true; remainingCardUsd: number; remainingDayUsd: number }
  | { allowed: false; reason: string };

export function cardCeiling(card: Card, config: BoardConfig): number {
  return card.budgetUsd ?? config.budget.perCardUsd;
}

export function check(db: LeaseDb, card: Card, config: BoardConfig, needUsd = 0): BudgetVerdict {
  const cardSpent = db.spentOnCard(card.id) + db.reservedOnCard(card.id);
  const cardMax = cardCeiling(card, config);
  const daySpent = db.spentToday() + db.reservedToday();
  const dayMax = config.budget.perDayUsd;

  if (cardSpent + needUsd > cardMax) {
    return {
      allowed: false,
      reason: `card budget exhausted: $${cardSpent.toFixed(4)} of $${cardMax.toFixed(2)} spent`,
    };
  }
  if (daySpent + needUsd > dayMax) {
    return {
      allowed: false,
      reason: `daily budget exhausted: $${daySpent.toFixed(4)} of $${dayMax.toFixed(2)} spent today`,
    };
  }
  return {
    allowed: true,
    remainingCardUsd: cardMax - cardSpent,
    remainingDayUsd: dayMax - daySpent,
  };
}

/**
 * Turn cap for a run. Only `claude` accepts a turn bound (`--max-turns`);
 * `codex exec` has no equivalent flag, so for codex cards the effective bound is
 * the cost ceiling plus the runner timeout, not this number.
 */
export function turnCap(card: Card, config: BoardConfig): number {
  return card.maxTurns ?? config.budget.perCardTurns;
}

/** Rough price table for the cheap tier; only used to pre-screen a call. */
const RATES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  "claude-sonnet-5": { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  "claude-opus-5": { in: 15 / 1_000_000, out: 75 / 1_000_000 },
};

export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES[model];
  if (!rate) return 0; // unknown/subscription-billed or local: treated as untracked
  return inputTokens * rate.in + outputTokens * rate.out;
}

/** Chars→tokens is ~4:1 for English prose; good enough for a pre-flight guess. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
