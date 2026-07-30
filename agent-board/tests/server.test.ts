import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { seedRoles } from "../src/roles.ts";
import { seedPrompts } from "../src/prompts.ts";
import { CONFIG_FILE, defaultConfig } from "../src/config.ts";
import { createServer, hostAllowed, originAllowed } from "../src/server.ts";
import type { TickOptions } from "../src/dispatcher.ts";
import type { RunnerOutput } from "../src/runners.ts";

let root: string;
let store: Store;
let handle: ReturnType<typeof createServer> | undefined;

/** `localFetch().json()` is `unknown`; tests assert on shapes, so narrow once here. */
const asAny = (value: unknown) => value as Record<string, any>;

function boot(readOnly = false, tickOptions?: TickOptions) {
  handle = createServer({ root, port: 0, readOnly, tickOptions, listen: false });
  return handle.url;
}

function localFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!handle) throw new Error("server is not booted");
  return handle.handler(input instanceof Request ? input : new Request(String(input), init));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ab-serve-"));
  store = new Store(root);
  store.ensureDirs();
  seedRoles(root);
  seedPrompts(root);
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ ...defaultConfig(root), name: "test" }), "utf8");
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("origin check", () => {
  test("same-origin passes and a missing Origin fails closed", () => {
    expect(originAllowed(null, "127.0.0.1:4321")).toBe(false);
    expect(originAllowed("http://127.0.0.1:4321", "127.0.0.1:4321")).toBe(true);
  });

  test("a foreign page cannot drive the board", () => {
    expect(originAllowed("https://evil.example", "127.0.0.1:4321")).toBe(false);
    expect(originAllowed("https://127.0.0.1:4321", "127.0.0.1:4321")).toBe(false);
    expect(originAllowed("http://127.0.0.1:9999", "127.0.0.1:4321")).toBe(false);
  });

  test("only literal loopback Host values are accepted", () => {
    expect(hostAllowed("127.0.0.1:4321")).toBe(true);
    expect(hostAllowed("localhost:4321")).toBe(true);
    expect(hostAllowed("[::1]:4321")).toBe(true);
    expect(hostAllowed("127.1:4321")).toBe(false);
    expect(hostAllowed("2130706433:4321")).toBe(false);
    expect(hostAllowed("user@127.0.0.1:4321")).toBe(false);
    expect(hostAllowed("board.example:4321")).toBe(false);
  });
});

describe("dashboard", () => {
  test("serves the local production dashboard with no external requests", async () => {
    const html = await (await localFetch(boot())).text();
    expect(html).toContain("<title>Agent Board</title>");
    expect(html).toContain("/assets/");
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:.*\.css/);
  });

  test("dashboard bundle exposes project, create, assign, roles, and dispatch workflows", async () => {
    const html = await (await localFetch(boot())).text();
    const script = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    const bundle = await (await localFetch(`${handle?.url}${script}`)).text();
    for (const marker of [
      "Switch project", "Create work", "Assigned role", "Roles & souls",
      "Start dispatch", "/api/projects/",
      "/api/dispatch/preview", "SOUL.md", "Use dark theme", "ab-theme",
    ]) expect(bundle).toContain(marker);
    expect(bundle).not.toContain("Tracked metered spend");
    expect(bundle).not.toContain("Tracked spend");
  });

  test("project hub exposes the active board without mixing card stores", async () => {
    store.create({ title: "only here" });
    const data = asAny(await (await localFetch(`${boot()}/api/projects`)).json());
    const active = data.projects.find((project: Record<string, unknown>) => project.active);
    expect(active.root).toBe(realpathSync(root));
    expect(active.cards).toBe(1);
    expect(active.statuses.triage).toBe(1);
  });

  test("board payload groups cards by column and reports caps", async () => {
    store.create({ title: "idea" });
    store.create({ title: "work", role: "backend", status: "ready" });
    const data = asAny(await (await localFetch(`${boot()}/api/board`)).json());
    expect(data.board).toBe("test");
    expect(data.cards.triage).toHaveLength(1);
    expect(data.cards.ready).toHaveLength(1);
    expect(data.cards.ready[0].body.trim()).toBe("");
    expect(data.roles.length).toBeGreaterThanOrEqual(10);
    expect(data.caps.maxRunning).toBe(2);
    expect(data.spend.capUsd).toBe(10);
  });

  test("card detail carries spec, runs and a log tail", async () => {
    const card = store.create({ title: "t", body: "**Goal** x", role: "qa", status: "ready" });
    const data = asAny(await (await localFetch(`${boot()}/api/card/${card.id}`)).json());
    expect(data.body).toContain("**Goal** x");
    expect(data.runs).toEqual([]);
    expect(Array.isArray(data.log)).toBe(true);
  });

  test("card detail resolves dependencies and dependents, including missing legacy parents", async () => {
    const parent = store.create({ title: "parent", status: "done" });
    const child = store.create({ title: "child", parents: [parent.id, "c_missing"], status: "todo" });
    const parentData = asAny(await (await localFetch(`${boot()}/api/card/${parent.id}`)).json());
    expect(parentData.dependents).toEqual([{ id: child.id, title: "child", status: "todo" }]);
    const childData = asAny(await (await localFetch(`${handle?.url}/api/card/${child.id}`)).json());
    expect(childData.dependencies[0]).toMatchObject({ id: parent.id, exists: true, satisfied: true });
    expect(childData.dependencies[1]).toMatchObject({ id: "c_missing", exists: false, satisfied: false });
  });

  test("role detail exposes the complete execution contract without file paths", async () => {
    const data = asAny(await (await localFetch(`${boot()}/api/role/backend`)).json());
    expect(data.name).toBe("backend");
    expect(data.soul).toContain("backend");
    expect(data).toHaveProperty("skills");
    expect(data).toHaveProperty("budgetUsd");
    expect(JSON.stringify(data)).not.toContain(root);
  });

  test("unknown cards 404", async () => {
    expect((await localFetch(`${boot()}/api/card/c_nope`)).status).toBe(404);
  });

  test("DNS rebinding Host is rejected before every dashboard and sensitive GET route", async () => {
    const card = store.create({ title: "sensitive", body: "private card spec", role: "backend", status: "ready" });
    const url = boot();
    for (const path of [
      "/",
      "/index.html",
      "/api/board",
      "/api/dispatch/preview",
      "/api/dispatch/d_unknown",
      "/api/role/backend",
      `/api/card/${card.id}`,
    ]) {
      const response = await localFetch(url + path, {
        headers: { host: "board.attacker.example" },
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: "non-loopback Host rejected" });
    }
  });
});

describe("mutations", () => {
  const write = (url: string, path: string, body: unknown) =>
    localFetch(url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: url,
        "x-ab-csrf": handle?.csrfToken ?? "",
      },
      body: JSON.stringify(body),
    });

  test("add creates a triage card, or a ready card when routed", async () => {
    const url = boot();
    const triaged = asAny(await (await write(url, "/api/add", { title: "vague" })).json());
    expect(triaged.card.status).toBe("triage");
    const routed = asAny(await (await write(url, "/api/add", { title: "clear", role: "backend" })).json());
    expect(routed.card.status).toBe("ready");
    expect(routed.card.runtime).toBe("codex");
    expect(store.list()).toHaveLength(2);
  });

  test("add accepts the full designer contract and gates unresolved dependencies", async () => {
    const parent = store.create({ title: "parent", status: "ready" });
    const url = boot();
    const response = await write(url, "/api/add", {
      title: "child",
      body: "implement it",
      role: "backend",
      workspace: "worktree",
      priority: 30,
      parents: [parent.id],
      runtime: "claude",
      model: "model-x",
      budgetUsd: 0.75,
      maxTurns: 12,
      mode: "ready",
    });
    expect(response.status).toBe(200);
    const data = asAny(await response.json());
    expect(data.card.status).toBe("todo");
    const created = store.requireById(data.card.id);
    expect(created.body.trim()).toBe("implement it");
    expect(created).toMatchObject({
      priority: 30,
      parents: [parent.id],
      runtime: "claude",
      model: "model-x",
      budgetUsd: 0.75,
      maxTurns: 12,
    });
  });

  test("set changes role, status and workspace", async () => {
    const card = store.create({ title: "t", role: "backend", status: "ready" });
    const url = boot();
    const res = asAny(await (await write(url, `/api/card/${card.id}/set`, { role: "qa", workspace: "worktree" })).json());
    expect(res.card.role).toBe("qa");
    expect(res.card.workspace).toBe("worktree");
    expect(store.requireById(card.id).role).toBe("qa");
  });

  test("set atomically edits spec, routing, dependency, and budget fields", async () => {
    const parent = store.create({ title: "parent", status: "done" });
    const card = store.create({ title: "old", role: "backend", status: "ready" });
    const response = await write(boot(), `/api/card/${card.id}/set`, {
      title: "new",
      body: "new spec",
      parents: [parent.id],
      priority: 20,
      runtime: "claude",
      model: "m",
      budgetUsd: 1,
      maxTurns: 9,
    });
    expect(response.status).toBe(200);
    const updated = store.requireById(card.id);
    expect(updated.body.trim()).toBe("new spec");
    expect(updated).toMatchObject({
      title: "new",
      parents: [parent.id],
      priority: 20,
      runtime: "claude",
      model: "m",
      budgetUsd: 1,
      maxTurns: 9,
    });
  });

  test("bad values are rejected, not coerced", async () => {
    const card = store.create({ title: "t" });
    const url = boot();
    expect((await write(url, `/api/card/${card.id}/set`, { role: "nope" })).status).toBe(400);
    expect((await write(url, `/api/card/${card.id}/set`, { status: "nope" })).status).toBe(400);
    expect((await write(url, `/api/card/${card.id}/set`, {})).status).toBe(400);
    expect((await write(url, `/api/card/${card.id}/set`, { priority: "10" })).status).toBe(400);
    expect((await write(url, `/api/card/${card.id}/set`, { maxTurns: 1.5 })).status).toBe(400);
    expect((await write(url, `/api/card/${card.id}/set`, { budgetUsd: -1 })).status).toBe(400);
  });

  test("dependency and lifecycle invariants reject missing, self, cycles, and manual running", async () => {
    const a = store.create({ title: "a", status: "ready" });
    const b = store.create({ title: "b", parents: [a.id], status: "todo" });
    const url = boot();
    expect((await write(url, `/api/card/${a.id}/set`, { parents: ["c_missing"] })).status).toBe(400);
    expect((await write(url, `/api/card/${a.id}/set`, { parents: [a.id] })).status).toBe(400);
    expect((await write(url, `/api/card/${a.id}/set`, { parents: [b.id] })).status).toBe(400);
    expect((await write(url, `/api/card/${a.id}/set`, { status: "running" })).status).toBe(400);
  });

  test("named lifecycle actions enforce state-specific transitions", async () => {
    const card = store.create({ title: "t", status: "review" });
    const url = boot();
    expect((await write(url, `/api/card/${card.id}/set`, { action: "send_to_triage" })).status).toBe(400);
    expect((await write(url, `/api/card/${card.id}/set`, { action: "complete" })).status).toBe(200);
    expect(store.requireById(card.id).status).toBe("done");
  });

  test("add rejects invalid parents, workspace, ready shape, and non-finite numbers", async () => {
    const url = boot();
    expect((await write(url, "/api/add", { title: "x", parents: ["c_missing"] })).status).toBe(400);
    expect((await write(url, "/api/add", { title: "x", workspace: "host" })).status).toBe(400);
    expect((await write(url, "/api/add", { title: "x", role: "backend", mode: "ready" })).status).toBe(400);
    const infinite = await localFetch(`${url}/api/add`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url, "x-ab-csrf": handle?.csrfToken ?? "" },
      body: '{"title":"x","priority":1e999}',
    });
    expect(infinite.status).toBe(400);
  });

  test("an add with no title is refused", async () => {
    expect((await write(boot(), "/api/add", { title: "  " })).status).toBe(400);
  });

  test("cross-origin writes are refused", async () => {
    const url = boot();
    const res = await localFetch(`${url}/api/add`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ title: "pwn" }),
    });
    expect(res.status).toBe(403);
    expect(store.list()).toHaveLength(0);
  });

  test("DNS rebinding Host is rejected before every sensitive POST route", async () => {
    const card = store.create({ title: "sensitive", body: "unchanged", status: "triage" });
    const url = boot();
    for (const [path, body] of [
      ["/api/add", { title: "pwn" }],
      [`/api/card/${card.id}/set`, { body: "pwn" }],
      [`/api/card/${card.id}/triage`, {}],
      ["/api/dispatch", { fingerprint: "pwn" }],
    ] as const) {
      const response = await localFetch(url + path, {
        method: "POST",
        headers: {
          host: "board.attacker.example",
          origin: "http://board.attacker.example",
          "content-type": "application/json",
          "x-ab-csrf": handle?.csrfToken ?? "",
        },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: "non-loopback Host rejected" });
    }
    expect(store.list()).toHaveLength(1);
    expect(store.requireById(card.id).body.trim()).toBe("unchanged");
  });

  test("missing CSRF token is refused", async () => {
    const url = boot();
    const noToken = await localFetch(`${url}/api/add`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ title: "pwn" }),
    });
    expect(noToken.status).toBe(403);
    expect(store.list()).toHaveLength(0);
  });

  test("restart rotates CSRF while dashboard mutations remain compatible", async () => {
    const firstUrl = boot();
    const oldToken = handle?.csrfToken;
    handle?.stop();
    handle = createServer({ root, port: 0, listen: false });
    const url = handle.url;
    expect(handle.csrfToken).not.toBe(oldToken);
    const stale = await localFetch(`${url}/api/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: url,
        "x-ab-csrf": oldToken ?? "",
      },
      body: JSON.stringify({ title: "stale dashboard" }),
    });
    expect(stale.status).toBe(403);
    const added = await write(url, "/api/add", {
      title: "fresh dashboard",
      body: "compatible mutation",
      role: "backend",
      mode: "ready",
    });
    expect(added.status).toBe(200);
    const card = asAny(await added.json()).card;
    expect((await write(url, `/api/card/${card.id}/set`, { body: "saved after restart" })).status).toBe(200);
    expect(store.requireById(card.id).body.trim()).toBe("saved after restart");
    expect(firstUrl).toBe(url);
  });

  test("non-JSON writes are refused", async () => {
    const url = boot();
    const res = await localFetch(`${url}/api/add`, {
      method: "POST",
      headers: { origin: url, "x-ab-csrf": handle?.csrfToken ?? "" },
      body: "title=pwn",
    });
    expect(res.status).toBe(415);
  });

  test("read-only mode blocks every mutation but still serves the board", async () => {
    const url = boot(true);
    expect((await write(url, "/api/add", { title: "x" })).status).toBe(403);
    const data = asAny(await (await localFetch(`${url}/api/board`)).json());
    expect(data.readOnly).toBe(true);
  });

  test("a leased card cannot be edited from the browser", async () => {
    const card = store.create({ title: "t", role: "backend", status: "ready" });
    const url = boot();
    const { LeaseDb } = await import("../src/lease.ts");
    const db = new LeaseDb(root);
    db.claim(card.id, "someone-else");
    db.close();
    expect((await write(url, `/api/card/${card.id}/set`, { body: "race edit" })).status).toBe(409);
  });

  test("a card with active triage cannot be edited from the browser", async () => {
    const card = store.create({ title: "triaging" });
    const url = boot();
    const { LeaseDb } = await import("../src/lease.ts");
    const db = new LeaseDb(root);
    expect(db.claimTriage(card.id, "triager", card.updatedAt)).not.toBeNull();
    db.close();
    expect((await write(url, `/api/card/${card.id}/set`, { body: "race edit" })).status).toBe(409);
  });

  test("dispatch preview is pure and a changed fingerprint starts nothing", async () => {
    const card = store.create({ title: "gated", role: "backend", status: "ready" });
    const url = boot();
    const before = store.requireById(card.id);
    const preview = asAny(await (await localFetch(`${url}/api/dispatch/preview`)).json());
    expect(preview.start[0].cardId).toBe(card.id);
    expect(store.requireById(card.id)).toEqual(before);
    store.update(card.id, { priority: 99 });
    expect((await write(url, "/api/dispatch", { fingerprint: preview.fingerprint })).status).toBe(409);
    expect(store.requireById(card.id).status).toBe("ready");
  });

  test("dispatch starts asynchronously, rejects a race, and exposes polling status", async () => {
    let release!: (result: RunnerOutput) => void;
    const gate = new Promise<RunnerOutput>((resolve) => { release = resolve; });
    const card = store.create({ title: "run", role: "backend", status: "ready" });
    const url = boot(false, { runner: async () => gate });
    const preview = asAny(await (await localFetch(`${url}/api/dispatch/preview`)).json());
    const started = await write(url, "/api/dispatch", { fingerprint: preview.fingerprint });
    expect(started.status).toBe(202);
    const dispatchId = asAny(await started.json()).dispatchId;
    expect((await write(url, "/api/dispatch", { fingerprint: preview.fingerprint })).status).toBe(409);
    const active = asAny(await (await localFetch(`${url}/api/dispatch/${dispatchId}`)).json());
    expect(active.status).toBe("running");
    release({
      ok: true,
      text: "done",
      handoff: "async complete",
      blocked: null,
      sessionId: null,
      usd: 0,
      tokens: 0,
      turns: 1,
      error: null,
    });
    let complete: Record<string, any> = {};
    for (let attempt = 0; attempt < 30; attempt += 1) {
      complete = asAny(await (await localFetch(`${url}/api/dispatch/${dispatchId}`)).json());
      if (complete.status !== "running") break;
      await Bun.sleep(5);
    }
    expect(complete.status).toBe("done");
    expect(complete.report.started).toEqual([card.id]);
  });

  test("GET on a mutation path is not found", async () => {
    expect((await localFetch(`${boot()}/api/dispatch`)).status).toBe(404);
  });
});

describe("archive view", () => {
  const write = (url: string, path: string, body: unknown) =>
    localFetch(url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: url,
        "x-ab-csrf": handle?.csrfToken ?? "",
      },
      body: JSON.stringify(body),
    });

  test("archived cards leave the board payload and appear in the archive", async () => {
    const live = store.create({ title: "live", role: "backend", status: "ready" });
    const shipped = store.create({ title: "shipped", role: "backend", status: "done" });
    const url = boot();

    const archived = asAny(await (await write(url, `/api/card/${shipped.id}/set`, { action: "archive" })).json());
    expect(archived.card.status).toBe("archived");

    const board = asAny(await (await localFetch(`${url}/api/board`)).json());
    expect(board.columns).not.toContain("archived");
    expect(Object.values(board.cards).flat().map((card: any) => card.id)).toEqual([live.id]);

    const view = asAny(await (await localFetch(`${url}/api/archive`)).json());
    expect(view.total).toBe(1);
    expect(view.cards.map((card: any) => card.id)).toEqual([shipped.id]);
    expect(view.cards[0].allowedActions).toEqual(["reopen"]);
  });

  test("an archived card is still readable and can be reopened onto the board", async () => {
    const card = store.create({ title: "shipped", role: "backend", status: "done" });
    const url = boot();
    await write(url, `/api/card/${card.id}/set`, { action: "archive" });

    const detail = asAny(await (await localFetch(`${url}/api/card/${card.id}`)).json());
    expect(detail.status).toBe("archived");

    const reopened = asAny(await (await write(url, `/api/card/${card.id}/set`, { action: "reopen" })).json());
    expect(reopened.card.status).toBe("ready");
    expect(asAny(await (await localFetch(`${url}/api/archive`)).json()).total).toBe(0);
    expect(store.list().map((entry) => entry.id)).toEqual([card.id]);
  });

  test("the archive page size is clamped to a sane window", async () => {
    for (let index = 0; index < 3; index += 1) {
      const card = store.create({ title: `shipped ${index}`, status: "done" });
      store.update(card.id, { status: "archived" });
    }
    const url = boot();
    const capped = asAny(await (await localFetch(`${url}/api/archive?limit=2`)).json());
    expect(capped.total).toBe(3);
    expect(capped.limit).toBe(2);
    expect(capped.cards).toHaveLength(2);
    expect(asAny(await (await localFetch(`${url}/api/archive?limit=9999`)).json()).limit).toBe(500);
    expect(asAny(await (await localFetch(`${url}/api/archive?limit=nonsense`)).json()).limit).toBe(100);
  });

  test("a read-only dashboard can browse the archive but not change it", async () => {
    const card = store.create({ title: "shipped", status: "done" });
    store.update(card.id, { status: "archived" });
    const url = boot(true);
    expect(asAny(await (await localFetch(`${url}/api/archive`)).json()).total).toBe(1);
    expect((await write(url, `/api/card/${card.id}/set`, { action: "reopen" })).status).toBe(403);
    expect(store.listArchived()).toHaveLength(1);
  });
});

describe("dashboard role reassignment", () => {
  const write = (url: string, path: string, body: unknown) =>
    localFetch(url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: url,
        "x-ab-csrf": handle?.csrfToken ?? "",
      },
      body: JSON.stringify(body),
    });

  test("the role dropdown drops a session the new runtime cannot resume", async () => {
    const card = store.create({ title: "review the payments MR", role: "backend", runtime: "codex" });
    store.update(card.id, { sessionId: "019b2f77-codex-thread" });
    const url = boot();

    // reviewer runs on claude, so picking it changes the runtime too.
    const patched = asAny(await (await write(url, `/api/card/${card.id}/set`, { role: "reviewer" })).json());
    expect(patched.card.runtime).toBe("claude");
    expect(patched.card.sessionId).toBeNull();
    expect(store.requireById(card.id).sessionId).toBeNull();
  });

  test("an unrelated edit keeps the session", async () => {
    const card = store.create({ title: "keep going", role: "backend", runtime: "codex" });
    store.update(card.id, { sessionId: "still-valid" });
    const url = boot();
    await write(url, `/api/card/${card.id}/set`, { priority: 5 });
    expect(store.requireById(card.id).sessionId).toBe("still-valid");
  });
});
