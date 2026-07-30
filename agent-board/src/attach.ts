/**
 * Attach: drop into a real interactive agent session on a card — the thing you
 * actually want when a worker got 80% of the way and you need to steer.
 *
 * Two modes:
 *   resume  reopen the session the last run created (codex thread / claude session)
 *   fresh   start a new interactive session pre-seeded with the card's prompt
 *
 * stdio is inherited, so this is the agent's own TUI, not a wrapper.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BoardConfig, Card, Role, Runtime } from "./types.ts";
import { codexDeveloperInstructions, promptWithSkills } from "./runners.ts";

export type AttachPlan = {
  argv: string[];
  /** Seed text written to a temp file and shown to the user when fresh. */
  seedPath: string | null;
  cwd: string;
  note: string;
};

export function attachPlan(
  card: Card,
  role: Role | null,
  config: BoardConfig,
  options: {
    runtime?: Runtime;
    fresh?: boolean;
    prompt?: string;
    system?: string;
    skills?: string[];
    cwd?: string;
  },
): AttachPlan {
  const runtime = options.runtime ?? card.runtime ?? role?.runtime ?? config.defaultRuntime;
  const model = card.model ?? role?.model ?? null;
  // `--runtime` is a per-attach override that does not touch the card, so the
  // recorded session may belong to the other CLI. Never hand it over.
  const foreignSession = card.runtime !== null && runtime !== card.runtime;
  const resume = !options.fresh && !foreignSession && card.sessionId ? card.sessionId : null;
  const cwd = options.cwd ?? config.workdir;
  const system = options.system ?? role?.soul ?? "";
  const prompt = options.prompt
    ? promptWithSkills(options.prompt, options.skills ?? [], runtime)
    : undefined;

  if (runtime === "codex") {
    const argv = [
      "codex",
      "-s",
      role?.readOnly ? "read-only" : "workspace-write",
      "-C",
      cwd,
      "-c",
      codexDeveloperInstructions(system),
    ];
    if (model) argv.push("-m", model);
    if (resume) argv.push("resume", resume);
    if (prompt) argv.push(prompt);
    return {
      argv,
      seedPath: null,
      cwd,
      note: resume
        ? `resuming codex thread ${resume}`
        : foreignSession && card.sessionId
          ? `fresh codex session — the recorded session belongs to ${card.runtime}`
          : "fresh codex session",
    };
  }

  if (runtime === "claude") {
    const argv = ["claude", "--append-system-prompt", system];
    if (resume) argv.push("--resume", resume);
    if (model) argv.push("--model", model);
    if (role?.readOnly) argv.push("--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch");
    else argv.push("--permission-mode", "acceptEdits", "--add-dir", cwd);
    if (prompt) argv.push(prompt);
    return {
      argv,
      seedPath: null,
      cwd,
      note: resume
        ? `resuming claude session ${resume}`
        : foreignSession && card.sessionId
          ? `fresh claude session — the recorded session belongs to ${card.runtime}`
          : "fresh claude session",
    };
  }

  // Local models have no interactive CLI here; hand the user the prompt instead.
  const seedPath = join(tmpdir(), `ab-${card.id}.md`);
  writeFileSync(seedPath, prompt ?? card.body, "utf8");
  return {
    argv: [],
    seedPath,
    cwd,
    note: `local runtime has no interactive session — prompt written to ${seedPath}`,
  };
}

export async function attach(plan: AttachPlan): Promise<number> {
  if (plan.argv.length === 0) return 0;
  const proc = Bun.spawn(plan.argv, {
    cwd: plan.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}
