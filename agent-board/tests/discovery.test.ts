import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, defaultConfig } from "../src/config.ts";
import { requireBoardRoot, resolveBoard, setExplicitBoard } from "../src/discover.ts";
import { registerProject } from "../src/projects.ts";
import { Store } from "../src/store.ts";

let fixture: string;
let previousRegistry: string | undefined;
let previousBoard: string | undefined;

/** A board root with a real config, so discovery and `loadConfig` both accept it. */
function makeBoard(root: string, name: string, workdir: string): string {
  mkdirSync(root, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  new Store(root).ensureDirs();
  writeFileSync(
    join(root, CONFIG_FILE),
    JSON.stringify({ ...defaultConfig(workdir), name, workdir }),
    "utf8",
  );
  return realpathSync(root);
}

function dir(...parts: string[]): string {
  const path = join(fixture, ...parts);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "ab-discover-")));
  previousRegistry = process.env.AB_PROJECTS_FILE;
  previousBoard = process.env.AB_BOARD;
  process.env.AB_PROJECTS_FILE = join(fixture, "projects.json");
  delete process.env.AB_BOARD;
  setExplicitBoard(null);
});

afterEach(() => {
  if (previousRegistry === undefined) delete process.env.AB_PROJECTS_FILE;
  else process.env.AB_PROJECTS_FILE = previousRegistry;
  if (previousBoard === undefined) delete process.env.AB_BOARD;
  else process.env.AB_BOARD = previousBoard;
  setExplicitBoard(null);
  rmSync(fixture, { recursive: true, force: true });
});

describe("board discovery", () => {
  test("walks up from any depth inside the project", () => {
    const repo = dir("app");
    makeBoard(repo, "app", repo);
    const deep = dir("app", "src", "feature", "nested");

    const resolution = resolveBoard(deep);
    expect(resolution.root).toBe(repo);
    expect(resolution.source).toBe("walk-up");
    expect(resolution.reason).toContain(repo);
  });

  test("finds a board that lives outside the repo it works on", () => {
    const repo = dir("code", "service");
    const boardRoot = makeBoard(dir("boards", "service"), "service", repo);
    registerProject(boardRoot);

    // Nothing in this tree, so the only way to find it is the registry.
    const resolution = resolveBoard(join(repo, "lib"));
    expect(resolution.root).toBe(boardRoot);
    expect(resolution.source).toBe("registry");
    expect(resolution.reason).toContain(repo);
  });

  test("a board in the tree always beats a registered board pointing at it", () => {
    const repo = dir("app");
    const remote = makeBoard(dir("boards", "remote"), "remote", repo);
    registerProject(remote);
    const local = makeBoard(repo, "local", repo);
    registerProject(local);

    const resolution = resolveBoard(join(repo, "src"));
    expect(resolution.root).toBe(local);
    expect(resolution.source).toBe("walk-up");
    // The loser is still reported, so `ab where` can explain the choice.
    expect(resolution.candidates.map((project) => project.root)).toContain(remote);
  });

  test("the most specific registered workdir wins", () => {
    const outer = dir("mono");
    const inner = dir("mono", "packages", "api");
    const outerBoard = makeBoard(dir("boards", "mono"), "mono", outer);
    const innerBoard = makeBoard(dir("boards", "api"), "api", inner);
    registerProject(outerBoard);
    registerProject(innerBoard);

    expect(resolveBoard(join(inner, "src")).root).toBe(innerBoard);
    expect(resolveBoard(join(outer, "docs")).root).toBe(outerBoard);
  });

  test("two boards claiming one workdir refuse to guess", () => {
    const repo = dir("shared");
    const first = makeBoard(dir("boards", "first"), "first", repo);
    const second = makeBoard(dir("boards", "second"), "second", repo);
    registerProject(first);
    registerProject(second);

    const resolution = resolveBoard(repo);
    expect(resolution.root).toBeNull();
    expect(resolution.ambiguous.map((project) => project.root).sort()).toEqual([first, second].sort());
    expect(resolution.suggestion).toContain("--board");
    // Guessing here would run a worker against the wrong checkout.
    expect(() => requireBoardRoot(repo)).toThrow("say which one");
  });

  test("a sibling directory is not treated as inside the workdir", () => {
    const repo = dir("app");
    const board = makeBoard(dir("boards", "app"), "app", repo);
    registerProject(board);
    // `app-extra` shares a string prefix with `app` but is a different project.
    const sibling = dir("app-extra");

    expect(resolveBoard(sibling).root).toBeNull();
  });

  test("AB_BOARD overrides discovery, and --board overrides AB_BOARD", () => {
    const repo = dir("app");
    makeBoard(repo, "in-tree", repo);
    const envBoard = makeBoard(dir("boards", "env"), "env", dir("elsewhere"));
    const flagBoard = makeBoard(dir("boards", "flag"), "flag", dir("elsewhere-too"));

    process.env.AB_BOARD = envBoard;
    expect(resolveBoard(join(repo, "src")).root).toBe(envBoard);
    expect(resolveBoard(join(repo, "src")).source).toBe("env");

    setExplicitBoard(flagBoard);
    expect(resolveBoard(join(repo, "src")).root).toBe(flagBoard);
    expect(resolveBoard(join(repo, "src")).source).toBe("explicit");
  });

  test("an override pointing at a non-board says so instead of falling back", () => {
    const repo = dir("app");
    makeBoard(repo, "in-tree", repo);
    setExplicitBoard(dir("not-a-board"));

    const resolution = resolveBoard(join(repo, "src"));
    expect(resolution.root).toBeNull();
    expect(resolution.reason).toContain("has no board/ directory");
    expect(resolution.suggestion).toContain("ab init");
  });

  test("with no board anywhere it suggests initialising the git repo, not the cwd", () => {
    const repo = dir("fresh");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const deep = dir("fresh", "src", "deep");

    const resolution = resolveBoard(deep);
    expect(resolution.root).toBeNull();
    expect(resolution.suggestion).toBe(`ab init ${repo}`);
    expect(() => requireBoardRoot(deep)).toThrow("no board covers");
  });

  test("a registered board whose files are gone is reported, not silently used", () => {
    const repo = dir("app");
    const board = makeBoard(dir("boards", "app"), "app", repo);
    registerProject(board);
    rmSync(board, { recursive: true, force: true });

    const resolution = resolveBoard(repo);
    expect(resolution.root).toBeNull();
    expect(resolution.reason).toContain("is gone");
    expect(resolution.suggestion).toContain("ab projects remove");
  });

  test("a corrupt registry never hides a board that is right here", () => {
    const repo = dir("app");
    const local = makeBoard(repo, "local", repo);
    writeFileSync(process.env.AB_PROJECTS_FILE as string, "{ not json", "utf8");

    expect(resolveBoard(join(repo, "src")).root).toBe(local);
  });
});

describe("ab init discoverability", () => {
  const cli = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "../bin/ab.ts"), ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AB_PROJECTS_FILE: process.env.AB_PROJECTS_FILE as string },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  test("init registers the board, so its workdir can find it later", async () => {
    const repo = dir("code", "service");
    const boardRoot = dir("boards", "service");
    const init = await cli(fixture, "init", boardRoot, "--workdir", repo, "--name", "service");
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("registered as");

    // The proof: a fresh process, standing in the repo, with no board in the tree.
    const where = await cli(repo, "where");
    expect(where.exitCode).toBe(0);
    expect(where.stdout).toContain("registry");
    expect(where.stdout).toContain(realpathSync(boardRoot));
  });

  test("--no-register keeps a throwaway board out of the registry", async () => {
    const repo = dir("scratch");
    const init = await cli(fixture, "init", repo, "--no-register");
    expect(init.stdout).not.toContain("registered as");
    expect(await Bun.file(process.env.AB_PROJECTS_FILE as string).exists()).toBe(false);
    // It is still usable from inside its own tree.
    const where = await cli(repo, "where");
    expect(where.stdout).toContain("walk-up");
  });

  test("`ab where` explains an ambiguous directory and exits nonzero", async () => {
    const repo = dir("shared");
    for (const name of ["first", "second"]) {
      const board = makeBoard(dir("boards", name), name, repo);
      registerProject(board);
    }
    const where = await cli(repo, "where");
    expect(where.exitCode).toBe(1);
    expect(where.stderr).toContain("say which one");
    expect(where.stderr).toContain("first");
    expect(where.stderr).toContain("second");
  });
});
