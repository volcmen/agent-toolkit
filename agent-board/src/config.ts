import { isAbsolute, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { RUNTIMES, type BoardConfig, type TriageProvider } from "./types.ts";

export const BOARD_DIR = "board";
export const CARDS_DIR = join(BOARD_DIR, "cards");
/** Archived cards move out of `cards/` so the hot path never parses finished work. */
export const ARCHIVE_DIR = join(BOARD_DIR, "archive");
export const ROLES_DIR = join(BOARD_DIR, "roles");
export const PROMPTS_DIR = join(BOARD_DIR, "prompts");
export const LOGS_DIR = join(BOARD_DIR, ".logs");
export const STATE_DIR = join(BOARD_DIR, ".state");
export const DB_FILE = join(STATE_DIR, "board.db");
export const CONFIG_FILE = join(BOARD_DIR, "board.json");

/**
 * Defaults are deliberately frugal. Triage runs on every intake, so the chain
 * starts at a free local model and only escalates when it fails or is unsure.
 */
export function defaultConfig(workdir: string): BoardConfig {
  return {
    name: "board",
    workdir,
    maxRunning: 2,
    maxRunningPerRole: 1,
    tickSeconds: 30,
    failureLimit: 2,
    staleSeconds: 3600,
    defaultRole: "generalist",
    defaultRuntime: "codex",
    triageChain: [
      { kind: "local", model: "llama3.2:3b", maxUsd: 0, baseUrl: "http://127.0.0.1:11434/v1" },
      { kind: "codex", model: "gpt-5.6-sol", maxUsd: 0.05 },
    ],
    triageMinConfidence: 0.6,
    budget: { perCardUsd: 1.5, perDayUsd: 10, perCardTurns: 24, perRunReserveUsd: 1.5 },
    context: { bodyChars: 4000, handoffChars: 800, ancestryChars: 1200, maxParents: 6 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shallow-merge one level of nested objects so partial configs stay valid. */
export function mergeConfig(base: BoardConfig, patch: unknown): BoardConfig {
  if (!isRecord(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (isRecord(value) && isRecord(current)) out[key] = { ...current, ...value };
    else if (value !== undefined) out[key] = value;
  }
  return out as BoardConfig;
}

function configError(field: string, message: string): never {
  throw new Error(`${CONFIG_FILE}: ${field} ${message}`);
}

function knownKeys(value: Record<string, unknown>, field: string, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) configError(field ? `${field}.${unknown}` : unknown, "is not supported");
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) configError(field, "must be an object");
  return value;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") configError(field, "must be a non-empty string");
  return value;
}

function numberField(
  value: unknown,
  field: string,
  options: { min: number; integer?: boolean },
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < options.min) {
    configError(field, `must be a finite number >= ${options.min}`);
  }
  if (options.integer && !Number.isInteger(value)) configError(field, "must be an integer");
  return value;
}

function validateProvider(value: unknown, index: number): TriageProvider {
  const field = `triageChain[${index}]`;
  const provider = recordField(value, field);
  knownKeys(provider, field, ["kind", "model", "maxUsd", "baseUrl"]);
  if (!["local", "codex", "claude"].includes(String(provider.kind))) {
    configError(`${field}.kind`, "must be one of local, codex, claude");
  }
  stringField(provider.model, `${field}.model`);
  numberField(provider.maxUsd, `${field}.maxUsd`, { min: 0 });
  if (provider.baseUrl !== undefined) {
    if (provider.kind !== "local") configError(`${field}.baseUrl`, "is only supported for local providers");
    const baseUrl = stringField(provider.baseUrl, `${field}.baseUrl`);
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      configError(`${field}.baseUrl`, "must be a valid http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      configError(`${field}.baseUrl`, "must be a valid http(s) URL");
    }
  }
  return provider as unknown as TriageProvider;
}

/** Validate the fully merged shape before any board operation can use it. */
export function validateConfig(value: unknown): BoardConfig {
  const config = recordField(value, "config");
  knownKeys(config, "", [
    "name", "workdir", "maxRunning", "maxRunningPerRole", "tickSeconds",
    "failureLimit", "staleSeconds", "defaultRole", "defaultRuntime",
    "triageChain", "triageMinConfidence", "budget", "context",
  ]);
  stringField(config.name, "name");
  const workdir = stringField(config.workdir, "workdir");
  if (!isAbsolute(workdir)) configError("workdir", "must be an absolute path");
  try {
    if (!statSync(workdir).isDirectory()) configError("workdir", "must name an existing directory");
  } catch {
    configError("workdir", "must name an existing directory");
  }
  for (const field of ["maxRunning", "maxRunningPerRole", "tickSeconds", "failureLimit", "staleSeconds"] as const) {
    numberField(config[field], field, { min: 1, integer: true });
  }
  stringField(config.defaultRole, "defaultRole");
  if (!(RUNTIMES as readonly unknown[]).includes(config.defaultRuntime)) {
    configError("defaultRuntime", `must be one of ${RUNTIMES.join(", ")}`);
  }
  if (!Array.isArray(config.triageChain) || config.triageChain.length === 0) {
    configError("triageChain", "must be a non-empty array");
  }
  config.triageChain.forEach(validateProvider);
  numberField(config.triageMinConfidence, "triageMinConfidence", { min: 0 });
  if ((config.triageMinConfidence as number) > 1) {
    configError("triageMinConfidence", "must be between 0 and 1");
  }

  const budget = recordField(config.budget, "budget");
  knownKeys(budget, "budget", ["perCardUsd", "perDayUsd", "perCardTurns", "perRunReserveUsd"]);
  numberField(budget.perCardUsd, "budget.perCardUsd", { min: 0 });
  numberField(budget.perDayUsd, "budget.perDayUsd", { min: 0 });
  numberField(budget.perCardTurns, "budget.perCardTurns", { min: 1, integer: true });
  if (budget.perRunReserveUsd !== undefined) {
    numberField(budget.perRunReserveUsd, "budget.perRunReserveUsd", { min: 0 });
  }

  const context = recordField(config.context, "context");
  knownKeys(context, "context", ["bodyChars", "handoffChars", "ancestryChars", "maxParents"]);
  for (const field of ["bodyChars", "handoffChars", "ancestryChars", "maxParents"] as const) {
    numberField(context[field], `context.${field}`, { min: 1, integer: true });
  }
  return config as unknown as BoardConfig;
}

export function loadConfig(root: string): BoardConfig {
  const base = defaultConfig(root);
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return validateConfig(base);
  try {
    const patch = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(patch)) configError("config", "must be an object");
    return validateConfig(mergeConfig(base, patch));
  } catch (error) {
    if ((error as Error).message.startsWith(`${CONFIG_FILE}:`)) throw error;
    throw new Error(`${CONFIG_FILE}: invalid JSON: ${(error as Error).message}`);
  }
}

/** Walk up from `start` to find the board root (the dir containing `board/`). */
export function findRoot(start = process.cwd()): string | null {
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, CARDS_DIR))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function requireRoot(start = process.cwd()): string {
  const root = findRoot(start);
  if (!root) throw new Error("no board found here — run `ab init` first");
  return root;
}
