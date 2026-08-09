/** Execution limits and rough prompt sizing. */
import type { BoardConfig, Card } from "./types.ts";

export function turnCap(card: Card, config: BoardConfig): number {
  return card.maxTurns ?? config.maxTurns;
}

/** Chars→tokens is ~4:1 for English prose; good enough for a pre-flight guess. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
