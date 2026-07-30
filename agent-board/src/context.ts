/**
 * Context packs. Every prompt a worker or triage model sees is assembled here,
 * and every part of it is hard-capped. This is the main defence against token
 * burn: a card carries its own body, a trimmed goal ancestry, and its parents'
 * handoffs — never a transcript, never the whole board.
 *
 * Goal ancestry is borrowed from Paperclip: a child card inherits the chain of
 * intent that produced it, so a worker three levels deep still knows the mission
 * without anyone pasting it in.
 */

import type { BoardConfig, Card, Role } from "./types.ts";

export function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
}

/** Chain from the card up to its root goal, nearest ancestor last. */
export function ancestry(card: Card, all: Map<string, Card>, maxHops = 6): Card[] {
  const chain: Card[] = [];
  const seen = new Set<string>([card.id]);
  let cursor: Card | undefined = card;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const parentId: string | undefined = cursor?.parents[0] ?? cursor?.root ?? undefined;
    if (!parentId || seen.has(parentId)) break;
    const parent = all.get(parentId);
    if (!parent) break;
    seen.add(parent.id);
    chain.unshift(parent);
    cursor = parent;
  }
  return chain;
}

export function parentHandoffs(card: Card, all: Map<string, Card>, config: BoardConfig): string {
  const parents = card.parents
    .slice(0, config.context.maxParents)
    .map((id) => all.get(id))
    .filter((parent): parent is Card => parent !== undefined);
  if (parents.length === 0) return "";
  const blocks = parents.map((parent) => {
    const handoff = parent.handoff
      ? clip(parent.handoff, config.context.handoffChars)
      : "(completed without a handoff)";
    return `### ${parent.id} — ${parent.title}\n${handoff}`;
  });
  return blocks.join("\n\n");
}

/**
 * Worker prompt: role soul + mission chain + card spec + parent handoffs.
 * Ordered cheapest-to-change first so provider-side prefix caching can hit on
 * the role soul across every card that role owns.
 */
export function workerPrompt(
  card: Card,
  role: Role | null,
  all: Map<string, Card>,
  config: BoardConfig,
  workspaceNote?: string,
): { system: string; prompt: string } {
  const chain = ancestry(card, all, 6);
  const missionLines = chain.map((ancestor) => `- ${ancestor.id}: ${ancestor.title}`);
  const mission = missionLines.length
    ? clip(`Goal ancestry (outermost first):\n${missionLines.join("\n")}`, config.context.ancestryChars)
    : "";
  const handoffs = parentHandoffs(card, all, config);

  const sections = [
    `# Card ${card.id}\n${card.title}`,
    mission,
    `## Spec\n${clip(card.body || "(no body — treat the title as the whole spec)", config.context.bodyChars)}`,
    handoffs ? `## Inherited handoffs\n${handoffs}` : "",
    [
      "## Working agreement",
      workspaceNote ?? `- Workspace: ${card.workspace} (workdir ${config.workdir})`,
      role?.readOnly
        ? "- You are READ-ONLY: inspect and report, never modify, commit, or push."
        : "- You may edit files inside the workdir; do not touch anything outside it.",
      "- Finish with a HANDOFF block: at most 6 short lines for the next card.",
      "- If you cannot finish, end with BLOCKED: <one-line reason>.",
    ].join("\n"),
  ].filter((section) => section !== "");

  return { system: role?.soul ?? "", prompt: sections.join("\n\n") };
}

/**
 * Extract the trailing HANDOFF block a worker was asked to emit.
 *
 * The LAST marker wins: workers narrate ("I'll end with a HANDOFF block…"), and
 * anchoring on the first occurrence would capture prose and feed it to every
 * child card as inherited context.
 */
export function extractHandoff(output: string, limit = 800): string | null {
  const last = [...output.matchAll(/HANDOFF\s*:?\s*\n?/gi)].at(-1);
  if (!last) return null;
  const after = output.slice((last.index ?? 0) + last[0].length);
  // Models sometimes emit the block with literal backslash-n instead of real
  // newlines; normalise before splitting so the handoff stays readable.
  const raw = after.replace(/\\r\\n|\\n/g, "\n").trim();
  if (!raw) return null;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^```/.test(line))
    .slice(0, 6);
  if (lines.length === 0) return null;
  return clip(lines.join("\n"), limit);
}

/** A worker signals an honest stop with `BLOCKED: reason`. */
export function extractBlocked(output: string, limit = 240): string | null {
  const match = /^\s*BLOCKED\s*:\s*(.+)$/im.exec(output);
  const reason = match?.[1]?.trim();
  return reason ? clip(reason, limit) : null;
}
