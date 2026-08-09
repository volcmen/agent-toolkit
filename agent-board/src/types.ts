/** Shared domain types. Cards are markdown files; leases live in SQLite. */

export const STATUSES = [
  "triage",
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "archived",
] as const;
export type Status = (typeof STATUSES)[number];

export const RUNTIMES = ["codex", "claude", "local"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export type Card = {
  id: string;
  path: string;
  title: string;
  body: string;
  status: Status;
  role: string | null;
  runtime: Runtime | null;
  model: string | null;
  /** Parent card ids. A card is gated until every parent is done. */
  parents: string[];
  /** Root of the goal tree — carries mission context down (Paperclip's goal ancestry). */
  root: string | null;
  /** Bounded summary written on completion; children read this, not transcripts. */
  handoff: string | null;
  /** Extra skills to force-load into the worker. */
  skills: string[];
  workspace: "scratch" | "repo" | "worktree";
  maxTurns: number | null;
  goal: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  blockedReason: string | null;
  sessionId: string | null;
  /** Present when persisted frontmatter failed validation. Such cards never dispatch or attach. */
  invalidReason?: string | null;
};

export type Role = {
  name: string;
  /** One-line routing hint the triage model matches against. */
  description: string;
  /** Long-form system prompt (SOUL.md body). */
  soul: string;
  runtime: Runtime;
  model: string | null;
  /** Read-only roles never get write/exec tools. */
  readOnly: boolean;
  skills: string[];
  maxTurns: number | null;
};

export type BoardConfig = {
  name: string;
  /** Absolute repo the workers operate in. */
  workdir: string;
  maxRunning: number;
  maxRunningPerRole: number;
  tickSeconds: number;
  failureLimit: number;
  staleSeconds: number;
  defaultRole: string;
  defaultRuntime: Runtime;
  /** Provider chain for triage/judge work, cheapest first. */
  triageChain: TriageProvider[];
  /**
   * Confidence a triage plan must reach to be applied. Below it the card is
   * parked for a human with the plan attached as a proposal, so a guess the
   * model does not believe never reaches a paid worker.
   */
  triageMinConfidence: number;
  /** Default per-run turn bound; cards and roles may override it. */
  maxTurns: number;
  context: {
    /** Hard caps so a card never carries an unbounded prompt. */
    bodyChars: number;
    handoffChars: number;
    ancestryChars: number;
    maxParents: number;
  };
};

export type TriageProvider = {
  kind: "local" | "codex" | "claude";
  model: string;
  baseUrl?: string;
};

export type RunOutcome = {
  ok: boolean;
  runId: string;
  sessionId: string | null;
  usd: number;
  turns: number;
  summary: string;
  error: string | null;
};
