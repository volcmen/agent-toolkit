import type { Store } from "./store.ts";
import type { Card, Runtime, Status } from "./types.ts";

export const LIFECYCLE_ACTIONS = [
  "send_to_triage",
  "move_to_todo",
  "make_ready",
  "block",
  "resolve",
  "complete",
  "reopen",
  "archive",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

const TARGET: Record<LifecycleAction, Status> = {
  send_to_triage: "triage",
  move_to_todo: "todo",
  make_ready: "ready",
  block: "blocked",
  resolve: "ready",
  complete: "done",
  reopen: "ready",
  archive: "archived",
};

const ALLOWED: Record<Status, readonly LifecycleAction[]> = {
  triage: ["move_to_todo", "make_ready", "block", "archive"],
  todo: ["send_to_triage", "make_ready", "block", "complete", "archive"],
  ready: ["send_to_triage", "move_to_todo", "block", "complete", "archive"],
  running: [],
  review: ["make_ready", "block", "complete", "archive"],
  blocked: ["send_to_triage", "move_to_todo", "resolve", "complete", "archive"],
  done: ["reopen", "archive"],
  archived: ["reopen"],
};

export function allowedLifecycleActions(card: Card, leased: boolean): LifecycleAction[] {
  if (leased || card.status === "running") return [];
  return [...ALLOWED[card.status]];
}

export function lifecycleStatus(
  card: Card,
  action: LifecycleAction,
  leased: boolean,
): Status {
  if (!LIFECYCLE_ACTIONS.includes(action)) throw new Error(`unknown lifecycle action: ${action}`);
  if (!allowedLifecycleActions(card, leased).includes(action)) {
    throw new Error(
      leased
        ? "card is being worked — stop the run first"
        : `action ${action} is not allowed from ${card.status}`,
    );
  }
  return TARGET[action];
}

export function lifecycleActionForStatus(card: Card, status: Status): LifecycleAction {
  if (status === "running") throw new Error("running is lease-controlled and cannot be set manually");
  const candidates = ALLOWED[card.status].filter((action) => TARGET[action] === status);
  if (candidates.length === 0) {
    throw new Error(`manual transition ${card.status} → ${status} is not allowed`);
  }
  return candidates[0] as LifecycleAction;
}

/**
 * A recorded session belongs to the runtime that created it: a codex thread id
 * is meaningless to `claude --resume` (it errors out and the failure breaker
 * eats the card) and a claude session id makes `codex exec resume` silently
 * start a different thread. Changing a card's runtime therefore invalidates its
 * session. Reassigning a role changes the runtime with it, so this fires on the
 * most ordinary edit there is.
 */
export function sessionSurvivesRuntime(card: Card, nextRuntime: Runtime | null | undefined): boolean {
  if (!card.sessionId) return true;
  if (nextRuntime === undefined) return true;
  return nextRuntime === card.runtime;
}

/** Resolve short ids to canonical ids and reject malformed dependency graphs. */
export function validateParents(store: Store, parents: unknown, selfId?: string): string[] {
  if (!Array.isArray(parents) || parents.some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new Error("parents must be an array of card ids");
  }
  const resolved = parents.map((id) => {
    const card = store.byId((id as string).trim());
    if (!card) throw new Error(`no such parent: ${(id as string).trim()}`);
    return card.id;
  });
  if (new Set(resolved).size !== resolved.length) throw new Error("duplicate parent id");
  if (selfId && resolved.includes(selfId)) throw new Error("a card cannot depend on itself");
  if (!selfId) return resolved;

  const graph = new Map(store.listAll().map((card) => [card.id, card.parents]));
  graph.set(selfId, resolved);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const parent of graph.get(id) ?? []) {
      if (visit(parent)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (visit(selfId)) throw new Error("dependency cycle detected");
  return resolved;
}

export function finiteNumber(
  value: unknown,
  field: string,
  options: { nullable?: boolean; min?: number; integer?: boolean } = {},
): number | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number${options.nullable ? " or null" : ""}`);
  }
  if (options.integer && !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${field} must be at least ${options.min}`);
  }
  return value;
}
