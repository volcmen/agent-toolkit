/**
 * `ab serve` — a local web dashboard for the board.
 *
 * Deliberately small: `Bun.serve`, one self-contained HTML page (no CDN, no
 * bundler, no framework), JSON endpoints over the same store the CLI uses. The
 * page polls; there are no websockets to keep alive.
 *
 * Safety, because these endpoints can start paid runs:
 *   - binds 127.0.0.1 only
 *   - every request requires a literal loopback `Host`
 *   - mutations are POST + JSON only
 *   - a cross-origin `Origin` header is rejected, so a random page you visit
 *     cannot drive your board (plain CSRF protection)
 *   - `--read-only` serves the same page with every mutation disabled
 *   - one dispatch at a time, so a double-click cannot start two ticks
 */

import { readFileSync, realpathSync } from "node:fs";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { LeaseDb, today } from "./lease.ts";
import { Store } from "./store.ts";
import { loadRoles } from "./roles.ts";
import { loadPrompts } from "./prompts.ts";
import { cardsById, dispatchPreview, parentsSatisfied, tick, type TickOptions, type TickReport } from "./dispatcher.ts";
import { triageCard } from "./triage.ts";
import { logPathFor } from "./runners.ts";
import * as budget from "./budget.ts";
import { RUNTIMES, STATUSES, type Card, type Runtime, type Status } from "./types.ts";
import { DEFAULT_DASHBOARD_PORT, listProjects, registerProject } from "./projects.ts";
import {
  allowedLifecycleActions,
  finiteNumber,
  lifecycleActionForStatus,
  lifecycleStatus,
  sessionSurvivesRuntime,
  validateParents,
  type LifecycleAction,
} from "./domain.ts";

export type ServeOptions = {
  root: string;
  port?: number;
  hostname?: string;
  readOnly?: boolean;
  log?: (line: string) => void;
  /** Test seam for a deterministic or deliberately slow worker. */
  tickOptions?: TickOptions;
  /** Handler-only mode for restricted test sandboxes that cannot bind a port. */
  listen?: boolean;
  /** Internal: child board handlers do not expose the workspace project hub. */
  hub?: boolean;
};

const COLUMNS: Status[] = ["triage", "todo", "ready", "running", "review", "blocked", "done"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function hostAllowed(host: string | null): boolean {
  if (!host) return false;
  const match = /^(\[::1\]|[^:]+)(?::(\d{1,5}))?$/.exec(host.toLowerCase());
  if (!match) return false;
  const port = match[2];
  if (port !== undefined && Number(port) > 65_535) return false;
  const hostname = match[1] as string;
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

/** Every write must carry an explicit same-origin browser Origin. */
export function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return origin === url.origin && url.origin === new URL(`http://${host}`).origin;
  } catch {
    return false;
  }
}

function cardView(card: Card, db: LeaseDb, config: ReturnType<typeof loadConfig>) {
  const leased = db.lease(card.id) !== null || db.hasActiveTriage(card.id);
  return {
    id: card.id,
    short: card.id.replace(/^c_/, ""),
    title: card.title,
    body: card.body,
    status: card.status,
    role: card.role,
    runtime: card.runtime,
    model: card.model,
    parents: card.parents,
    root: card.root,
    workspace: card.workspace,
    priority: card.priority,
    blockedReason: card.blockedReason,
    handoff: card.handoff,
    sessionId: card.sessionId,
    updatedAt: card.updatedAt,
    spentUsd: db.spentOnCard(card.id),
    tokens: db.tokensOnCard(card.id),
    ceilingUsd: budget.cardCeiling(card, config),
    leased,
    allowedActions: allowedLifecycleActions(card, leased),
  };
}

function dependencyView(card: Card, cards: Card[]) {
  const all = cardsById(cards);
  return {
    dependencies: card.parents.map((id) => {
      const parent = all.get(id);
      return parent
        ? {
            id: parent.id,
            title: parent.title,
            status: parent.status,
            satisfied: parent.status === "done" || parent.status === "archived",
            exists: true,
          }
        : { id, title: null, status: null, satisfied: false, exists: false };
    }),
    dependents: cards
      .filter((candidate) => candidate.parents.includes(card.id))
      .map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        status: candidate.status,
      })),
  };
}

export function createServer(options: ServeOptions) {
  const root = options.root;
  const canonicalRoot = realpathSync(root);
  const store = new Store(root);
  const db = new LeaseDb(root);
  const log = options.log ?? (() => {});
  const readOnly = options.readOnly ?? false;
  const csrfToken = crypto.randomUUID();
  let dispatching = false;
  let dispatchPromise: Promise<void> | null = null;
  const dispatches = new Map<
    string,
    { status: "running" | "done" | "failed"; report: TickReport | null; error: string | null }
  >();
  const childServers = new Map<string, ReturnType<typeof createServer>>();

  const config = () => loadConfig(root);

  /**
   * The archive is its own view, never a Kanban column: the board payload stays
   * archive-free so finished work cannot reappear in the columns or the counts.
   */
  const archivePayload = (limit: number) => {
    const cfg = config();
    const archived = store
      .listArchived()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: archived.length,
      limit,
      cards: archived.slice(0, limit).map((card) => cardView(card, db, cfg)),
    };
  };

  const boardPayload = () => {
    const cfg = config();
    const cards = store.list().filter((card) => card.status !== "archived");
    const byStatus: Record<string, ReturnType<typeof cardView>[]> = {};
    for (const column of COLUMNS) byStatus[column] = [];
    for (const card of cards) {
      (byStatus[card.status] ??= []).push(cardView(card, db, cfg));
    }
    for (const column of COLUMNS) {
      byStatus[column]?.sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt));
    }
    return {
      board: cfg.name,
      workdir: cfg.workdir,
      readOnly,
      csrfToken,
      columns: COLUMNS,
      cards: byStatus,
      roles: loadRoles(root).map((role) => ({
        name: role.name,
        runtime: role.runtime,
        readOnly: role.readOnly,
        description: role.description,
      })),
      prompts: loadPrompts(root).map((prompt) => ({ name: prompt.name, variables: prompt.variables })),
      runtimes: RUNTIMES,
      statuses: STATUSES,
      caps: {
        maxRunning: cfg.maxRunning,
        maxRunningPerRole: cfg.maxRunningPerRole,
        tickSeconds: cfg.tickSeconds,
      },
      spend: {
        today: db.spentToday(),
        tokens: db.tokensToday(),
        capUsd: cfg.budget.perDayUsd,
        byKind: db.ledgerByKind(),
        day: today(),
      },
      leases: db.activeLeases().map((lease) => lease.cardId),
      dispatching,
    };
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestHost = request.headers.get("host") ?? url.host;
    if (!hostAllowed(requestHost)) {
      return json({ error: "non-loopback Host rejected" }, 403);
    }

    if (options.hub !== false && request.method === "GET" && path === "/api/projects") {
      const projects = listProjects(root).map((project) => {
        const projectStore = project.root === canonicalRoot ? store : new Store(project.root);
        const projectDb = project.root === canonicalRoot ? db : new LeaseDb(project.root);
        const cards = projectStore.list().filter((card) => card.status !== "archived");
        const statuses: Record<string, number> = {};
        for (const card of cards) statuses[card.status] = (statuses[card.status] ?? 0) + 1;
        const summary = {
          ...project,
          active: project.root === canonicalRoot,
          cards: cards.length,
          statuses,
          running: projectDb.activeLeases().length,
          trackedSpendUsd: projectDb.spentToday(),
          trackedTokens: projectDb.tokensToday(),
          budgetCapUsd: loadConfig(project.root).budget.perDayUsd,
          budgetDay: today(),
        };
        if (project.root !== canonicalRoot) projectDb.close();
        return summary;
      });
      const activeProjectId = projects.find((project) => project.active)?.id ?? null;
      return json({ projects, activeProjectId, registryScope: "user", csrfToken });
    }

    if (options.hub !== false && request.method === "POST" && path === "/api/projects/register") {
      if (readOnly) return json({ error: "server is read-only (--read-only)" }, 403);
      if (!originAllowed(request.headers.get("origin"), requestHost)) {
        return json({ error: "cross-origin write rejected" }, 403);
      }
      if (request.headers.get("x-ab-csrf") !== csrfToken) {
        return json({ error: "missing or invalid CSRF token" }, 403);
      }
      if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
        return json({ error: "expected application/json" }, 415);
      }
      try {
        const payload = await request.json() as { root?: unknown };
        if (typeof payload.root !== "string" || payload.root.trim() === "") {
          return json({ error: "board root required" }, 400);
        }
        return json({ project: registerProject(payload.root) });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    if (options.hub !== false) {
      const projectMatch = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(path);
      if (projectMatch) {
        const project = listProjects(root).find((candidate) => candidate.id === decodeURIComponent(projectMatch[1] as string));
        if (!project) return json({ error: "no such project" }, 404);
        let child = childServers.get(project.id);
        if (!child) {
          child = createServer({
            ...options,
            root: project.root,
            listen: false,
            hub: false,
          });
          childServers.set(project.id, child);
        }
        const rewritten = new URL(request.url);
        rewritten.pathname = projectMatch[2] || "/api/board";
        return child.handler(new Request(rewritten.toString(), request));
      }
    }

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      const indexPath = resolve(import.meta.dir, "../web/dist/index.html");
      const html = existsSync(indexPath)
        ? readFileSync(indexPath, "utf8")
        : "<!doctype html><html><head><title>Agent Board</title></head><body><main><h1>Dashboard bundle missing</h1><p>Run <code>bun run build:ui</code>.</p></main></body></html>";
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (request.method === "GET" && path.startsWith("/assets/")) {
      const dist = resolve(import.meta.dir, "../web/dist");
      const assetPath = resolve(dist, `.${path}`);
      if (!assetPath.startsWith(`${dist}/`) || !existsSync(assetPath)) return json({ error: "not found" }, 404);
      const contentTypes: Record<string, string> = {
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      return new Response(Bun.file(assetPath), {
        headers: {
          "content-type": contentTypes[extname(assetPath)] ?? "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (request.method === "GET" && path === "/api/board") return json(boardPayload());

    if (request.method === "GET" && path === "/api/archive") {
      const requested = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 100;
      return json(archivePayload(limit));
    }

    if (request.method === "GET" && path === "/api/dispatch/preview") {
      return json(dispatchPreview(store, db, config()));
    }

    const dispatchMatch = /^\/api\/dispatch\/(d_[a-zA-Z0-9-]+)$/.exec(path);
    if (request.method === "GET" && dispatchMatch) {
      const state = dispatches.get(dispatchMatch[1] as string);
      return state ? json(state) : json({ error: "no such dispatch" }, 404);
    }

    if (request.method === "GET" && path.startsWith("/api/role/")) {
      const name = decodeURIComponent(path.slice("/api/role/".length));
      const role = loadRoles(root).find((candidate) => candidate.name === name);
      return role ? json(role) : json({ error: "no such role" }, 404);
    }

    if (request.method === "GET" && path.startsWith("/api/card/")) {
      const card = store.byId(decodeURIComponent(path.slice("/api/card/".length)));
      if (!card) return json({ error: "no such card" }, 404);
      const logPath = logPathFor(root, card.id);
      const tail = Number(url.searchParams.get("tail") ?? 60);
      const logLines = existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").slice(-Math.min(Math.max(tail, 1), 500))
        : [];
      return json({
        ...cardView(card, db, config()),
        body: card.body,
        budgetUsd: card.budgetUsd,
        maxTurns: card.maxTurns,
        skills: card.skills,
        goal: card.goal,
        createdAt: card.createdAt,
        ...dependencyView(card, store.listAll()),
        runs: db.runs(card.id, 8),
        log: logLines,
      });
    }

    if (request.method !== "POST") return json({ error: "not found" }, 404);

    if (readOnly) return json({ error: "server is read-only (--read-only)" }, 403);
    if (!originAllowed(request.headers.get("origin"), requestHost)) {
      return json({ error: "cross-origin write rejected" }, 403);
    }
    if (request.headers.get("x-ab-csrf") !== csrfToken) {
      return json({ error: "missing or invalid CSRF token" }, 403);
    }
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return json({ error: "expected application/json" }, 415);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    if (path === "/api/add") {
      if (typeof payload.title !== "string") return json({ error: "title must be a string" }, 400);
      const title = payload.title.trim();
      if (!title) return json({ error: "title required" }, 400);
      if (payload.role !== undefined && payload.role !== null && typeof payload.role !== "string") {
        return json({ error: "role must be a string or null" }, 400);
      }
      const role = payload.role === null || payload.role === undefined ? null : payload.role;
      const roles = loadRoles(root);
      if (role && !roles.some((candidate) => candidate.name === role)) {
        return json({ error: `no such role: ${role}` }, 400);
      }
      const roleDef = roles.find((candidate) => candidate.name === role) ?? null;
      if (payload.body !== undefined && typeof payload.body !== "string") {
        return json({ error: "body must be a string" }, 400);
      }
      const body = payload.body ?? "";
      const mode = payload.mode === undefined ? null : payload.mode;
      if (mode !== null && mode !== "triage" && mode !== "ready") {
        return json({ error: "mode must be triage or ready" }, 400);
      }
      if (mode === "ready" && (!role || body.trim() === "")) {
        return json({ error: "ready mode requires a role and non-empty specification" }, 400);
      }
      if (payload.workspace !== undefined && typeof payload.workspace !== "string") {
        return json({ error: "workspace must be a string" }, 400);
      }
      const workspace = payload.workspace ?? "repo";
      if (!["repo", "worktree", "scratch"].includes(workspace)) {
        return json({ error: "bad workspace" }, 400);
      }
      let runtime: Runtime | null = roleDef?.runtime ?? null;
      if (payload.runtime !== undefined) {
        if (payload.runtime === null) runtime = null;
        else if ((RUNTIMES as readonly unknown[]).includes(payload.runtime)) runtime = payload.runtime as Runtime;
        else return json({ error: "bad runtime" }, 400);
      }
      if (payload.model !== undefined && payload.model !== null && typeof payload.model !== "string") {
        return json({ error: "model must be a string or null" }, 400);
      }
      const model = payload.model === undefined || payload.model === null
        ? payload.model === null ? null : roleDef?.model ?? null
        : payload.model.trim() || null;
      let parents: string[] = [];
      let priority = 0;
      let budgetUsd = roleDef?.budgetUsd ?? null;
      let maxTurns = roleDef?.maxTurns ?? null;
      try {
        if (payload.parents !== undefined) parents = validateParents(store, payload.parents);
        if (payload.priority !== undefined) priority = finiteNumber(payload.priority, "priority") as number;
        if (payload.budgetUsd !== undefined) {
          budgetUsd = finiteNumber(payload.budgetUsd, "budgetUsd", { nullable: true, min: 0 });
        }
        if (payload.maxTurns !== undefined) {
          maxTurns = finiteNumber(payload.maxTurns, "maxTurns", { nullable: true, min: 1, integer: true });
        }
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      const explicitReady = mode === "ready";
      const legacyReady = mode === null && role !== null;
      const all = cardsById(store.listAll());
      const dependenciesDone = parents.every((id) => {
        const parent = all.get(id);
        return parent?.status === "done" || parent?.status === "archived";
      });
      const card = store.create({
        title,
        body,
        role,
        runtime,
        model,
        parents,
        priority,
        budgetUsd,
        maxTurns,
        workspace: workspace as Card["workspace"],
        status: explicitReady || legacyReady ? dependenciesDone ? "ready" : "todo" : "triage",
      });
      log(`web: added ${card.id} (${card.status})`);
      return json({ card: cardView(card, db, config()) });
    }

    const setMatch = /^\/api\/card\/([^/]+)\/set$/.exec(path);
    if (setMatch) {
      const card = store.byId(decodeURIComponent(setMatch[1] as string));
      if (!card) return json({ error: "no such card" }, 404);
      if (db.lease(card.id) || db.hasActiveTriage(card.id)) {
        return json({ error: "card is being worked — stop the run first" }, 409);
      }
      if (card.status === "running") {
        return json({ error: "card is running without a lease — dispatch once to recover it" }, 409);
      }
      const patch: Partial<Card> = {};
      try {
        if (payload.action !== undefined) {
          if (typeof payload.action !== "string") throw new Error("action must be a string");
          patch.status = lifecycleStatus(card, String(payload.action) as LifecycleAction, false);
        } else if (payload.status !== undefined) {
          if (typeof payload.status !== "string") throw new Error("status must be a string");
          const status = String(payload.status);
          if (!(STATUSES as readonly string[]).includes(status)) throw new Error("bad status");
          const action = lifecycleActionForStatus(card, status as Status);
          patch.status = lifecycleStatus(card, action, false);
        }
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      if (patch.status && patch.status !== "blocked") patch.blockedReason = null;
      if (payload.role !== undefined) {
        if (payload.role === null) patch.role = null;
        const role = payload.role === null ? null : String(payload.role);
        if (role === null) {
          patch.role = null;
        } else {
          const found = loadRoles(root).find((candidate) => candidate.name === role);
          if (!found) return json({ error: "bad role" }, 400);
          patch.role = role;
          if (payload.runtime === undefined) patch.runtime = found.runtime;
        }
      }
      if (payload.runtime !== undefined) {
        if (payload.runtime === null) patch.runtime = null;
        else {
          const runtime = String(payload.runtime);
          if (!(RUNTIMES as readonly string[]).includes(runtime)) return json({ error: "bad runtime" }, 400);
          patch.runtime = runtime as Runtime;
        }
      }
      // The dashboard's role dropdown changes runtime with the role, so this is
      // the common path, not an edge case: a stale session id would make the very
      // next run fail against a CLI that never created it.
      if (!sessionSurvivesRuntime(card, patch.runtime)) patch.sessionId = null;
      if (payload.workspace !== undefined) {
        const workspace = String(payload.workspace);
        if (!["repo", "worktree", "scratch"].includes(workspace)) return json({ error: "bad workspace" }, 400);
        patch.workspace = workspace as Card["workspace"];
      }
      if (payload.title !== undefined) {
        if (typeof payload.title !== "string") return json({ error: "title must be a string" }, 400);
        const title = payload.title.trim();
        if (!title) return json({ error: "title required" }, 400);
        patch.title = title;
      }
      if (payload.body !== undefined) {
        if (typeof payload.body !== "string") return json({ error: "body must be a string" }, 400);
        patch.body = payload.body;
      }
      if (payload.model !== undefined) {
        if (payload.model !== null && typeof payload.model !== "string") {
          return json({ error: "model must be a string or null" }, 400);
        }
        patch.model = payload.model === null ? null : payload.model.trim() || null;
      }
      if (payload.handoff !== undefined) {
        if (payload.handoff !== null && typeof payload.handoff !== "string") {
          return json({ error: "handoff must be a string or null" }, 400);
        }
        patch.handoff = payload.handoff;
      }
      try {
        if (payload.parents !== undefined) patch.parents = validateParents(store, payload.parents, card.id);
        if (payload.priority !== undefined) patch.priority = finiteNumber(payload.priority, "priority") as number;
        if (payload.budgetUsd !== undefined) {
          patch.budgetUsd = finiteNumber(payload.budgetUsd, "budgetUsd", { nullable: true, min: 0 });
          if (patch.budgetUsd !== null && patch.budgetUsd < db.spentOnCard(card.id)) {
            throw new Error("budgetUsd cannot be below already-spent amount");
          }
        }
        if (payload.maxTurns !== undefined) {
          patch.maxTurns = finiteNumber(payload.maxTurns, "maxTurns", { nullable: true, min: 1, integer: true });
        }
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      const nextParents = patch.parents ?? card.parents;
      const nextAll = cardsById(store.listAll());
      const next = { ...card, ...patch, parents: nextParents };
      if (next.status === "ready" && !parentsSatisfied(next, nextAll)) patch.status = "todo";
      if (patch.status === "done") {
        const dependents = store.listAll().filter((candidate) => candidate.parents.includes(card.id));
        const handoff = patch.handoff === undefined ? card.handoff : patch.handoff;
        if (dependents.length > 0 && !handoff?.trim()) {
          return json({ error: "completion requires a handoff because this card has dependents" }, 400);
        }
      }
      if (Object.keys(patch).length === 0) return json({ error: "nothing to set" }, 400);
      const mutation = db.mutateUnleased(card.id, () => store.update(card.id, patch));
      if (!mutation.ok) return json({ error: "card is being worked — stop the run first" }, 409);
      const updated = mutation.value;
      log(`web: set ${card.id} → ${updated.status}/${updated.role ?? "-"}`);
      return json({ card: cardView(updated, db, config()) });
    }

    const triageMatch = /^\/api\/card\/([^/]+)\/triage$/.exec(path);
    if (triageMatch) {
      const card = store.byId(decodeURIComponent(triageMatch[1] as string));
      if (!card) return json({ error: "no such card" }, 404);
      if (db.lease(card.id) || db.hasActiveTriage(card.id) || card.status === "running") {
        return json({ error: "card is being worked — stop the run first" }, 409);
      }
      if (card.status !== "triage") return json({ error: "only cards in triage may be triaged" }, 400);
      const cfg = config();
      const outcome = await triageCard(store, db, cfg, loadRoles(root), card, {
        log,
      });
      return json({ outcome });
    }

    if (path === "/api/dispatch") {
      if (dispatching) return json({ error: "a dispatch is already running" }, 409);
      if (typeof payload.fingerprint !== "string") {
        return json({ error: "dispatch fingerprint required; preview first" }, 400);
      }
      const current = dispatchPreview(store, db, config(), options.tickOptions);
      if (payload.fingerprint !== current.fingerprint) {
        return json({ error: "board changed since preview; preview again" }, 409);
      }
      dispatching = true;
      const dispatchId = `d_${crypto.randomUUID()}`;
      dispatches.set(dispatchId, { status: "running", report: null, error: null });
      dispatchPromise = Promise.resolve().then(async () => {
        try {
          const report = await tick(store, db, config(), {
            ...options.tickOptions,
            log,
          });
          dispatches.set(dispatchId, { status: "done", report, error: null });
        } catch (error) {
          const message = (error as Error).message;
          dispatches.set(dispatchId, { status: "failed", report: null, error: message });
          log(`dispatch ${dispatchId} failed: ${message}`);
        } finally {
          dispatching = false;
          dispatchPromise = null;
        }
      });
      return json({ dispatchId }, 202);
    }

    return json({ error: "not found" }, 404);
  };

  const server = options.listen === false
    ? null
    : Bun.serve({
        port: options.port ?? DEFAULT_DASHBOARD_PORT,
        hostname: options.hostname ?? "127.0.0.1",
        idleTimeout: 60,
        fetch: handler,
      });

  return {
    server,
    url: `http://${options.hostname ?? "127.0.0.1"}:${server?.port ?? options.port ?? DEFAULT_DASHBOARD_PORT}`,
    handler,
    csrfToken,
    stop: () => {
      server?.stop(true);
      for (const child of childServers.values()) child.stop();
      if (dispatchPromise) void dispatchPromise.finally(() => db.close());
      else db.close();
    },
  };
}
