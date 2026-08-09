import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachPlan } from "../src/attach.ts";
import { CONFIG_FILE, loadConfig } from "../src/config.ts";
import { LeaseDb } from "../src/lease.ts";
import { loadRoles } from "../src/roles.ts";
import type { RunnerInput, RunnerOutput } from "../src/runners.ts";
import { createServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { resolveWorkspace } from "../src/workspace.ts";

const CLI = join(import.meta.dir, "../bin/ab.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function command(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // `ab init` registers by default. Keep E2E state inside the disposable
    // fixture so a successful test can never pollute the user's real registry.
    env: { ...process.env, AB_PROJECTS_FILE: join(cwd, "projects.json") },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function request(
  handler: (request: Request) => Response | Promise<Response>,
  url: string,
  path: string,
  body?: unknown,
) {
  if (body === undefined) return handler(new Request(url + path));
  const board = await handler(new Request(url + "/api/board"));
  const token = String((await board.json() as { csrfToken: string }).csrfToken);
  return handler(new Request(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url, "x-ab-csrf": token },
      body: JSON.stringify(body),
    }));
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function result(overrides: Partial<RunnerOutput> = {}): RunnerOutput {
  return {
    ok: true,
    text: "fake worker finished",
    handoff: "- deterministic fake runtime\n- acceptance evidence recorded",
    blocked: null,
    sessionId: "fake-session",
    usd: 0,
    tokens: 42,
    turns: 1,
    error: null,
    ...overrides,
  };
}

async function waitForDispatch(
  handler: (request: Request) => Response | Promise<Response>,
  url: string,
  dispatchId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await json(await request(handler, url, `/api/dispatch/${dispatchId}`));
    if (state.status !== "running") return state;
    await Bun.sleep(5);
  }
  throw new Error(`dispatch ${dispatchId} did not finish`);
}

describe("complete LLM-managed workflow", () => {
  test("init → add/spec/assign/depend → preview → supervise → review/block/recover/complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "ab-e2e-"));
    roots.push(root);
    const workdir = join(root, "repo");
    mkdirSync(workdir);

    const initialized = await command(root, "init", root, "--workdir", workdir, "--name", "workflow-e2e");
    expect(initialized.exitCode).toBe(0);
    expect(initialized.stderr).toBe("");
    expect(initialized.stdout).toContain("board ready");
    expect(existsSync(join(root, CONFIG_FILE))).toBe(true);
    expect(existsSync(join(root, "projects.json"))).toBe(true);
    expect(loadRoles(root).length).toBeGreaterThanOrEqual(10);

    const store = new Store(root);
    let releaseFirst!: (value: RunnerOutput) => void;
    const firstGate = new Promise<RunnerOutput>((resolve) => { releaseFirst = resolve; });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const delivered: RunnerInput[] = [];
    let calls = 0;
    const runner = async (input: RunnerInput): Promise<RunnerOutput> => {
      delivered.push(input);
      calls += 1;
      writeFileSync(input.logPath, `fake runtime call ${calls}: visible while running\n`, "utf8");
      if (calls === 1) {
        enteredFirst();
        return firstGate;
      }
      if (calls === 2) {
        return result({
          text: "BLOCKED: waiting for deterministic fixture",
          handoff: null,
          blocked: "waiting for deterministic fixture",
          sessionId: "blocked-session",
        });
      }
      return result({ sessionId: "recovered-session" });
    };
    const server = createServer({ root, port: 0, listen: false, tickOptions: { runner } });
    const { handler, url } = server;

    const parentResponse = await request(handler, url, "/api/add", {
      title: "Implement API",
      body: "Goal: implement the deterministic API fixture.",
      role: "backend",
      mode: "ready",
      priority: 10,
    });
    expect(parentResponse.status).toBe(200);
    const parentId = (await json(parentResponse)).card.id as string;
    const childResponse = await request(handler, url, "/api/add", {
      title: "Validate API",
      body: "Goal: validate the implementation and evidence.",
      role: "qa",
      mode: "ready",
      parents: [parentId],
    });
    expect(childResponse.status).toBe(200);
    const childId = (await json(childResponse)).card.id as string;
    expect(store.requireById(childId).status).toBe("todo");

    const beforePreview = store.list().map(({ id, status, updatedAt }) => ({ id, status, updatedAt }));
    const dbBefore = new LeaseDb(root);
    const preview = await json(await request(handler, url, "/api/dispatch/preview"));
    expect(preview.start.map((item: { cardId: string }) => item.cardId)).toEqual([parentId]);
    expect(store.list().map(({ id, status, updatedAt }) => ({ id, status, updatedAt }))).toEqual(beforePreview);
    expect(dbBefore.activeLeases()).toEqual([]);
    expect(dbBefore.runs(parentId)).toEqual([]);
    dbBefore.close();

    const startedResponse = await request(handler, url, "/api/dispatch", { fingerprint: preview.fingerprint });
    expect(startedResponse.status).toBe(202);
    const dispatchId = (await json(startedResponse)).dispatchId as string;
    await firstEntered;

    const activeBoard = await json(await request(handler, url, "/api/board"));
    expect(activeBoard.cards.running.map((card: { id: string }) => card.id)).toContain(parentId);
    const activeDetail = await json(await request(handler, url, `/api/card/${parentId}`));
    expect(activeDetail.runs[0].ok).toBeNull();
    expect(activeDetail.log.join("\n")).toContain("visible while running");
    const backend = loadRoles(root).find((role) => role.name === "backend");
    expect(delivered[0]?.system).toBe(backend?.soul);
    expect(delivered[0]?.prompt).toContain("deterministic API fixture");
    expect(delivered[0]?.cwd).toBe(workdir);

    releaseFirst(result());
    expect((await waitForDispatch(handler, url, dispatchId)).status).toBe("done");
    expect(store.requireById(parentId)).toMatchObject({
      status: "review",
      sessionId: "fake-session",
    });
    expect(store.requireById(parentId).handoff).toContain("acceptance evidence");
    expect(store.requireById(childId).status).toBe("todo");

    const completedParent = await request(handler, url, `/api/card/${parentId}/set`, { action: "complete" });
    expect(completedParent.status).toBe(200);
    expect(store.requireById(parentId).status).toBe("done");

    const childPreview = await json(await request(handler, url, "/api/dispatch/preview"));
    expect(childPreview.promote).toContain(childId);
    expect(store.requireById(childId).status).toBe("todo");
    const childStart = await request(handler, url, "/api/dispatch", { fingerprint: childPreview.fingerprint });
    expect(childStart.status).toBe(202);
    await waitForDispatch(handler, url, (await json(childStart)).dispatchId as string);
    expect(store.requireById(childId)).toMatchObject({
      status: "blocked",
      blockedReason: "waiting for deterministic fixture",
      sessionId: "blocked-session",
    });

    const resolved = await request(handler, url, `/api/card/${childId}/set`, { action: "resolve" });
    expect(resolved.status).toBe(200);
    expect(store.requireById(childId)).toMatchObject({ status: "ready", blockedReason: null });
    const recoveryPreview = await json(await request(handler, url, "/api/dispatch/preview"));
    const recoveryStart = await request(handler, url, "/api/dispatch", {
      fingerprint: recoveryPreview.fingerprint,
    });
    await waitForDispatch(handler, url, (await json(recoveryStart)).dispatchId as string);
    expect(store.requireById(childId)).toMatchObject({
      status: "review",
      sessionId: "recovered-session",
    });
    expect((await request(handler, url, `/api/card/${childId}/set`, { action: "complete" })).status).toBe(200);
    expect(store.requireById(childId).status).toBe("done");
    server.stop();
  });

  test("restart recovery, invalid mutations, attach isolation, and read-only HTTP survive together", async () => {
    const root = mkdtempSync(join(tmpdir(), "ab-restart-e2e-"));
    roots.push(root);
    const workdir = join(root, "repo");
    mkdirSync(workdir);
    expect((await command(root, "init", root, "--workdir", workdir)).exitCode).toBe(0);
    const store = new Store(root);
    const orphan = store.create({
      title: "Interrupted worker",
      body: "recover after restart",
      role: "backend",
      status: "running",
    });
    const other = store.create({ title: "Other", body: "valid spec", role: "qa", status: "ready" });

    const restarted = createServer({
      root,
      port: 0,
      listen: false,
      tickOptions: { runner: async () => result({ handoff: "restart recovered" }) },
    });
    const restartPreview = await json(await request(restarted.handler, restarted.url, "/api/dispatch/preview"));
    expect(restartPreview.recover).toContain(orphan.id);
    const start = await request(restarted.handler, restarted.url, "/api/dispatch", {
      fingerprint: restartPreview.fingerprint,
    });
    expect(start.status).toBe(202);
    await waitForDispatch(restarted.handler, restarted.url, (await json(start)).dispatchId as string);
    expect(store.requireById(orphan.id).status).toBe("review");

    expect((await request(restarted.handler, restarted.url, `/api/card/${other.id}/set`, {
      status: "running",
    })).status).toBe(400);
    expect((await request(restarted.handler, restarted.url, "/api/add", {
      title: "bad dependency",
      parents: ["c_missing"],
    })).status).toBe(400);
    expect((await request(restarted.handler, restarted.url, `/api/card/${other.id}/set`, {
      parents: [other.id],
    })).status).toBe(400);
    restarted.stop();

    const reviewer = loadRoles(root).find((role) => role.name === "reviewer");
    if (!reviewer) throw new Error("reviewer role missing");
    const reviewCard = store.create({
      title: "Isolated review",
      body: "review only",
      role: "reviewer",
      runtime: "codex",
      workspace: "scratch",
    });
    const workspace = await resolveWorkspace(root, workdir, reviewCard);
    const codex = attachPlan(reviewCard, reviewer, loadConfig(root), { cwd: workspace.cwd });
    const claude = attachPlan({ ...reviewCard, runtime: "claude" }, reviewer, loadConfig(root), {
      cwd: workspace.cwd,
    });
    expect(codex.cwd).toBe(workspace.cwd);
    expect(codex.argv.slice(0, 5)).toEqual(["codex", "-s", "read-only", "-C", workspace.cwd]);
    expect(claude.cwd).toBe(workspace.cwd);
    expect(claude.argv).toContain("Read,Grep,Glob,WebFetch,WebSearch");
    expect(claude.argv).not.toContain("--add-dir");

    const readOnly = createServer({ root, port: 0, listen: false, readOnly: true });
    const board = await json(await request(readOnly.handler, readOnly.url, "/api/board"));
    expect(board.readOnly).toBe(true);
    expect(Object.values(board.cards).flat().length).toBe(store.list().length);
    expect((await request(readOnly.handler, readOnly.url, "/api/add", { title: "forbidden" })).status).toBe(403);
    expect(readFileSync(join(root, CONFIG_FILE), "utf8")).toContain('"workdir"');
    readOnly.stop();
  });
});
