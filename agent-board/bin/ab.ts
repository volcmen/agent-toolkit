#!/usr/bin/env bun
/**
 * `ab` — agent board CLI.
 *
 * Cards are markdown, leases are SQLite, workers are your existing agent CLIs.
 * Nothing here talks to a network service; everything is local files + processes.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BOARD_DIR,
  CONFIG_FILE,
  defaultConfig,
  loadConfig,
} from "../src/config.ts";
import { requireBoardRoot as requireRoot, resolveBoard, setExplicitBoard } from "../src/discover.ts";
import { Store } from "../src/store.ts";
import { LeaseDb, today } from "../src/lease.ts";
import { inspectRoles, loadRoles, roster, seedRoles } from "../src/roles.ts";
import { findPrompt, loadPrompts, render, seedPrompts } from "../src/prompts.ts";
import { tick } from "../src/dispatcher.ts";
import { triageCard } from "../src/triage.ts";
import { effectiveSkills, logPathFor, previewArgv, readLogTail } from "../src/runners.ts";
import { workerPrompt } from "../src/context.ts";
import { resolveWorkspace } from "../src/workspace.ts";
import { attach, attachPlan } from "../src/attach.ts";
import { createServer } from "../src/server.ts";
import {
  allProjectEntries,
  DEFAULT_DASHBOARD_PORT,
  registerProject,
  unregisterProject,
} from "../src/projects.ts";
import { cardsById } from "../src/dispatcher.ts";
import * as limits from "../src/limits.ts";
import { RUNTIMES, STATUSES, type Card, type Runtime, type Status } from "../src/types.ts";
import {
  finiteNumber,
  lifecycleActionForStatus,
  lifecycleStatus,
  sessionSurvivesRuntime,
  validateParents,
  type LifecycleAction,
} from "../src/domain.ts";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name as string] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name as string] = next;
      index += 1;
    } else {
      flags[name as string] = true;
    }
  }
  return { positional, flags };
}

const str = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;
const num = (flags: Flags, name: string): number | undefined => {
  const value = str(flags, name);
  return value !== undefined && Number.isFinite(Number(value)) ? Number(value) : undefined;
};
const bool = (flags: Flags, name: string): boolean => flags[name] === true || flags[name] === "true";
const finiteFlag = (
  flags: Flags,
  name: string,
  options: { min?: number; integer?: boolean } = {},
): number | undefined => {
  if (flags[name] === undefined) return undefined;
  const value = flags[name];
  try {
    return finiteNumber(
      typeof value === "string" && value.trim() !== "" ? Number(value) : value,
      `--${name}`,
      options,
    ) as number;
  } catch (error) {
    die((error as Error).message);
  }
};

function out(line = ""): void {
  console.log(line);
}

function die(message: string): never {
  console.error(`ab: ${message}`);
  process.exit(1);
}

const COLUMNS: Status[] = ["triage", "todo", "ready", "running", "review", "blocked", "done"];

function shortId(id: string): string {
  return id.replace(/^c_/, "");
}

function cardLine(card: Card): string {
  const bits = [
    shortId(card.id).padEnd(9),
    (card.role ?? "-").padEnd(12),
    (card.runtime ?? "-").padEnd(7),
    card.title,
  ];
  const suffix = card.blockedReason ? `  ← ${card.blockedReason}` : "";
  return `  ${bits.join(" ")}${suffix}`;
}

// --------------------------------------------------------------------------- //
// commands
// --------------------------------------------------------------------------- //

function cmdInit(positional: string[], flags: Flags): void {
  const root = resolve(positional[0] ?? process.cwd());
  const store = new Store(root);
  store.ensureDirs();
  const workdir = resolve(str(flags, "workdir") ?? root);
  const configPath = join(root, CONFIG_FILE);
  if (!existsSync(configPath) || bool(flags, "force")) {
    const config = { ...defaultConfig(workdir), name: str(flags, "name") ?? "board" };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
  const gitignore = join(root, BOARD_DIR, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, ".state/\n.logs/\n.work/\n", "utf8");
  }
  const roles = seedRoles(root, bool(flags, "force"));
  const prompts = seedPrompts(root, bool(flags, "force"));
  new LeaseDb(root).close();
  // Register on creation: without this the board is invisible to the dashboard
  // and undiscoverable from its own workdir until someone runs `ab projects add`.
  let registered: string | null = null;
  if (!bool(flags, "no-register")) {
    try {
      registered = registerProject(root).id;
    } catch (error) {
      out(`warning: could not register the board: ${(error as Error).message}`);
    }
  }
  out(`board ready at ${join(root, BOARD_DIR)}`);
  out(`workdir: ${workdir}`);
  if (registered) out(`registered as ${registered} — discoverable from ${workdir} and in \`ab serve\``);
  out(`roles seeded: ${roles.length ? roles.join(", ") : "(already present)"}`);
  out(`prompts seeded: ${prompts.length ? prompts.join(", ") : "(already present)"}`);
  out(`next: ab add "<your goal>"   then   ab dispatch`);
}

async function cmdAdd(positional: string[], flags: Flags): Promise<void> {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const roles = loadRoles(root);

  let title = positional.join(" ").trim();
  let body = str(flags, "body") ?? "";
  const promptName = str(flags, "prompt");
  if (promptName) {
    const prompt = findPrompt(root, promptName);
    if (!prompt) die(`no such prompt: ${promptName} (see \`ab prompts\`)`);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(flags)) {
      if (typeof value === "string") values[key] = value;
    }
    const rendered = render(prompt.body, values);
    if (rendered.missing.length) {
      out(`warning: unfilled prompt variables: ${rendered.missing.join(", ")}`);
    }
    body = body ? `${body}\n\n${rendered.text}` : rendered.text;
    if (!title) title = prompt.description || prompt.name;
    if (!str(flags, "role") && prompt.role) flags.role = prompt.role;
  }
  if (!title) die('a title is required: ab add "<goal>"');

  const bodyFile = str(flags, "body-file");
  if (bodyFile) body = `${body ? `${body}\n\n` : ""}${readFileSync(bodyFile, "utf8")}`;

  const role = str(flags, "role") ?? null;
  if (role && !roles.some((candidate) => candidate.name === role)) {
    die(`no such role: ${role} (see \`ab roles\`)`);
  }
  const runtimeFlag = str(flags, "runtime");
  if (runtimeFlag && !(RUNTIMES as readonly string[]).includes(runtimeFlag)) {
    die(`runtime must be one of ${RUNTIMES.join(", ")}`);
  }
  const roleDef = roles.find((candidate) => candidate.name === role) ?? null;
  const skipTriage = bool(flags, "no-triage") || role !== null;
  const workspace = str(flags, "workspace") ?? "repo";
  if (!["repo", "worktree", "scratch"].includes(workspace)) {
    die("workspace must be one of repo, worktree, scratch");
  }
  let parents: string[];
  try {
    parents = validateParents(
      store,
      (str(flags, "parent") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    );
  } catch (error) {
    die((error as Error).message);
  }
  const all = cardsById(store.listAll());
  const dependenciesDone = parents.every((id) => {
    const parent = all.get(id);
    return parent?.status === "done" || parent?.status === "archived";
  });

  const card = store.create({
    title,
    body,
    role,
    runtime: (runtimeFlag as Runtime | undefined) ?? roleDef?.runtime ?? null,
    model: str(flags, "model") ?? roleDef?.model ?? null,
    parents,
    workspace: workspace as Card["workspace"],
    maxTurns: finiteFlag(flags, "max-turns", { min: 1, integer: true }) ?? roleDef?.maxTurns ?? null,
    priority: finiteFlag(flags, "priority") ?? 0,
    goal: bool(flags, "goal"),
    skills: (str(flags, "skill") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    status: skipTriage ? dependenciesDone ? "ready" : "todo" : "triage",
  });

  out(`created ${card.id} (${card.status}) ${card.path.replace(`${root}/`, "")}`);
  if (!skipTriage) out(`triage will spec + split + route it on the next tick (or run: ab triage ${shortId(card.id)})`);
  if (skipTriage) out(`role ${card.role ?? config.defaultRole} — ready to dispatch`);
}

function cmdLs(_positional: string[], flags: Flags): void {
  const root = requireRoot();
  const store = new Store(root);
  const db = new LeaseDb(root);
  const cards = store.list();
  const wanted = str(flags, "status");
  const asJson = bool(flags, "json");
  const showArchived = bool(flags, "all") || wanted === "archived";

  if (asJson) {
    const scope = showArchived ? store.listAll() : cards;
    out(JSON.stringify(scope.filter((card) => !wanted || card.status === wanted), null, 2));
    db.close();
    return;
  }

  for (const column of COLUMNS) {
    if (wanted && column !== wanted) continue;
    const inColumn = cards.filter((card) => card.status === column);
    if (inColumn.length === 0) continue;
    out(`${column.toUpperCase()} (${inColumn.length})`);
    for (const card of inColumn) out(cardLine(card));
    out();
  }
  if (showArchived) {
    const archived = store.listArchived();
    if (archived.length) {
      out(`ARCHIVED (${archived.length})`);
      for (const card of archived) out(cardLine(card));
    }
  }
  out(`tracked usage (${today()} UTC): $${db.spentToday().toFixed(4)}, ${db.tokensToday()} tokens`);
  db.close();
}

function cmdShow(positional: string[], flags: Flags): void {
  const root = requireRoot();
  const store = new Store(root);
  const db = new LeaseDb(root);
  const card = store.requireById(positional[0] ?? die("card id required"));
  if (bool(flags, "json")) {
    out(JSON.stringify({ card, runs: db.runs(card.id), spent: db.spentOnCard(card.id) }, null, 2));
    db.close();
    return;
  }
  out(`${card.id}  ${card.title}`);
  out(`status:   ${card.status}${card.blockedReason ? `  (${card.blockedReason})` : ""}`);
  out(`role:     ${card.role ?? "-"}    runtime: ${card.runtime ?? "-"}    model: ${card.model ?? "(role default)"}`);
  out(`parents:  ${card.parents.length ? card.parents.join(", ") : "-"}    root: ${card.root ?? "-"}`);
  out(`usage:    $${db.spentOnCard(card.id).toFixed(4)}, ${db.tokensOnCard(card.id)} tokens`);
  if (card.sessionId) out(`session:  ${card.sessionId}  (ab attach ${shortId(card.id)})`);
  out(`file:     ${card.path}`);
  if (card.handoff) out(`\nhandoff:\n${card.handoff}`);
  out(`\n${card.body || "(no body)"}`);
  const runs = db.runs(card.id, 5);
  if (runs.length) {
    out(`\nruns:`);
    for (const run of runs) {
      const status = run.ok === null ? "in-flight" : run.ok ? "ok" : "fail";
      out(
        `  ${run.runId}  ${status.padEnd(9)} ${run.runtime}/${run.model}  $${run.usd.toFixed(4)}  ${run.turns} turn(s)${run.error ? `  ${run.error}` : ""}`,
      );
    }
  }
  db.close();
}

async function cmdTriage(positional: string[], flags: Flags): Promise<void> {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const db = new LeaseDb(root);
  const roles = loadRoles(root);
  const targets = positional.length
    ? positional.map((id) => store.requireById(id))
    : store.list().filter((card) => card.status === "triage");
  if (targets.length === 0) {
    out("nothing in triage");
    db.close();
    return;
  }
  for (const card of targets) {
    if (db.lease(card.id) || db.hasActiveTriage(card.id) || card.status === "running") {
      out(`${card.id}: card is being worked — stop the run first`);
      continue;
    }
    if (card.status !== "triage") {
      out(`${card.id}: only cards in triage may be triaged`);
      continue;
    }
    const outcome = await triageCard(store, db, config, roles, card, {
      minConfidence: num(flags, "min-confidence") ?? config.triageMinConfidence,
      log: (line) => out(`  ${line}`),
    });
    if (!outcome.ok) {
      out(`${card.id}: triage failed — ${outcome.error}`);
      continue;
    }
    if (outcome.parked) {
      const bar = num(flags, "min-confidence") ?? config.triageMinConfidence;
      out(
        `${card.id}: PARKED — confidence ${outcome.plan?.confidence.toFixed(2)} below ${bar.toFixed(2)}; `
        + `the proposal is on the card, nothing was created`,
      );
      out(`  sharpen it, then: ab set ${shortId(card.id)} --action send_to_triage`);
    } else if (outcome.created.length) {
      out(`${card.id}: split into ${outcome.created.length} cards via ${outcome.provider}`);
      for (const childId of outcome.created) {
        const child = store.byId(childId);
        if (child) out(cardLine(child));
      }
    } else {
      const updated = store.byId(card.id);
      out(`${card.id}: specified + routed to ${updated?.role} via ${outcome.provider}`);
    }
    if (outcome.unknownRoles?.length) {
      out(`  WARNING: asked for unknown role(s) ${outcome.unknownRoles.join(", ")} — check \`ab roles\``);
    }
    if (outcome.plan) out(`  rationale: ${outcome.plan.rationale} (confidence ${outcome.plan.confidence})`);
  }
  db.close();
}

async function cmdDispatch(_positional: string[], flags: Flags): Promise<void> {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const db = new LeaseDb(root);
  const report = await tick(store, db, config, {
    dryRun: bool(flags, "dry-run"),
    maxTriagePerTick: num(flags, "max-triage") ?? 2,
    log: (line) => out(line),
  });
  if (bool(flags, "json")) out(JSON.stringify(report, null, 2));
  else {
    const preview = bool(flags, "dry-run");
    const starts = preview
      ? report.skipped.filter((item) => item.reason === "dry-run: would run").length
      : report.started.length;
    out(
      `${preview ? "preview" : "tick"}: ${preview ? "reclaim" : "reclaimed"}=${report.reclaimed.length} recovered=${report.recovered.length} ${preview ? "promote" : "promoted"}=${report.promoted.length} ${preview ? "start" : "started"}=${starts} skipped=${report.skipped.length}`,
    );
    for (const skipped of report.skipped) out(`  skip ${shortId(skipped.cardId)}: ${skipped.reason}`);
    for (const finished of report.finished) {
      out(`  ${shortId(finished.cardId)} → ${finished.status} ($${finished.usd.toFixed(4)})`);
    }
  }
  db.close();
}

async function cmdDaemon(_positional: string[], flags: Flags): Promise<void> {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const db = new LeaseDb(root);
  const intervalMs = (num(flags, "interval") ?? config.tickSeconds) * 1000;
  const maxTicks = num(flags, "ticks") ?? Infinity;
  out(`daemon: every ${intervalMs / 1000}s, ${config.maxRunning} concurrent, ctrl-c to stop`);
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    out("\nstopping after the current tick…");
  });
  for (let count = 0; count < maxTicks && !stop; count += 1) {
    const report = await tick(store, db, config, {
      maxTriagePerTick: num(flags, "max-triage") ?? 2,
      log: (line) => out(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
    });
    const busy =
      report.started.length + report.triaged.length + report.promoted.length + report.reclaimed.length + report.recovered.length;
    if (!busy) out(`[${new Date().toISOString().slice(11, 19)}] idle`);
    if (stop) break;
    await Bun.sleep(intervalMs);
  }
  db.close();
}

function cmdRoles(_positional: string[], flags: Flags): number {
  const root = requireRoot();
  const { roles, rejected } = inspectRoles(root);

  if (bool(flags, "reseed")) {
    const shipped = seedRoles(root, false, { previewOnly: true });
    if (shipped.length === 0) {
      out("every shipped role already matches this version");
      return 0;
    }
    if (!bool(flags, "yes")) {
      out(`${shipped.length} shipped role(s) differ from this version:`);
      for (const name of shipped) out(`  ${name}`);
      out("\nre-run with --yes to overwrite those SOUL.md files (local edits to them are lost)");
      return 0;
    }
    for (const name of seedRoles(root, true)) out(`reseeded ${name}`);
    return 0;
  }

  if (bool(flags, "json")) {
    out(JSON.stringify({ roles, rejected }, null, 2));
    return rejected.length ? 1 : 0;
  }
  if (bool(flags, "roster")) {
    out(roster(roles, 100_000));
    return 0;
  }
  for (const role of roles) {
    out(
      `${role.name.padEnd(14)} ${role.runtime.padEnd(7)} ${role.readOnly ? "read-only" : "writes   "}  ${role.description}`,
    );
  }
  // A rejected soul vanishes from the roster, so triage silently stops routing
  // to it. Never let that be invisible.
  for (const problem of rejected) {
    console.error(`\nab: ${problem.name} is NOT loaded — ${problem.path}`);
    for (const line of problem.problems) console.error(`  ${line}`);
  }
  return rejected.length ? 1 : 0;
}

function cmdPrompts(positional: string[], flags: Flags): void {
  const root = requireRoot();
  if (positional[0]) {
    const prompt = findPrompt(root, positional[0]);
    if (!prompt) die(`no such prompt: ${positional[0]}`);
    out(`# ${prompt.name} — ${prompt.description}`);
    out(`role: ${prompt.role ?? "-"}   variables: ${prompt.variables.join(", ") || "-"}`);
    out();
    out(prompt.body);
    return;
  }
  const prompts = loadPrompts(root);
  if (bool(flags, "json")) {
    out(JSON.stringify(prompts, null, 2));
    return;
  }
  for (const prompt of prompts) {
    out(`${prompt.name.padEnd(12)} ${(prompt.role ?? "-").padEnd(12)} ${prompt.description}`);
    if (prompt.variables.length) out(`             vars: ${prompt.variables.join(", ")}`);
  }
}

function cmdSet(positional: string[], flags: Flags): void {
  const root = requireRoot();
  const store = new Store(root);
  const roles = loadRoles(root);
  const card = store.requireById(positional[0] ?? die("card id required"));
  const db = new LeaseDb(root);
  if (db.lease(card.id) || db.hasActiveTriage(card.id)) die("card is being worked — stop the run first");
  if (card.status === "running") die("card is running without a lease — dispatch once to recover it");
  const patch: Partial<Card> = {};
  const action = str(flags, "action");
  const status = str(flags, "status");
  if (action && status) die("use either --action or --status, not both");
  try {
    if (action) {
      patch.status = lifecycleStatus(card, action as LifecycleAction, false);
    } else if (status) {
      if (!(STATUSES as readonly string[]).includes(status)) die(`status must be one of ${STATUSES.join(", ")}`);
      patch.status = lifecycleStatus(card, lifecycleActionForStatus(card, status as Status), false);
    }
  } catch (error) {
    die((error as Error).message);
  }
  if (patch.status && patch.status !== "blocked") patch.blockedReason = null;
  const role = str(flags, "role");
  if (role) {
    if (!roles.some((candidate) => candidate.name === role)) die(`no such role: ${role}`);
    patch.role = role;
    const roleDef = roles.find((candidate) => candidate.name === role);
    if (roleDef && !str(flags, "runtime")) patch.runtime = roleDef.runtime;
  }
  const runtime = str(flags, "runtime");
  if (runtime) {
    if (!(RUNTIMES as readonly string[]).includes(runtime)) die(`runtime must be one of ${RUNTIMES.join(", ")}`);
    patch.runtime = runtime as Runtime;
  }
  // A session id only means something to the runtime that produced it.
  if (!sessionSurvivesRuntime(card, patch.runtime)) {
    patch.sessionId = null;
    out(`dropped the ${card.runtime} session id: ${patch.runtime} cannot resume it`);
  }
  if (str(flags, "model")) patch.model = str(flags, "model") as string;
  const workspace = str(flags, "workspace");
  if (workspace) {
    if (!["repo", "worktree", "scratch"].includes(workspace)) {
      die("workspace must be one of repo, worktree, scratch");
    }
    patch.workspace = workspace as Card["workspace"];
  }
  const maxTurnsFlag = finiteFlag(flags, "max-turns", { min: 1, integer: true });
  if (maxTurnsFlag !== undefined) patch.maxTurns = maxTurnsFlag;
  const priorityFlag = finiteFlag(flags, "priority");
  if (priorityFlag !== undefined) patch.priority = priorityFlag;
  if (str(flags, "parent") !== undefined) {
    try {
      patch.parents = validateParents(
        store,
        (str(flags, "parent") as string).split(",").map((id) => id.trim()).filter(Boolean),
        card.id,
      );
    } catch (error) {
      die((error as Error).message);
    }
  }
  if (str(flags, "title") !== undefined) {
    const title = (str(flags, "title") as string).trim();
    if (!title) die("--title cannot be empty");
    patch.title = title;
  }
  if (str(flags, "body") !== undefined) patch.body = str(flags, "body") as string;
  const bodyFile = str(flags, "body-file");
  if (bodyFile) patch.body = readFileSync(bodyFile, "utf8");
  if (str(flags, "handoff") !== undefined) patch.handoff = str(flags, "handoff") as string;
  const next = { ...card, ...patch };
  if (next.status === "ready" && !next.parents.every((id) => {
    const parent = store.byId(id);
    return parent?.status === "done" || parent?.status === "archived";
  })) patch.status = "todo";
  if (patch.status === "done") {
    const hasDependents = store.listAll().some((candidate) => candidate.parents.includes(card.id));
    const handoff = patch.handoff === undefined ? card.handoff : patch.handoff;
    if (hasDependents && !handoff?.trim()) die("completion requires --handoff because this card has dependents");
  }
  if (Object.keys(patch).length === 0) die("nothing to set");
  const mutation = db.mutateUnleased(card.id, () => store.update(card.id, patch));
  if (!mutation.ok) die("card is being worked — stop the run first");
  const updated = mutation.value;
  out(
    `${updated.id}: ${updated.status} role=${updated.role ?? "-"} runtime=${updated.runtime ?? "-"} model=${updated.model ?? "-"} workspace=${updated.workspace}`,
  );
  db.close();
}

function cmdLog(positional: string[], flags: Flags): void {
  const root = requireRoot();
  const store = new Store(root);
  const card = store.requireById(positional[0] ?? die("card id required"));
  const path = logPathFor(root, card.id);
  if (!existsSync(path)) {
    out(`no log yet for ${card.id}`);
    return;
  }
  const tail = finiteFlag(flags, "tail", { min: 1, integer: true }) ?? 40;
  out(readLogTail(path, tail).join("\n"));
}

async function cmdPlan(positional: string[], _flags: Flags): Promise<void> {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const roles = loadRoles(root);
  const card = store.requireById(positional[0] ?? die("card id required"));
  if (card.invalidReason) die(`cannot plan malformed card: ${card.invalidReason}`);
  const role = roles.find((candidate) => candidate.name === (card.role ?? config.defaultRole)) ?? null;
  const workspace = await resolveWorkspace(root, config.workdir, card, { create: false });
  const { system, prompt } = workerPrompt(card, role, cardsById(store.listAll()), config, workspace.note);
  const argv = previewArgv({
    runtime: card.runtime ?? role?.runtime ?? config.defaultRuntime,
    model: card.model ?? role?.model ?? null,
    system,
    prompt,
    cwd: workspace.cwd,
    maxTurns: limits.turnCap(card, config),
    readOnly: role?.readOnly ?? false,
    skills: card.skills,
    resumeSessionId: card.sessionId,
    timeoutMs: 0,
    logPath: "",
  });
  out(`# argv`);
  out(argv.join(" "));
  out(`\n# system (${system.length} chars, ~${limits.estimateTokens(system)} tokens)`);
  out(system || "(none)");
  out(`\n# prompt (${prompt.length} chars, ~${limits.estimateTokens(prompt)} tokens)`);
  out(prompt);
}

async function cmdAttach(positional: string[], flags: Flags): Promise<number> {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const db = new LeaseDb(root);
  const roles = loadRoles(root);
  const card = store.requireById(positional[0] ?? die("card id required"));
  if (card.invalidReason) {
    db.close();
    die(`cannot attach malformed card: ${card.invalidReason}`);
  }
  const lease = db.lease(card.id);
  if (lease || db.hasActiveTriage(card.id)) {
    db.close();
    die(lease
      ? `${card.id} is being worked by ${lease.owner} — \`ab set ${shortId(card.id)} --status ready\` after stopping it`
      : `${card.id} is being triaged — wait for triage to finish`);
  }
  const role = roles.find((candidate) => candidate.name === (card.role ?? config.defaultRole)) ?? null;
  if (!role) {
    db.close();
    die(`cannot attach: unknown role ${card.role ?? config.defaultRole}`);
  }
  const fresh = bool(flags, "fresh");
  let workspace;
  try {
    workspace = await resolveWorkspace(root, config.workdir, card);
  } catch (error) {
    db.close();
    die(`cannot attach: ${(error as Error).message}`);
  }
  const context = workerPrompt(card, role, cardsById(store.listAll()), config, workspace.note);
  const seedPrompt = fresh || !card.sessionId
    ? context.prompt
    : (str(flags, "say") ?? undefined);
  const plan = attachPlan(card, role, config, {
    runtime: (str(flags, "runtime") as Runtime | undefined),
    fresh,
    prompt: seedPrompt,
    system: context.system,
    skills: effectiveSkills(card.skills, role?.skills ?? []),
    cwd: workspace.cwd,
  });
  db.close();
  out(`# ${card.id} — ${card.title}`);
  out(`# ${plan.note}`);
  out(`# ${plan.argv.join(" ").slice(0, 200)}`);
  if (plan.argv.length === 0) {
    out(plan.note);
    return 0;
  }
  if (bool(flags, "dry-run")) return 0;
  return attach(plan);
}

function cmdStats(_positional: string[], flags: Flags): void {
  const root = requireRoot();
  const config = loadConfig(root);
  const store = new Store(root);
  const db = new LeaseDb(root);
  const cards = store.list();
  const byStatus: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  for (const card of cards) {
    byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
    const role = card.role ?? "(unrouted)";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  const payload = {
    board: config.name,
    workdir: config.workdir,
    cards: cards.length,
    byStatus,
    byRole,
    leases: db.activeLeases().map((lease) => lease.cardId),
    spend: {
      today: db.spentToday(),
      tokens: db.tokensToday(),
      byKind: db.ledgerByKind(),
      day: today(),
    },
  };
  if (bool(flags, "json")) {
    out(JSON.stringify(payload, null, 2));
    db.close();
    return;
  }
  out(`board ${payload.board} — ${payload.cards} cards — workdir ${payload.workdir}`);
  out(`status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  out(`roles:  ${Object.entries(byRole).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  out(`leases: ${payload.leases.length ? payload.leases.join(", ") : "none"}`);
  out(
    `tracked usage (${payload.spend.day} UTC): $${payload.spend.today.toFixed(4)}, ${payload.spend.tokens} tokens — ${
      Object.entries(payload.spend.byKind)
        .map(([kind, usd]) => `${kind}=$${Number(usd).toFixed(4)}`)
        .join(" ") || "nothing yet"
    }`,
  );
  db.close();
}

async function cmdServe(_positional: string[], flags: Flags): Promise<number> {
  const root = requireRoot();
  const config = loadConfig(root);
  registerProject(root);
  const { url, stop } = createServer({
    root,
    port: num(flags, "port") ?? DEFAULT_DASHBOARD_PORT,
    readOnly: bool(flags, "read-only"),
    log: (line) => out(line),
  });
  out(`dashboard: ${url}   (board ${config.name}, workdir ${config.workdir})`);
  out(bool(flags, "read-only") ? "read-only: mutations disabled" : "actions enabled — this page can start paid runs");
  out("ctrl-c to stop");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      stop();
      resolve();
    });
  });
  return 0;
}

function cmdProjects(positional: string[], flags: Flags): void {
  const action = positional[0] ?? "list";
  if (action === "add") {
    const root = positional[1] ?? die("board root required: ab projects add <path>");
    const project = registerProject(root);
    out(`registered ${project.name} (${project.id})`);
    out(`board: ${project.root}`);
    out(`workdir: ${project.workdir}`);
    return;
  }
  if (action === "remove" || action === "rm") {
    const target = positional[1] ?? die("project id or board root required: ab projects remove <id|path>");
    const project = unregisterProject(target);
    out(`unregistered ${project.name} (${project.id}); board files were not deleted`);
    return;
  }
  if (action !== "list" && action !== "ls") die(`unknown projects action: ${action}`);
  const projects = allProjectEntries();
  if (bool(flags, "json")) {
    out(JSON.stringify(projects, null, 2));
    return;
  }
  if (projects.length === 0) {
    out("no registered projects — run `ab init` in a project or `ab projects add <board-root>`");
    return;
  }
  out("PROJECTS");
  for (const project of projects) {
    const available = existsSync(join(project.root, CONFIG_FILE));
    out(`  ${project.id.padEnd(44)} ${project.name}${available ? "" : "  ← board missing"}`);
    out(`    board ${project.root}`);
    out(`    work  ${project.workdir}`);
  }
}

/** Parse `7d` / `12h` / `45m` / bare-number-of-days into milliseconds. */
function parseAge(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([mhd])?$/.exec(value.trim());
  if (!match) die("--older-than expects a duration like 7d, 12h, or 45m");
  const amount = Number(match[1]);
  const unit = match[2] ?? "d";
  const scale = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * scale;
}

function archiveOne(store: Store, db: LeaseDb, card: Card): string {
  if (db.lease(card.id) || db.hasActiveTriage(card.id)) return "card is being worked — stop the run first";
  try {
    lifecycleStatus(card, "archive", false);
  } catch (error) {
    return (error as Error).message;
  }
  const mutation = db.mutateUnleased(card.id, () => store.update(card.id, { status: "archived" }));
  return mutation.ok ? "" : "card is being worked — stop the run first";
}

/**
 * Move finished cards out of the live board. Named ids are archived outright;
 * a `--done` sweep only previews until `--yes`, because bulk archival of cards
 * the user did not name is exactly what the skill contract asks us to confirm.
 */
function cmdArchive(positional: string[], flags: Flags): number {
  const root = requireRoot();
  const store = new Store(root);
  const db = new LeaseDb(root);
  const asJson = bool(flags, "json");

  if (bool(flags, "list")) {
    const archived = store.listArchived();
    if (asJson) out(JSON.stringify(archived, null, 2));
    else if (archived.length === 0) out("archive is empty");
    else {
      out(`ARCHIVED (${archived.length})`);
      for (const card of archived) out(cardLine(card));
    }
    db.close();
    return 0;
  }

  const sweepDone = bool(flags, "done");
  if (positional.length === 0 && !sweepDone) {
    db.close();
    die("name a card id, or sweep finished work with: ab archive --done [--older-than 7d] --yes");
  }

  let targets: Card[];
  if (positional.length > 0) {
    targets = positional.map((id) => store.requireById(id));
    if (sweepDone) targets = targets.filter((card) => card.status === "done");
  } else {
    const olderThan = str(flags, "older-than");
    const cutoff = olderThan ? Date.now() - parseAge(olderThan) : null;
    targets = store.list().filter((card) =>
      card.status === "done" && (cutoff === null || Date.parse(card.updatedAt) <= cutoff)
    );
  }

  const named = positional.length > 0;
  const apply = named || bool(flags, "yes");
  if (targets.length === 0) {
    if (asJson) out(JSON.stringify({ archived: [], skipped: [], applied: apply }, null, 2));
    else out("nothing to archive");
    db.close();
    return 0;
  }

  if (!apply) {
    if (asJson) {
      out(JSON.stringify({ applied: false, wouldArchive: targets.map((card) => card.id) }, null, 2));
    } else {
      out(`would archive ${targets.length} done card(s):`);
      for (const card of targets) out(cardLine(card));
      out(`\nre-run with --yes to move them to ${join(BOARD_DIR, "archive")}`);
    }
    db.close();
    return 0;
  }

  const archived: string[] = [];
  const skipped: { cardId: string; reason: string }[] = [];
  for (const card of targets) {
    const failure = archiveOne(store, db, card);
    if (failure) skipped.push({ cardId: card.id, reason: failure });
    else archived.push(card.id);
  }
  if (asJson) {
    out(JSON.stringify({ applied: true, archived, skipped }, null, 2));
  } else {
    for (const id of archived) out(`archived ${shortId(id)}`);
    for (const skip of skipped) console.error(`ab: cannot archive ${shortId(skip.cardId)}: ${skip.reason}`);
    if (archived.length) out(`${archived.length} archived, ${skipped.length} skipped — see \`ab archive --list\``);
  }
  db.close();
  // Nothing moved is a failure; a partial sweep already reported each refusal.
  return archived.length === 0 ? 1 : 0;
}

/** Answer "which board am I on, and why" — the discovery decision, in full. */
function cmdWhere(_positional: string[], flags: Flags): number {
  const resolution = resolveBoard();
  if (bool(flags, "json")) {
    out(JSON.stringify(resolution, null, 2));
    return resolution.root ? 0 : 1;
  }
  if (!resolution.root) {
    console.error(`ab: ${resolution.reason}`);
    for (const project of resolution.ambiguous) {
      console.error(`  ${project.name}  board ${project.root}  workdir ${project.workdir}`);
    }
    if (resolution.suggestion) console.error(`try: ${resolution.suggestion}`);
    return 1;
  }
  const config = loadConfig(resolution.root);
  out(`board:   ${config.name}`);
  out(`root:    ${resolution.root}`);
  out(`workdir: ${config.workdir}${existsSync(config.workdir) ? "" : "  ← MISSING"}`);
  out(`cwd:     ${process.cwd()}`);
  out(`chosen:  ${resolution.source} — ${resolution.reason}`);
  const others = resolution.candidates.filter((project) => project.root !== resolution.root);
  if (others.length > 0) {
    out(`\nalso registered against this directory (not chosen):`);
    for (const project of others) out(`  ${project.name}  board ${project.root}  workdir ${project.workdir}`);
    out(`override with: ab --board <root> <command>   (or AB_BOARD=<root>)`);
  }
  return 0;
}

function cmdDoctor(): void {
  const resolution = resolveBoard();
  const root = resolution.root;
  out(`chosen:  ${resolution.source ?? "nothing"} — ${resolution.reason}`);
  out(`board:   ${root ? join(root, BOARD_DIR) : "NOT FOUND (run `ab init`)"}`);
  if (root) {
    const config = loadConfig(root);
    out(`workdir: ${config.workdir}${existsSync(config.workdir) ? "" : "  ← MISSING"}`);
    const { roles, rejected } = inspectRoles(root);
    out(`roles:   ${roles.length}${rejected.length ? ` (+${rejected.length} REJECTED)` : ""}   prompts: ${loadPrompts(root).length}`);
    for (const problem of rejected) {
      out(`  ${problem.name} not loaded — ${problem.problems.join("; ")}`);
      out(`    fix ${problem.path}, or run \`ab roles --reseed --yes\` to restore the shipped version`);
    }
    out(`triage chain: ${config.triageChain.map((p) => `${p.kind}/${p.model}`).join(" → ")}  (parks below confidence ${config.triageMinConfidence})`);
    out(`caps: ${config.maxRunning} running, ${config.maxRunningPerRole}/role, ${config.maxTurns} turns/run`);
  }
  for (const binary of ["codex", "claude", "bun"]) {
    const path = Bun.which(binary);
    out(`${binary.padEnd(8)} ${path ?? "NOT ON PATH"}`);
  }
  const localBase = process.env.AB_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1";
  out(`local:   ${localBase} (triage tier — free when up)`);
}

function usage(): void {
  out(`ab — agent board (markdown cards, SQLite leases, your agent CLIs as workers)

  ab where [--json]                        which board covers this directory, and why
  ab init [dir] [--workdir <repo>] [--name <n>] [--force] [--no-register]
  ab add "<goal>" [--role <r>] [--runtime codex|claude|local] [--model <m>]
                  [--workspace repo|worktree|scratch]   (default repo)
                  [--prompt <name> --<var> <value> …] [--body <text>] [--body-file <f>]
                  [--parent <ids>] [--max-turns <n>] [--priority <n>]
                  [--no-triage]
  ab ls [--status <s>] [--all] [--json]
  ab show <id> [--json]
  ab triage [<id>…] [--min-confidence 0.6]
  ab dispatch [--dry-run] [--max-triage <n>] [--json]
  ab daemon [--interval <s>] [--ticks <n>]
  ab set <id> [--action <name> | --status <s>] [--role <r>] [--runtime <rt>] [--model <m>]
              [--workspace repo|worktree|scratch] [--max-turns <n>]
              [--priority <n>] [--parent <ids>] [--title <t>] [--body <text>]
              [--body-file <f>] [--handoff <text>]
  ab archive <id>…                         archive the cards you name
  ab archive --done [--older-than 7d] [--yes] [--json]   sweep finished work (preview without --yes)
  ab archive --list [--json]               what is in the archive
  ab attach <id> [--fresh] [--runtime codex|claude] [--say <text>] [--dry-run]
  ab plan <id>                  show the exact prompt + argv a worker would get
  ab log <id> [--tail <n>]
  ab roles [--roster] [--json]
  ab roles --reseed [--yes]                 restore shipped SOUL.md files (preview without --yes)
  ab prompts [<name>] [--json]
  ab projects [list] [--json]
  ab projects add <board-root>
  ab projects remove <id|board-root>       unregister only; never deletes board files
  ab serve [--port ${DEFAULT_DASHBOARD_PORT}] [--read-only]     project dashboard on 127.0.0.1
  ab stats [--json]
  ab doctor

Any command works from anywhere inside a project: the board is found by walking up
to the nearest board/, then by matching a registered board's workdir. Override with
"ab --board <root> <command>" or AB_BOARD=<root>.  See: ab where

Flow: add → triage (local-first model specs, splits, routes) → dispatch/daemon
(workers run) → ls/show/log → archive. Cards are files under board/cards/ — edit them by
hand. Archived cards move to board/archive/ and stop loading with the live board.`);
}

/**
 * Pull global options off the front of argv so `ab --board <root> ls` works, not
 * just `ab ls --board <root>`. Anything else is left for the command's own parser.
 */
function takeGlobalFlags(argv: string[]): string[] {
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest[0] as string;
    const inline = /^--board=(.*)$/.exec(arg);
    if (inline) {
      setExplicitBoard(inline[1] as string);
      rest.shift();
      continue;
    }
    if (arg === "--board") {
      const value = rest[1];
      if (value === undefined || value.startsWith("--")) die("--board needs a board root");
      setExplicitBoard(value);
      rest.splice(0, 2);
      continue;
    }
    break;
  }
  return rest;
}

async function main(): Promise<number> {
  const [command, ...rest] = takeGlobalFlags(process.argv.slice(2));
  const { positional, flags } = parseArgs(rest);
  // `--board` also works after the command, for muscle memory either way.
  const boardFlag = str(flags, "board");
  if (boardFlag) setExplicitBoard(boardFlag);
  switch (command) {
    case "where":
      return cmdWhere(positional, flags);
    case "init":
      cmdInit(positional, flags);
      return 0;
    case "add":
      await cmdAdd(positional, flags);
      return 0;
    case "ls":
    case "list":
      cmdLs(positional, flags);
      return 0;
    case "show":
      cmdShow(positional, flags);
      return 0;
    case "triage":
      await cmdTriage(positional, flags);
      return 0;
    case "dispatch":
      await cmdDispatch(positional, flags);
      return 0;
    case "daemon":
      await cmdDaemon(positional, flags);
      return 0;
    case "set":
      cmdSet(positional, flags);
      return 0;
    case "plan":
      await cmdPlan(positional, flags);
      return 0;
    case "attach":
      return await cmdAttach(positional, flags);
    case "serve":
      return await cmdServe(positional, flags);
    case "log":
      cmdLog(positional, flags);
      return 0;
    case "roles":
      return cmdRoles(positional, flags);
    case "prompts":
      cmdPrompts(positional, flags);
      return 0;
    case "stats":
      cmdStats(positional, flags);
      return 0;
    case "projects":
      cmdProjects(positional, flags);
      return 0;
    case "archive":
      return cmdArchive(positional, flags);
    case "doctor":
      cmdDoctor();
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      console.error(`ab: unknown command '${command}'`);
      usage();
      return 1;
  }
}

try {
  process.exit(await main());
} catch (error) {
  die((error as Error).message);
}
