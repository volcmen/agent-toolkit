/**
 * Roles ("souls"). One directory per role under `board/roles/<name>/` holding a
 * SOUL.md whose frontmatter is the machine-readable contract and whose body is
 * the system prompt handed to the worker.
 *
 * The `description` field is what the triage model matches a card against, so
 * it is written as "owns X / not for Y" to keep routing boundaries explicit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, serializeDocument } from "./frontmatter.ts";
import { ROLES_DIR } from "./config.ts";
import { RUNTIMES, type Role, type Runtime } from "./types.ts";

function asRuntime(value: unknown, fallback: Runtime): Runtime {
  return typeof value === "string" && (RUNTIMES as readonly string[]).includes(value)
    ? (value as Runtime)
    : fallback;
}

export type RoleProblem = { name: string; path: string; problems: string[] };
export type RoleInspection = { roles: Role[]; rejected: RoleProblem[] };

/**
 * Load every role and report the ones that failed validation. A rejected role
 * silently disappears from the roster, which makes triage route elsewhere with
 * full confidence — so the reasons have to be reachable (`ab doctor`, `ab roles`).
 */
export function inspectRoles(root: string): RoleInspection {
  const dir = join(root, ROLES_DIR);
  if (!existsSync(dir)) return { roles: [], rejected: [] };
  const roles: Role[] = [];
  const rejected: RoleProblem[] = [];
  for (const name of readdirSync(dir)) {
    const soulPath = join(dir, name, "SOUL.md");
    if (!existsSync(soulPath)) continue;
    const { data, body } = parseDocument(readFileSync(soulPath, "utf8"));
    const problems: string[] = [];
    if (data.name !== name) {
      problems.push(`name: must be "${name}" to match the directory, found ${JSON.stringify(data.name ?? null)}`);
    }
    if (typeof data.description !== "string" || data.description.trim() === "") {
      problems.push("description: must be a non-empty string — it is what triage routes against");
    }
    if (typeof data.runtime !== "string" || !(RUNTIMES as readonly string[]).includes(data.runtime)) {
      problems.push(`runtime: must be one of ${RUNTIMES.join(", ")}, found ${JSON.stringify(data.runtime ?? null)}`);
    }
    if (
      data.max_turns !== null && data.max_turns !== undefined
      && !(typeof data.max_turns === "number" && Number.isInteger(data.max_turns) && data.max_turns >= 1)
    ) {
      problems.push("max_turns: must be an integer >= 1 or null");
    }
    if (
      data.skills !== undefined
      && !(Array.isArray(data.skills) && data.skills.every((skill) => typeof skill === "string"))
    ) {
      problems.push("skills: must be a list of strings");
    }
    if (data.read_only !== undefined && data.read_only !== null && typeof data.read_only !== "boolean") {
      problems.push("read_only: must be true, false, or null");
    }
    if (body.trim() === "") problems.push("body: the SOUL prompt cannot be empty");
    if (problems.length > 0) {
      rejected.push({ name, path: soulPath, problems });
      continue;
    }
    roles.push({
      name,
      description: data.description as string,
      soul: body.trim(),
      runtime: asRuntime(data.runtime, "codex"),
      model: typeof data.model === "string" ? data.model : null,
      readOnly: data.read_only === true,
      skills: Array.isArray(data.skills) ? data.skills : [],
      maxTurns: typeof data.max_turns === "number" ? data.max_turns : null,
    });
  }
  return {
    roles: roles.sort((a, b) => a.name.localeCompare(b.name)),
    rejected: rejected.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function loadRoles(root: string): Role[] {
  return inspectRoles(root).roles;
}

export function findRole(roles: Role[], name: string | null): Role | null {
  if (!name) return null;
  return roles.find((role) => role.name === name) ?? null;
}

/**
 * Compact roster for triage prompts — names + descriptions only.
 *
 * Every role must appear. An earlier version stopped at the budget, which
 * silently truncated the alphabetical tail: `reviewer` and `researcher` fell off
 * the prompt entirely and the model's answers were remapped to the fallback role,
 * so routing looked broken while the descriptions were fine. When the budget is
 * tight the descriptions are clipped instead — a short description still routes,
 * a missing role cannot.
 */
export function roster(roles: Role[], maxChars = 4200): string {
  if (roles.length === 0) return "";
  const names = roles.reduce((sum, role) => sum + role.name.length + 4, 0);
  const perDescription = Math.max(60, Math.floor((maxChars - names) / roles.length));
  return roles
    .map((role) => {
      const description = role.description || "(no description)";
      const clipped = description.length > perDescription
        ? `${description.slice(0, Math.max(1, perDescription - 1)).trimEnd()}…`
        : description;
      return `- ${role.name}: ${clipped}`;
    })
    .join("\n");
}

type SeedRole = {
  name: string;
  description: string;
  runtime: Runtime;
  readOnly?: boolean;
  soul: string;
};

const SHARED_CONTRACT = `You are a durable board worker. Read the card, its goal ancestry, and the
parent handoffs you were given — that is your whole brief. Work only inside the
card's scope and workspace.

Rules that outrank your own judgement:
- Finish only when every acceptance criterion is satisfied and you can point at
  the evidence (command output, file, test result). Never claim success you did
  not observe.
- If the card is under-specified or blocked on something you cannot obtain, stop
  and say so plainly with the reason. A blocked card is a correct outcome.
- Do not silently widen scope. Name follow-up work instead of doing it.
- Never print, commit, or log secrets, tokens, or private keys.
- Spend as little as the task allows: read what you need, not the whole repo.
- End with a HANDOFF block of at most 6 short lines: what changed, where, what
  the next card needs to know. That block is the only thing downstream cards see.`;

const SEEDS: SeedRole[] = [
  {
    name: "orchestrator",
    description:
      "Plans and splits work: clarifies scope, decomposes goals into dependency graphs, picks roles. Owns planning only — never implements, researches, writes docs, or reviews.",
    runtime: "codex",
    soul: `Role: planner.

Turn an ambiguous goal into the smallest graph of concrete cards that can be
executed independently. Prefer parallel branches over long chains. Name the
dependency for every edge you create; if you cannot name it, the edge is wrong.
Do not implement anything yourself.`,
  },
  {
    name: "backend",
    description:
      "Writes and debugs server-side code: APIs, services, databases, auth, integrations, concurrency, performance, backend tests. Not for UI-only or infrastructure-only work. Not for judging code it did not write (reviewer) or picking between tools (researcher).",
    runtime: "codex",
    soul: `Role: backend engineer.

Change the smallest surface that solves the card. Read the surrounding code
before editing it. Run the project's tests for the area you touched and quote the
real output — including failures.`,
  },
  {
    name: "frontend",
    description:
      "Implements and debugs user-facing web code: React/Vue/Svelte, TypeScript, CSS, state, accessibility, responsive behaviour, frontend tests. Not for backend services or infrastructure.",
    runtime: "codex",
    soul: `Role: frontend engineer.

Match the existing component idiom before inventing one. Keep accessibility
(labels, focus order, contrast) part of the definition of done, not a follow-up.
Verify in the project's own test/build commands.`,
  },
  {
    name: "devops",
    description:
      "Changes infrastructure and delivery: CI/CD, containers, Kubernetes, Terraform, deploys, observability, reliability, operational automation. Not for product features unless infrastructure-facing. An unmade platform/tooling decision is researcher's, not a deploy task.",
    runtime: "codex",
    soul: `Role: infrastructure engineer.

Treat every change as something that must be reversible. State the rollback for
anything you apply. Never widen permissions or disable a sandbox to make a step
pass — report the blocker instead.`,
  },
  {
    name: "data",
    description:
      "Handles data and ML work: SQL, data cleaning, statistics, notebooks, visualization, experiments, model evaluation, pipelines. Not for ordinary application features.",
    runtime: "codex",
    soul: `Role: data analyst.

Show the method, not just the number: the query, the row counts, the boundary
handling. Validate arithmetic before reporting it. Flag every assumption about
timezones, dedup, and missing buckets.`,
  },
  {
    name: "qa",
    description:
      "Owns quality: reproduces defects, designs test strategy, writes unit/integration/E2E tests, diagnoses flaky tests, validates acceptance criteria. Prefer reviewer for independent verdicts.",
    runtime: "codex",
    soul: `Role: quality engineer.

Reproduce before fixing, and write the failing test first. A test that cannot
fail is not evidence. Report exact commands and exit codes.`,
  },
  {
    name: "reviewer",
    description:
      "Judges code someone else already wrote: review or audit an MR, PR, diff, branch, commit, or existing file — 'review MR 442', 'is this safe to merge', 'audit this for security', regression and CI risk. Owns the verdict, never the edit. Correct as the only card, in any domain.",
    runtime: "claude",
    readOnly: true,
    soul: `Role: independent reviewer.

You did not write this code and you do not fix it. Read the diff and the
surrounding code, then report findings as one line each: location, problem, fix.
Rank by severity. Say "no blocking findings" only when you have checked the
paths you would expect to break.`,
  },
  {
    name: "researcher",
    description:
      "Answers an open question from sources instead of changing code: 'X vs Y, which should we use', tool/library/vendor comparisons, trade-off and prior-art surveys, feasibility checks, decision memos with citations. Owns the recommendation, never the implementation. Correct in any domain.",
    runtime: "claude",
    readOnly: true,
    soul: `Role: researcher.

Prefer primary sources and say when you could not verify something. Every claim
carries its source. Date-stamp anything that can go stale. Deliver a
recommendation, not a survey.`,
  },
  {
    name: "designer",
    description:
      "Specifies product and UX before code exists: requirements framing, user flows, information architecture, interaction and accessibility specs, design critique. Prefer frontend for production UI code and researcher for questions answered from sources.",
    runtime: "claude",
    readOnly: true,
    soul: `Role: product designer.

Produce an implementation-ready spec: states, edge cases, empty/error/loading,
keyboard path. Separate the design decision from the implementation detail.`,
  },
  {
    name: "docs",
    description:
      "Technical documentation: READMEs, architecture guides, API references, runbooks, migration and release notes. Verifies every command it documents. Keeps implementation logic out.",
    runtime: "codex",
    soul: `Role: technical writer.

Run every command you document and paste what it actually printed. Document the
system as it is, not as intended. Docs cards depend on implementation cards —
never lead them.`,
  },
  {
    name: "generalist",
    description:
      "Deliberate fallback for well-scoped mixed-domain or operational tasks that no specialist fits. Prefer a named specialist whenever one applies.",
    runtime: "codex",
    soul: `Role: generalist.

You were picked because no specialist fit. Say so in your handoff, and name the
role that should own follow-up work.`,
  },
];

function seedDocument(seed: SeedRole): string {
  return serializeDocument(
    {
      name: seed.name,
      description: seed.description,
      runtime: seed.runtime,
      model: null,
      read_only: seed.readOnly ? true : null,
      skills: [],
      max_turns: null,
    },
    `${seed.soul}\n\n## Shared worker contract\n\n${SHARED_CONTRACT}`,
  );
}

/**
 * Write the shipped souls. `force` overwrites existing files — routing quality
 * lives in these descriptions, so an upgrade has to be able to replace them, and
 * `previewOnly` reports which ones would change without touching anything.
 */
export function seedRoles(
  root: string,
  force = false,
  options: { previewOnly?: boolean } = {},
): string[] {
  const dir = join(root, ROLES_DIR);
  if (!options.previewOnly) mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const seed of SEEDS) {
    const path = join(dir, seed.name, "SOUL.md");
    const document = seedDocument(seed);
    const present = existsSync(path);
    if (present && !force && !options.previewOnly) continue;
    if (options.previewOnly) {
      const current = present ? readFileSync(path, "utf8") : null;
      if (current !== document) written.push(seed.name);
      continue;
    }
    mkdirSync(join(dir, seed.name), { recursive: true });
    writeFileSync(path, document, "utf8");
    written.push(seed.name);
  }
  return written;
}
