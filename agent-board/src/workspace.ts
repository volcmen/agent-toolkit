/**
 * Workspace resolution. A card's `workspace` field decides *where* its worker may
 * write, and it is enforced here rather than being advisory:
 *
 *   repo      cwd = the board's workdir. The worker edits your checkout directly.
 *   worktree  a git worktree of the workdir on branch `ab/<card-tail>`, so
 *             parallel cards cannot collide in one tree.
 *   scratch   an empty directory. The repo is NOT reachable for writes — for
 *             analysis, drafting, and anything that should not touch code.
 *
 * `repo` is the default because it is what a coding card almost always wants;
 * a field that says "scratch" while writing to your checkout is worse than no
 * field at all.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "./types.ts";

export const WORK_DIR = join("board", ".work");

export type ResolvedWorkspace = {
  cwd: string;
  kind: Card["workspace"];
  /** Extra line appended to the worker's working agreement. */
  note: string;
  branch: string | null;
};

function tail(cardId: string): string {
  return cardId.replace(/^c_/, "");
}

async function run(argv: string[], cwd: string): Promise<{ ok: boolean; message: string }> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0, message: stderr.trim() };
  } catch (error) {
    // A missing workdir or missing git surfaces here; keep it in-band so the
    // caller can turn it into a blocked card with a readable reason.
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * Prepare the directory a worker will run in. Throws when a worktree is asked
 * for and git refuses — the dispatcher turns that into a blocked card rather
 * than silently falling back to the real checkout.
 */
export async function resolveWorkspace(
  root: string,
  workdir: string,
  card: Card,
  options: { create?: boolean } = {},
): Promise<ResolvedWorkspace> {
  // `create: false` is the preview mode used by `ab plan`: same paths and the
  // same note, but no directories and no git branches created.
  const create = options.create ?? true;
  if (card.workspace === "scratch") {
    const cwd = join(root, WORK_DIR, "scratch", tail(card.id));
    if (create) mkdirSync(cwd, { recursive: true });
    return {
      cwd,
      kind: "scratch",
      note: `- Scratch workspace: you are NOT in the project repo. Write only inside ${cwd}. The repo at ${workdir} is out of scope; if the card needs it, stop with BLOCKED.`,
      branch: null,
    };
  }

  if (card.workspace === "worktree") {
    const cwd = join(root, WORK_DIR, "worktrees", tail(card.id));
    const branch = `ab/${tail(card.id)}`;
    if (create && !existsSync(cwd)) {
      mkdirSync(join(root, WORK_DIR, "worktrees"), { recursive: true });
      const added = await run(["git", "worktree", "add", "-b", branch, cwd], workdir);
      if (!added.ok) {
        // Branch may already exist from an earlier run — attach to it instead.
        const reused = await run(["git", "worktree", "add", cwd, branch], workdir);
        if (!reused.ok) {
          throw new Error(`git worktree add failed: ${added.message || reused.message}`);
        }
      }
    }
    return {
      cwd,
      kind: "worktree",
      note: `- Isolated git worktree on branch ${branch}. Commit here; do not switch branches or touch ${workdir} directly.`,
      branch,
    };
  }

  return {
    cwd: workdir,
    kind: "repo",
    note: `- You are in the project checkout (${workdir}). Keep the diff minimal; do not commit or push unless the card says to.`,
    branch: null,
  };
}
