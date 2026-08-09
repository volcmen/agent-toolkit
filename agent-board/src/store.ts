import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseDocument, serializeDocument, type Frontmatter } from "./frontmatter.ts";
import { cardFilename, cardId, nowIso } from "./ids.ts";
import { ARCHIVE_DIR, CARDS_DIR, LOGS_DIR, PROMPTS_DIR, ROLES_DIR, STATE_DIR } from "./config.ts";
import { RUNTIMES, STATUSES, type Card, type Runtime, type Status } from "./types.ts";
import { loadRoles } from "./roles.ts";

export type NewCard = {
  title: string;
  body?: string;
  status?: Status;
  role?: string | null;
  runtime?: Runtime | null;
  model?: string | null;
  parents?: string[];
  root?: string | null;
  skills?: string[];
  workspace?: Card["workspace"];
  maxTurns?: number | null;
  goal?: boolean;
  priority?: number;
};

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item !== "");
  const single = asString(value);
  return single ? [single] : [];
}

function asStatus(value: unknown): Status {
  const text = asString(value);
  return (STATUSES as readonly string[]).includes(text ?? "") ? (text as Status) : "triage";
}

function asRuntime(value: unknown): Runtime | null {
  const text = asString(value);
  return (RUNTIMES as readonly string[]).includes(text ?? "") ? (text as Runtime) : null;
}

function asWorkspace(value: unknown): Card["workspace"] {
  const text = asString(value);
  return text === "scratch" || text === "worktree" ? text : "repo";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function cardFromDocument(path: string, text: string): Card {
  const { data, body } = parseDocument(text);
  const invalid: string[] = [];
  const requiredString = (key: string, value: unknown): string => {
    const parsed = asString(value);
    if (!parsed) invalid.push(`${key} must be a non-empty string`);
    return parsed ?? "";
  };
  const persistedStatus = asString(data.status);
  if (!persistedStatus || !(STATUSES as readonly string[]).includes(persistedStatus)) {
    invalid.push(`status must be one of ${STATUSES.join(", ")}`);
  }
  if (data.role !== null && data.role !== undefined && !asString(data.role)) {
    invalid.push("role must be a non-empty string or null");
  }
  if (data.runtime !== null && data.runtime !== undefined && !asRuntime(data.runtime)) {
    invalid.push(`runtime must be one of ${RUNTIMES.join(", ")} or null`);
  }
  const persistedWorkspace = asString(data.workspace);
  if (!persistedWorkspace || !["repo", "worktree", "scratch"].includes(persistedWorkspace)) {
    invalid.push("workspace must be repo, worktree, or scratch");
  }
  for (const [key, value, options] of [
    ["max_turns", data.max_turns, { min: 1, integer: true }],
    ["priority", data.priority, { min: -Infinity, integer: false }],
  ] as const) {
    if (value === null || value === undefined) continue;
    const parsed = asNumber(value);
    if (parsed === null || parsed < options.min || (options.integer && !Number.isInteger(parsed))) {
      invalid.push(`${key} is invalid`);
    }
  }
  if (data.parents !== undefined && !Array.isArray(data.parents)) invalid.push("parents must be a string list");
  if (Array.isArray(data.parents) && data.parents.some((item) => typeof item !== "string" || !item)) {
    invalid.push("parents must contain non-empty strings");
  }
  const title = asString(data.title) ?? "(untitled)";
  return {
    id: requiredString("id", data.id) || `invalid_${path}`,
    path,
    title,
    body,
    status: invalid.length ? "blocked" : asStatus(data.status),
    role: asString(data.role),
    runtime: asRuntime(data.runtime),
    model: asString(data.model),
    parents: asList(data.parents),
    root: asString(data.root),
    handoff: asString(data.handoff),
    skills: asList(data.skills),
    workspace: invalid.length ? "scratch" : asWorkspace(data.workspace),
    maxTurns: asNumber(data.max_turns),
    goal: data.goal === true,
    priority: asNumber(data.priority) ?? 0,
    createdAt: asString(data.created_at) ?? nowIso(),
    updatedAt: asString(data.updated_at) ?? nowIso(),
    blockedReason: invalid.length ? `malformed card: ${invalid.join("; ")}` : asString(data.blocked_reason),
    sessionId: asString(data.session_id),
    invalidReason: invalid.length ? invalid.join("; ") : null,
  };
}

export function documentFromCard(card: Card): string {
  const data: Frontmatter = {
    id: card.id,
    title: card.title,
    status: card.status,
    role: card.role,
    runtime: card.runtime,
    model: card.model,
    parents: card.parents,
    root: card.root,
    skills: card.skills,
    workspace: card.workspace,
    max_turns: card.maxTurns,
    goal: card.goal ? true : null,
    priority: card.priority || null,
    session_id: card.sessionId,
    blocked_reason: card.blockedReason,
    handoff: card.handoff,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
  };
  return serializeDocument(data, card.body);
}

/** Exact persisted revision used to prove dispatch is admitting the snapshot it read. */
export function cardRevision(card: Card): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(card.path, "utf8")).digest("hex");
}

export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get cardsDir(): string {
    return join(this.root, CARDS_DIR);
  }

  get archiveDir(): string {
    return join(this.root, ARCHIVE_DIR);
  }

  ensureDirs(): void {
    for (const dir of [CARDS_DIR, ARCHIVE_DIR, ROLES_DIR, PROMPTS_DIR, LOGS_DIR, STATE_DIR]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
  }

  private readDir(dir: string): Card[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const cards: Card[] = [];
    const roleNames = new Set(loadRoles(this.root).map((role) => role.name));
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      const card = cardFromDocument(path, readFileSync(path, "utf8"));
      if (card.role && !roleNames.has(card.role)) {
        card.invalidReason = `unknown role ${card.role}`;
        card.status = "blocked";
        card.workspace = "scratch";
        card.blockedReason = `malformed card: ${card.invalidReason}`;
      }
      cards.push(card);
    }
    // Newest last so `ab ls` reads like a log; callers sort as they need.
    return cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The live board: everything under `cards/`. Archived work is not parsed here. */
  list(): Card[] {
    return this.readDir(this.cardsDir);
  }

  /**
   * Archived cards. Includes any card still sitting in `cards/` with an
   * `archived` status — boards written before the archive directory existed —
   * so nothing disappears before its next mutation relocates it.
   */
  listArchived(): Card[] {
    return [
      ...this.list().filter((card) => card.status === "archived"),
      ...this.readDir(this.archiveDir),
    ];
  }

  /**
   * Live board plus archive. Every lookup *by id* must use this — dependency
   * resolution treats a missing parent as unsatisfied, so an archived parent
   * that vanished from the graph would wedge its children forever.
   */
  listAll(): Card[] {
    return [...this.list(), ...this.readDir(this.archiveDir)];
  }

  byId(id: string): Card | null {
    // Accept a bare tail ("a1b2") as well as the full id. The live board is
    // searched first, so the common lookup never parses the archive at all and a
    // short id never resolves to an archived card when both would match.
    const wanted = id.startsWith("c_") ? id : `c_${id}`;
    const pick = (cards: Card[]) =>
      cards.find((card) => card.id === wanted) ?? cards.find((card) => card.id.endsWith(id));
    return pick(this.list()) ?? pick(this.readDir(this.archiveDir)) ?? null;
  }

  requireById(id: string): Card {
    const card = this.byId(id);
    if (!card) throw new Error(`no such card: ${id}`);
    return card;
  }

  create(input: NewCard): Card {
    this.ensureDirs();
    const id = cardId();
    const createdAt = nowIso();
    const card: Card = {
      id,
      path: join(this.cardsDir, cardFilename(id, input.title, new Date(createdAt))),
      title: input.title,
      body: input.body ?? "",
      status: input.status ?? "triage",
      role: input.role ?? null,
      runtime: input.runtime ?? null,
      model: input.model ?? null,
      parents: input.parents ?? [],
      root: input.root ?? null,
      handoff: null,
      skills: input.skills ?? [],
      workspace: input.workspace ?? "repo",
      maxTurns: input.maxTurns ?? null,
      goal: input.goal ?? false,
      priority: input.priority ?? 0,
      createdAt,
      updatedAt: createdAt,
      blockedReason: null,
      sessionId: null,
      invalidReason: null,
    };
    return this.write(card);
  }

  /** Where a card belongs on disk: archived work lives outside the live board. */
  private pathFor(card: Card): string {
    const dir = card.status === "archived" ? this.archiveDir : this.cardsDir;
    return join(dir, basename(card.path));
  }

  /**
   * Atomic-ish write: temp file then rename, so a crash never truncates a card.
   * A status change that crosses the archive boundary relocates the file — the
   * destination is written first, so a crash leaves a duplicate, never a hole.
   */
  write(card: Card): Card {
    const destination = this.pathFor(card);
    if (destination !== card.path) mkdirSync(dirname(destination), { recursive: true });
    const next = { ...card, path: destination, updatedAt: nowIso() };
    const temp = `${destination}.tmp`;
    writeFileSync(temp, documentFromCard(next), "utf8");
    renameSync(temp, destination);
    if (destination !== card.path) rmSync(card.path, { force: true });
    return next;
  }

  update(id: string, patch: Partial<Omit<Card, "id" | "path">>): Card {
    const card = this.requireById(id);
    return this.write({ ...card, ...patch });
  }
}
