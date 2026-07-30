/**
 * Board discovery: given a working directory, which board is "this project's"?
 *
 * Precedence, highest first:
 *
 *   1. `--board <path>` for this process (`setExplicitBoard`)
 *   2. `AB_BOARD` in the environment
 *   3. walk-up — the nearest ancestor containing `board/cards`
 *   4. the registry — a board whose `workdir` is this directory or an ancestor
 *
 * Walk-up always beats the registry. A board that physically lives in the tree
 * you are standing in is the board for that tree, full stop; otherwise
 * `ab init ~/code/app` followed by a registered board that merely *points* at
 * `~/code/app` would fight over the same directory and the winner would depend
 * on registration order.
 *
 * Registry matches are ranked by how specifically they claim the directory
 * (deepest `workdir` wins). A genuine tie — two boards registered against the
 * same `workdir`, which is legal and is how you run two workstreams over one
 * repo — is reported as ambiguous rather than resolved by luck, because picking
 * wrong here means a worker writes into the wrong checkout.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { CARDS_DIR, CONFIG_FILE, findRoot } from "./config.ts";
import { allProjectEntries, type BoardProject } from "./projects.ts";

export type BoardSource = "explicit" | "env" | "walk-up" | "registry";

export type BoardResolution = {
  root: string | null;
  source: BoardSource | null;
  /** One line explaining the choice, shown by `ab where` and `ab doctor`. */
  reason: string;
  /** Registered boards that claim this directory equally well. */
  ambiguous: BoardProject[];
  /** Registry boards that claim this directory, best first. */
  candidates: BoardProject[];
  /** A ready-to-run `ab init …` when nothing was found. */
  suggestion: string | null;
};

let explicitBoard: string | null = null;

/**
 * Set the `--board` override for this process. Deliberately module state rather
 * than an environment variable: the dashboard builds its per-project handlers
 * from explicit roots, and an env var would leak into those and silently
 * retarget a project the browser selected by id.
 */
export function setExplicitBoard(path: string | null): void {
  explicitBoard = path === null ? null : resolve(path);
}

export function explicitBoardPath(): string | null {
  return explicitBoard;
}

function isBoardRoot(path: string): boolean {
  return existsSync(join(path, CARDS_DIR)) || existsSync(join(path, CONFIG_FILE));
}

/** True when `parent` is `child` or contains it — path-segment aware. */
function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function depth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

/** Nearest ancestor holding a `.git`, used only to suggest an `ab init` target. */
function gitRoot(start: string): string | null {
  let dir = resolve(start);
  for (let hop = 0; hop < 24; hop += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function resolveBoard(cwd = process.cwd()): BoardResolution {
  const here = resolve(cwd);
  const empty = { ambiguous: [] as BoardProject[], candidates: [] as BoardProject[], suggestion: null };

  if (explicitBoard) {
    return isBoardRoot(explicitBoard)
      ? { root: explicitBoard, source: "explicit", reason: `--board ${explicitBoard}`, ...empty }
      : {
          root: null,
          source: null,
          reason: `--board ${explicitBoard} has no board/ directory`,
          ...empty,
          suggestion: `ab init ${explicitBoard}`,
        };
  }

  const fromEnv = process.env.AB_BOARD?.trim();
  if (fromEnv) {
    const target = isAbsolute(fromEnv) ? fromEnv : resolve(here, fromEnv);
    return isBoardRoot(target)
      ? { root: target, source: "env", reason: `AB_BOARD=${target}`, ...empty }
      : {
          root: null,
          source: null,
          reason: `AB_BOARD=${target} has no board/ directory`,
          ...empty,
          suggestion: `ab init ${target}`,
        };
  }

  // Registry candidates are collected either way so `ab where` can explain what
  // it did *not* pick, but they never outrank a board found in the tree.
  let registered: BoardProject[] = [];
  try {
    registered = allProjectEntries();
  } catch {
    // A corrupt registry must not stop a board that is right here.
  }
  const claiming = registered
    .filter((project) => contains(project.workdir, here) || contains(project.root, here))
    .sort((a, b) => depth(b.workdir) - depth(a.workdir) || a.root.localeCompare(b.root));

  const walked = findRoot(here);
  if (walked) {
    const alsoRegistered = claiming.filter((project) => project.root !== resolve(walked));
    return {
      root: walked,
      source: "walk-up",
      reason: `board/ found at ${walked}${
        alsoRegistered.length > 0
          ? ` (in the tree, so it wins over ${alsoRegistered.length} registered board(s) pointing here)`
          : ""
      }`,
      ambiguous: [],
      candidates: claiming,
      suggestion: null,
    };
  }

  const best = claiming[0];
  if (best) {
    const tied = claiming.filter((project) => depth(project.workdir) === depth(best.workdir));
    if (tied.length > 1) {
      return {
        root: null,
        source: null,
        reason: `${tied.length} registered boards claim ${here} through the same workdir — say which one`,
        ambiguous: tied,
        candidates: claiming,
        suggestion: `ab --board ${tied[0]?.root} <command>`,
      };
    }
    if (!isBoardRoot(best.root)) {
      return {
        root: null,
        source: null,
        reason: `registered board ${best.root} is gone — \`ab projects remove ${best.id}\``,
        ambiguous: [],
        candidates: claiming,
        suggestion: `ab projects remove ${best.id}`,
      };
    }
    return {
      root: best.root,
      source: "registry",
      reason: `registered board "${best.name}" works on ${best.workdir}`,
      ambiguous: [],
      candidates: claiming,
      suggestion: null,
    };
  }

  const repo = gitRoot(here);
  return {
    root: null,
    source: null,
    reason: `no board covers ${here}`,
    ambiguous: [],
    candidates: [],
    suggestion: repo ? `ab init ${repo}` : `ab init ${here}`,
  };
}

/** Resolve or explain. Every `ab` command that needs a board goes through this. */
export function requireBoardRoot(cwd = process.cwd()): string {
  const resolution = resolveBoard(cwd);
  if (resolution.root) return resolution.root;
  const lines = [resolution.reason];
  for (const project of resolution.ambiguous) {
    lines.push(`  ${project.name}  board ${project.root}  workdir ${project.workdir}`);
  }
  if (resolution.suggestion) lines.push(`try: ${resolution.suggestion}`);
  lines.push("`ab where` explains how a board is chosen");
  throw new Error(lines.join("\n"));
}
