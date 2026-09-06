import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BUDGET,
  HARD_BUDGET,
  type ContextBudget,
  type ContextPath,
} from "../src/core/schema";
import { RequestStore } from "../src/core/store";
import { ContextService } from "../src/context/selection";
import { resolveProject, type ResolvedProject } from "../src/security/project";

const temporaryPaths: string[] = [];

const runGit = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const makeFixture = async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chatgpt-consult-context-"));
  temporaryPaths.push(fixture);
  const root = join(fixture, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "src", "server.ts"),
    "export const timeout = 1000;\nexport const label = '😀';\n",
  );
  await writeFile(join(root, "src", "server.test.ts"), "test('server timeout', () => {});\n");
  await writeFile(join(root, "src", "unrelated.ts"), "export const unrelated = true;\n");
  await writeFile(join(root, "docs", "one.md"), "server timeout notes\n");
  await writeFile(join(root, "docs", "two.md"), "other notes\n");
  await writeFile(join(root, ".env"), "TOKEN=never-select-this\n");
  await writeFile(join(root, "secret.ts"), "const token = 'ghp_abcdefghijklmnopqrstuvwxyz';\n");
  await writeFile(join(root, "confirm.txt"), "password = example-value\n");
  await mkdir(join(root, ".worktrees", "other", "src"), { recursive: true });
  await writeFile(join(root, ".worktrees", "other", "src", "server.ts"), "export const timeout = 2000;\n");
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.local.json"), "{\"server\":\"timeout\"}\n");

  runGit(root, "init", "-q");
  runGit(root, "config", "user.email", "test@example.com");
  runGit(root, "config", "user.name", "Test User");
  runGit(root, "add", "src", "docs");
  runGit(root, "commit", "-qm", "fixture");
  await appendFile(join(root, "src", "server.ts"), "export const workingChange = true;\n");
  await appendFile(join(root, "src", "server.test.ts"), "// staged change\n");
  runGit(root, "add", "src/server.test.ts");

  const project = await resolveProject(root);
  const store = await RequestStore.init(project, {
    randomBytes: (size) => Buffer.alloc(size, 23),
  });
  const context = new ContextService(project, store);
  return { fixture, root, project, store, context };
};

const manifestPaths = (
  entries: Awaited<ReturnType<ContextService["build"]>>["entries"],
): ContextPath[] => entries.map(({
  path,
  bytes,
  sha256,
  mimeType,
  selectionReason,
  sensitivity,
}) => ({
  path,
  bytes,
  sha256,
  mimeType,
  selectionReason,
  sensitivity,
}));

const claimedRequest = async (
  project: ResolvedProject,
  store: RequestStore,
  entries: Awaited<ReturnType<ContextService["build"]>>["entries"],
  budget: ContextBudget,
  diff: Awaited<ReturnType<ContextService["captureDiff"]>> | null = null,
) => {
  const created = await store.create({
    projectName: "Fixture",
    goal: "Review server timeout handling",
    profile: "analysis",
    parentId: null,
    conversationUrl: null,
    idempotencyKey: `context-${crypto.randomUUID()}`,
    budget,
    contextManifest: {
      selectors: entries.map((entry) => entry.path),
      paths: manifestPaths(entries),
      smartSelection: false,
      exclusions: [],
    },
    diff: diff?.metadata ?? null,
    attachments: [],
    sensitivity: [],
    connectorAllowlist: [],
  });
  await store.claim(created.request.id, created.claimToken);
  expect(project.stateDir).toEndWith(".chatgpt-consult");
  return created;
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bounded context selection", () => {
  test("builds explicit files, directories, and globs in bytewise path order", async () => {
    const { context } = await makeFixture();

    const explicit = await context.build({
      goal: "Review server timeout handling",
      files: ["src/server.ts"],
      smart: false,
      allowSensitive: false,
    });
    expect(explicit.entries.map((entry) => entry.path)).toEqual(["src/server.ts"]);
    expect(explicit.entries[0]).toMatchObject({
      mimeType: "text/typescript",
      selectionReason: ["explicit:0"],
      sensitivity: { decision: "allowed", reasons: [] },
    });

    const expanded = await context.build({
      goal: "Review docs",
      files: ["docs", "src/*.test.ts"],
      smart: false,
      allowSensitive: false,
    });
    expect(expanded.entries.map((entry) => entry.path)).toEqual([
      "docs/one.md",
      "docs/two.md",
      "src/server.test.ts",
    ]);
  });

  test("selects smart context deterministically without denied paths", async () => {
    const { context } = await makeFixture();
    const input = {
      goal: "Review src/server.ts server timeout handling",
      files: [] as string[],
      smart: true,
      allowSensitive: false,
    };

    const first = await context.build(input);
    const second = await context.build(input);
    expect(first.entries.map((entry) => entry.path)).toContain("src/server.ts");
    expect(first.entries.map((entry) => entry.path)).not.toContain(".env");
    expect(first.entries.length).toBeLessThanOrEqual(25);
    expect(first.entries.map(({ path, selectionReason }) => ({ path, selectionReason })))
      .toEqual(second.entries.map(({ path, selectionReason }) => ({ path, selectionReason })));
    expect(first.entries.find((entry) => entry.path === "src/server.ts")?.selectionReason)
      .toEqual(expect.arrayContaining([
        "mentioned_path",
        "changed_path",
        "lexical_match:1",
      ]));
    expect(first.entries.map((entry) => entry.path)).toContain("src/server.test.ts");
  });

  test("smart discovery never reaches a hidden directory such as another worktree or local settings", async () => {
    const { context } = await makeFixture();

    const built = await context.build({
      goal: "Review src/server.ts server timeout handling",
      files: [] as string[],
      smart: true,
      allowSensitive: false,
    });

    const paths = built.entries.map((entry) => entry.path);
    expect(paths).toContain("src/server.ts");
    for (const hidden of [
      ".worktrees/other/src/server.ts",
      ".claude/settings.local.json",
    ]) expect(paths).not.toContain(hidden);
    expect(paths.some((path) => path.split("/").some((part) => part.startsWith(".")))).toBe(false);
  });

  test("an explicit selector still reaches a hidden path", async () => {
    const { context } = await makeFixture();

    const built = await context.build({
      goal: "Inspect the local settings file directly",
      files: [".claude/settings.local.json"],
      smart: false,
      allowSensitive: false,
    });

    expect(built.entries.map((entry) => entry.path)).toContain(".claude/settings.local.json");
  });

  test("keeps explicit selectors and uses smart selection only to backfill", async () => {
    const { context } = await makeFixture();
    const built = await context.build({
      goal: "Review server timeout handling",
      files: ["docs/two.md"],
      smart: true,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: 2 },
    });

    expect(built.selectors).toEqual(["docs/two.md"]);
    expect(built.entries).toHaveLength(2);
    expect(built.entries[0]).toMatchObject({
      path: "docs/two.md",
      selectionReason: ["explicit:0"],
    });
    expect(built.entries[1]?.path).not.toBe("docs/two.md");
    expect(built.entries[1]?.selectionReason.some((reason) => reason.startsWith("explicit:")))
      .toBeFalse();
  });

  test("skips smart discovery when explicit context exhausts the path budget", async () => {
    const { project, store } = await makeFixture();
    let discoveryCalls = 0;
    const context = new ContextService(project, store, {
      resolveExecutable: () => "/usr/bin/rg",
      runCommand: async () => {
        discoveryCalls += 1;
        throw new Error("smart discovery should not run");
      },
    });

    const built = await context.build({
      goal: "Review server timeout handling",
      files: ["docs/two.md"],
      smart: true,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: 1 },
    });

    expect(built.entries.map((entry) => entry.path)).toEqual(["docs/two.md"]);
    expect(discoveryCalls).toBe(0);
  });

  test("preserves distinct compact stem and lexical term contributions", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-smart-terms-"));
    temporaryPaths.push(root);
    await writeFile(join(root, "alpha-beta.ts"), "export const noop = 1;\n");
    await writeFile(join(root, "gamma.ts"), "delta epsilon\n");
    const project = await resolveProject(root);
    const store = await RequestStore.init(project);
    const context = new ContextService(project, store, {
      resolveExecutable: (name) => name === "rg" ? null : Bun.which(name),
    });

    const built = await context.build({
      goal: "alpha beta gamma delta epsilon",
      files: [],
      smart: true,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: 2 },
    });

    expect(built.entries.map(({ path, selectionReason }) => ({ path, selectionReason })))
      .toEqual([
        {
          path: "alpha-beta.ts",
          selectionReason: ["stem_match:0", "stem_match:1"],
        },
        {
          path: "gamma.ts",
          selectionReason: ["stem_match:4", "lexical_match:2", "lexical_match:3"],
        },
      ]);
  });

  test("normalizes and deduplicates explicit selectors before persistence metadata", async () => {
    const { context } = await makeFixture();
    const built = await context.build({
      goal: "Review the normalized server selector",
      files: ["src/../src/server.ts", "./src/server.ts"],
      smart: false,
      allowSensitive: false,
    });

    expect(built.selectors).toEqual(["src/server.ts"]);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({
      path: "src/server.ts",
      selectionReason: ["explicit:0"],
    });
    expect(JSON.stringify(built)).not.toContain("src/../src/server.ts");
  });

  test("enforces path ceilings and keeps secret values out of failures", async () => {
    const { context } = await makeFixture();
    await expect(context.build({
      goal: "Review docs",
      files: ["docs"],
      smart: false,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: 1 },
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    try {
      await context.build({
        goal: "Review secrets",
        files: ["secret.ts"],
        smart: false,
        allowSensitive: true,
      });
      throw new Error("expected secret selection to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "SENSITIVE_CONTENT" });
      expect(JSON.stringify(error)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    }

    await expect(context.build({
      goal: "Review configuration",
      files: ["confirm.txt"],
      smart: false,
      allowSensitive: false,
    })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT" });
    const confirmed = await context.build({
      goal: "Review configuration",
      files: ["confirm.txt"],
      smart: false,
      allowSensitive: true,
    });
    expect(confirmed.entries[0]?.sensitivity).toEqual({
      decision: "allowed",
      reasons: ["credential_assignment"],
    });
  });

  test("names every binary selection and directs the caller to attachments", async () => {
    const { root, context } = await makeFixture();
    await writeFile(join(root, "diagram.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, "report.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    await writeFile(join(root, "notes.ts"), "export const notes = 1;\n");

    await expect(context.build({
      goal: "Review the assets",
      files: ["diagram.png", "report.pdf", "notes.ts"],
      smart: false,
      allowSensitive: false,
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Binary project files must move from files to attachments: diagram.png, report.pdf",
    });
  });

  test("caps the reported binary selections and counts the rest", async () => {
    const { root, context } = await makeFixture();
    const names = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `${name}.png`);
    for (const name of names) await writeFile(join(root, name), Buffer.from([0x89, 0x50]));

    await expect(context.build({
      goal: "Review the assets",
      files: names,
      smart: false,
      allowSensitive: false,
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Binary project files must move from files to attachments: "
        + "a.png, b.png, c.png, d.png, e.png (+2 more)",
    });
  });

  test("rejects an explicit symlink that escapes the project", async () => {
    const { fixture, root, context } = await makeFixture();
    const outside = join(fixture, "outside.ts");
    await writeFile(outside, "export const outside = true;\n");
    await symlink(outside, join(root, "escape.ts"));

    await expect(context.build({
      goal: "Review escape",
      files: ["escape.ts"],
      smart: false,
      allowSensitive: false,
    })).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
  });

  test("rejects an intermediate directory symlink before walking it", async () => {
    const { fixture, root, context } = await makeFixture();
    const outside = join(fixture, "outside-directory");
    await mkdir(join(outside, "nested"), { recursive: true });
    await writeFile(join(outside, "nested", "outside.ts"), "export const outside = true;\n");
    await symlink(outside, join(root, "alias"));

    await expect(context.build({
      goal: "Review outside",
      files: ["alias/nested"],
      smart: false,
      allowSensitive: false,
    })).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
  });

  test("hashes and scans the bytes held by one no-follow context handle", async () => {
    const { root, project, store } = await makeFixture();
    const original = "export const stable = true;\n";
    await writeFile(join(root, "stable.ts"), original);
    let swapped = false;
    const context = new ContextService(project, store, {
      afterContextOpen: async (path) => {
        swapped = true;
        await rename(path, `${path}.original`);
        await writeFile(path, "const token = 'ghp_abcdefghijklmnopqrstuvwxyz';\n");
      },
    });

    const built = await context.build({
      goal: "Review stable",
      files: ["stable.ts"],
      smart: false,
      allowSensitive: false,
    });
    expect(swapped).toBe(true);
    expect(built.entries[0]?.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(built.entries[0]?.sensitivity).toEqual({ decision: "allowed", reasons: [] });
  });

  test("reports directory overflow before inspecting later files", async () => {
    const { root, context } = await makeFixture();
    await mkdir(join(root, "many"));
    await writeFile(join(root, "many", "a.ts"), "export const a = true;\n");
    await writeFile(join(root, "many", "b.ts"), "export const b = true;\n");
    await writeFile(
      join(root, "many", "z-secret.ts"),
      "const token = 'ghp_abcdefghijklmnopqrstuvwxyz';\n",
    );

    await expect(context.build({
      goal: "Review many",
      files: ["many"],
      smart: false,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: 1 },
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("backfills lower-ranked safe smart candidates", async () => {
    const { root, context } = await makeFixture();
    await writeFile(
      join(root, "aaa-secret.ts"),
      "const token = 'ghp_abcdefghijklmnopqrstuvwxyz';\n",
    );
    await writeFile(join(root, "aaa.bin"), Buffer.from([0xff, 0xfe, 0xfd]));

    const built = await context.build({
      goal: "Review aaa-secret.ts aaa.bin src/server.ts",
      files: [],
      smart: true,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: 1 },
    });
    expect(built.entries.map((entry) => entry.path)).toEqual(["src/server.ts"]);
  });

  test("rejects public budgets above hard ceilings", async () => {
    const { context } = await makeFixture();
    await expect(context.build({
      goal: "Review server",
      files: ["src/server.ts"],
      smart: false,
      allowSensitive: false,
      budget: { ...DEFAULT_BUDGET, maxPaths: HARD_BUDGET.maxPaths + 1 },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(context.captureDiff({
      kind: "working",
      maxBytes: HARD_BUDGET.maxServedTextBytes + 1,
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("scopes smart Git discovery to a nested project", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "chatgpt-consult-nested-git-"));
    temporaryPaths.push(fixture);
    const repository = join(fixture, "repository");
    const root = join(repository, "project");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "local.ts"), "export const local = true;\n");
    await writeFile(join(repository, "sibling.ts"), "export const sibling = true;\n");
    runGit(repository, "init", "-q");
    runGit(repository, "config", "user.email", "test@example.com");
    runGit(repository, "config", "user.name", "Test User");
    runGit(repository, "add", ".");
    runGit(repository, "commit", "-qm", "fixture");
    runGit(repository, "config", "status.relativePaths", "false");
    await appendFile(join(repository, "sibling.ts"), "export const changed = true;\n");
    const project = await resolveProject(root);
    const store = await RequestStore.init(project);
    const context = new ContextService(project, store);

    const built = await context.build({
      goal: "Review pending changes",
      files: [],
      smart: true,
      allowSensitive: false,
    });
    expect(built.entries).toEqual([]);

    await appendFile(join(root, "src", "local.ts"), "export const changed = true;\n");
    const local = await context.build({
      goal: "Review pending changes",
      files: [],
      smart: true,
      allowSensitive: false,
    });
    expect(local.entries.map((entry) => entry.path)).toEqual(["src/local.ts"]);
  });

  test("neutralizes a hostile Git fsmonitor", async () => {
    const { fixture, root, context } = await makeFixture();
    const sentinel = join(fixture, "fsmonitor-ran");
    const hook = join(fixture, "hostile-fsmonitor.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${sentinel}'\nexit 0\n`);
    await chmod(hook, 0o755);
    runGit(root, "config", "core.fsmonitor", hook);

    await context.build({
      goal: "Review server timeout",
      files: [],
      smart: true,
      allowSensitive: false,
    });
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not read oversized candidates in the no-rg lexical fallback", async () => {
    const { root, project, store } = await makeFixture();
    const oversized = join(root, "oversized.md");
    await writeFile(oversized, "");
    await truncate(oversized, 1_048_577);
    await writeFile(join(root, "bounded.md"), "uniquelexicalneedle\n");
    const lexicalReads: string[] = [];
    const context = new ContextService(project, store, {
      resolveExecutable: (name: string) => name === "rg" ? null : Bun.which(name),
      beforeLexicalRead: async (path: string) => {
        lexicalReads.push(path);
      },
    });

    const built = await context.build({
      goal: "Find uniquelexicalneedle",
      files: [],
      smart: true,
      allowSensitive: false,
    });

    expect(lexicalReads).toContain(join(project.root, "bounded.md"));
    expect(lexicalReads).not.toContain(join(project.root, "oversized.md"));
    expect(built.entries.find((entry) => entry.path === "bounded.md")?.selectionReason)
      .toContain("lexical_match:1");
  });

  test("passes only bounded policy-approved candidates to injected rg", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "chatgpt-consult-rg-candidates-"));
    temporaryPaths.push(fixture);
    const root = join(fixture, "project");
    await mkdir(join(root, "a"), { recursive: true });
    const oversized = join(root, "a", "0000-oversized.ts");
    await writeFile(oversized, "");
    await truncate(oversized, 1_048_577);
    for (let start = 0; start < 2_001; start += 100) {
      await Promise.all(Array.from(
        { length: Math.min(100, 2_001 - start) },
        (_, offset) => writeFile(
          join(root, "a", `${String(start + offset).padStart(4, "0")}.ts`),
          "uniquelexicalneedle\n",
        ),
      ));
    }
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "node_modules", "inside.ts"), "uniquelexicalneedle\n");
    await writeFile(join(root, "dist", "inside.ts"), "uniquelexicalneedle\n");
    for (const name of ["credentials", "CREDENTIALS", "id_rsa", "ID_RSA", "secret.PEM", "secret.key"]) {
      await writeFile(join(root, name), "uniquelexicalneedle\n");
    }

    const project = await resolveProject(root);
    const store = await RequestStore.init(project);
    const invocations: string[][] = [];
    const context = new ContextService(project, store, {
      resolveExecutable: (name: string) => name === "rg" ? "/fake/rg" : Bun.which(name),
      runCommand: async (argv: string[]) => {
        invocations.push(argv);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1, truncated: false };
      },
    });

    await context.build({
      goal: "Find uniquelexicalneedle",
      files: [],
      smart: true,
      allowSensitive: false,
    });

    expect(invocations.length).toBeGreaterThan(0);
    const candidateArguments = new Set(invocations.flatMap((argv) => {
      const separator = argv.indexOf("--");
      return argv.slice(separator + 2);
    }));
    expect(candidateArguments.size).toBe(1_999);
    expect(candidateArguments.has("a/0000.ts")).toBe(true);
    expect(candidateArguments.has("a/1998.ts")).toBe(true);
    expect(candidateArguments.has("a/0000-oversized.ts")).toBe(false);
    expect(candidateArguments.has("a/1999.ts")).toBe(false);
    expect(candidateArguments.has("a/2000.ts")).toBe(false);
    expect([...candidateArguments]).not.toEqual(expect.arrayContaining([
      "credentials",
      "CREDENTIALS",
      "id_rsa",
      "ID_RSA",
      "secret.PEM",
      "secret.key",
      "node_modules/inside.ts",
      "dist/inside.ts",
    ]));
  });
});

describe("bounded reads and search", () => {
  test("returns UTF-8-safe chunks with continuation and atomically enforces served bytes", async () => {
    const { project, store, context } = await makeFixture();
    const built = await context.build({
      goal: "Review server",
      files: ["src/server.ts"],
      smart: false,
      allowSensitive: false,
    });
    const budget = { ...DEFAULT_BUDGET, maxReadBytes: 8, maxServedTextBytes: 9 };
    const created = await claimedRequest(project, store, built.entries, budget);

    const first = await context.read({
      requestId: created.request.id,
      claimToken: created.claimToken,
      path: "src/server.ts",
      offset: 0,
      limit: 5,
    });
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(5);
    expect(first.nextOffset).toBeGreaterThan(first.offset);
    expect(first.eof).toBe(false);
    expect(first.sha256).toBe(built.entries[0]!.sha256);

    const outcomes = await Promise.allSettled([
      context.read({
        requestId: created.request.id,
        claimToken: created.claimToken,
        path: "src/server.ts",
        offset: first.nextOffset,
        limit: 4,
      }),
      context.read({
        requestId: created.request.id,
        claimToken: created.claimToken,
        path: "src/server.ts",
        offset: first.nextOffset,
        limit: 4,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(
      (outcome) => outcome.status === "rejected" && outcome.reason.code === "BUDGET_EXCEEDED",
    )).toHaveLength(1);
  });

  test("searches approved text only with capped hits and snippets", async () => {
    const { root, project, store, context } = await makeFixture();
    await writeFile(
      join(root, "src", "matches.txt"),
      Array.from({ length: 4 }, (_, index) => `needle ${index} ${"x".repeat(300)}`).join("\n"),
    );
    const built = await context.build({
      goal: "Find needle",
      files: ["src/matches.txt"],
      smart: false,
      allowSensitive: false,
    });
    const budget = { ...DEFAULT_BUDGET, maxSearchHits: 2 };
    const created = await claimedRequest(project, store, built.entries, budget);

    const hits = await context.search({
      requestId: created.request.id,
      claimToken: created.claimToken,
      query: "needle",
    });
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.line)).toEqual([1, 2]);
    expect(hits.every((hit) => hit.snippet.length <= 240)).toBe(true);
    expect(await context.search({
      requestId: created.request.id,
      claimToken: created.claimToken,
      query: "needle",
    })).toEqual([]);
    await expect(context.search({
      requestId: created.request.id,
      claimToken: created.claimToken,
      query: "unapproved secret",
      paths: [".env"],
    })).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
  });

  test("charges UTF-8 snippet bytes and hits as one reservation", async () => {
    const { root, project, store, context } = await makeFixture();
    await writeFile(join(root, "src", "unicode.txt"), "needle 😀\n");
    const built = await context.build({
      goal: "Find needle",
      files: ["src/unicode.txt"],
      smart: false,
      allowSensitive: false,
    });
    const created = await claimedRequest(
      project,
      store,
      built.entries,
      { ...DEFAULT_BUDGET, maxServedTextBytes: 11, maxSearchHits: 1 },
    );

    expect(await context.search({
      requestId: created.request.id,
      claimToken: created.claimToken,
      query: "needle",
    })).toEqual([{ path: "src/unicode.txt", line: 1, snippet: "needle 😀" }]);
    expect(await store.get(created.request.id)).toMatchObject({
      servedTextBytes: 11,
      servedSearchHits: 1,
    });
  });

  test("returns no search hit when its snippet cannot fit the text budget", async () => {
    const { root, project, store, context } = await makeFixture();
    await writeFile(join(root, "src", "unicode.txt"), "needle 😀\n");
    const built = await context.build({
      goal: "Find needle",
      files: ["src/unicode.txt"],
      smart: false,
      allowSensitive: false,
    });
    const created = await claimedRequest(
      project,
      store,
      built.entries,
      { ...DEFAULT_BUDGET, maxServedTextBytes: 10, maxSearchHits: 1 },
    );

    expect(await context.search({
      requestId: created.request.id,
      claimToken: created.claimToken,
      query: "needle",
    })).toEqual([]);
    expect(await store.get(created.request.id)).toMatchObject({
      servedTextBytes: 0,
      servedSearchHits: 0,
    });
  });

  test("concurrent searches cannot partially charge either budget", async () => {
    const { root, project, store, context } = await makeFixture();
    await writeFile(join(root, "src", "concurrent.txt"), "needle\nneedle\nneedle\n");
    const built = await context.build({
      goal: "Find needle",
      files: ["src/concurrent.txt"],
      smart: false,
      allowSensitive: false,
    });
    const created = await claimedRequest(
      project,
      store,
      built.entries,
      { ...DEFAULT_BUDGET, maxServedTextBytes: 12, maxSearchHits: 2 },
    );

    const outcomes = await Promise.all([
      context.search({
        requestId: created.request.id,
        claimToken: created.claimToken,
        query: "needle",
      }),
      context.search({
        requestId: created.request.id,
        claimToken: created.claimToken,
        query: "needle",
      }),
    ]);
    expect(outcomes.flat()).toHaveLength(2);
    expect(await store.get(created.request.id)).toMatchObject({
      servedTextBytes: 12,
      servedSearchHits: 2,
    });
  });

  test("rejects an approved file above the hard text resource ceiling", async () => {
    const { root, store, context } = await makeFixture();
    const content = Buffer.alloc(HARD_BUDGET.maxServedTextBytes + 1, 97);
    await writeFile(join(root, "src", "oversized.txt"), content);
    const created = await store.create({
      projectName: "Fixture",
      goal: "Review oversized",
      profile: "analysis",
      parentId: null,
      conversationUrl: null,
      idempotencyKey: `oversized-${crypto.randomUUID()}`,
      budget: DEFAULT_BUDGET,
      contextManifest: {
        selectors: ["src/oversized.txt"],
        paths: [{
          path: "src/oversized.txt",
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          mimeType: "text/plain",
          selectionReason: ["explicit:0"],
          sensitivity: { decision: "allowed", reasons: [] },
        }],
        smartSelection: false,
        exclusions: [],
      },
      diff: null,
      attachments: [],
      sensitivity: [],
      connectorAllowlist: [],
    });
    await store.claim(created.request.id, created.claimToken);

    await expect(context.read({
      requestId: created.request.id,
      claimToken: created.claimToken,
      path: "src/oversized.txt",
      limit: 64,
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(context.search({
      requestId: created.request.id,
      claimToken: created.claimToken,
      query: "aaa",
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("bounded Git diffs", () => {
  test("rejects tracked denied paths before persisting a diff blob", async () => {
    const { root, project, context } = await makeFixture();
    runGit(root, "add", "-f", ".env");
    runGit(root, "commit", "-qm", "track denied fixture");
    await appendFile(join(root, ".env"), "PASSWORD=still-private\n");

    await expect(context.captureDiff({ kind: "working", maxBytes: 16_384 }))
      .rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect(await readdir(join(project.stateDir, "attachments"))).toEqual([]);
  });

  test("rejects staged provider tokens before persisting a diff blob", async () => {
    const { root, project, context } = await makeFixture();
    await appendFile(
      join(root, "src", "server.ts"),
      "export const leaked = 'ghp_abcdefghijklmnopqrstuvwxyz';\n",
    );
    runGit(root, "add", "src/server.ts");

    await expect(context.captureDiff({ kind: "working", maxBytes: 16_384 }))
      .rejects.toMatchObject({ code: "SENSITIVE_CONTENT" });
    expect(await readdir(join(project.stateDir, "attachments"))).toEqual([]);
  });

  test("requires confirmation for working-tree credential assignments", async () => {
    const { root, project, context } = await makeFixture();
    await appendFile(join(root, "docs", "two.md"), "password = still-private\n");

    await expect(context.captureDiff({ kind: "working", maxBytes: 16_384 }))
      .rejects.toMatchObject({ code: "SENSITIVE_CONTENT" });
    expect(await readdir(join(project.stateDir, "attachments"))).toEqual([]);

    await expect(context.captureDiff({
      kind: "working",
      maxBytes: 16_384,
      allowSensitive: true,
    })).resolves.toMatchObject({ metadata: { truncated: false } });
  });

  test("requires confirmation for staged credential assignments", async () => {
    const { root, project, context } = await makeFixture();
    await appendFile(join(root, "docs", "one.md"), "token: still-private\n");
    runGit(root, "add", "docs/one.md");

    await expect(context.captureDiff({ kind: "working", maxBytes: 16_384 }))
      .rejects.toMatchObject({ code: "SENSITIVE_CONTENT" });
    expect(await readdir(join(project.stateDir, "attachments"))).toEqual([]);

    await expect(context.captureDiff({
      kind: "working",
      maxBytes: 16_384,
      allowSensitive: true,
    })).resolves.toMatchObject({ metadata: { truncated: false } });
  });

  test("stores and reads labelled working and staged diffs", async () => {
    const { project, store, context } = await makeFixture();
    const captured = await context.captureDiff({ kind: "working", maxBytes: 16_384 });
    expect(captured.metadata).toMatchObject({
      baseRef: "HEAD",
      headRef: "WORKTREE",
      truncated: false,
    });
    const created = await claimedRequest(project, store, [], DEFAULT_BUDGET, captured);

    const result = await context.readDiff({
      requestId: created.request.id,
      claimToken: created.claimToken,
      offset: 0,
      limit: DEFAULT_BUDGET.maxReadBytes,
    });
    expect(result.text).toContain("=== WORKING TREE ===");
    expect(result.text).toContain("workingChange");
    expect(result.text).toContain("=== STAGED ===");
    expect(result.text).toContain("staged change");
  });

  test("caps a large diff without dropping either section label", async () => {
    const { root, project, store, context } = await makeFixture();
    await appendFile(join(root, "src", "server.ts"), `// ${"w".repeat(2_000)}\n`);
    await appendFile(join(root, "src", "server.test.ts"), `// ${"s".repeat(2_000)}\n`);
    runGit(root, "add", "src/server.test.ts");

    const captured = await context.captureDiff({ kind: "working", maxBytes: 128 });
    expect(captured.metadata.bytes).toBeLessThanOrEqual(128);
    expect(captured.metadata.truncated).toBe(true);
    expect(captured.truncated).toBe(true);
    const created = await claimedRequest(project, store, [], DEFAULT_BUDGET, captured);
    const result = await context.readDiff({
      requestId: created.request.id,
      claimToken: created.claimToken,
      limit: 128,
    });
    expect(result.text).toContain("=== WORKING TREE ===");
    expect(result.text).toContain("=== STAGED ===");
  });

  test("rejects diff capture outside a Git work tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-nongit-"));
    temporaryPaths.push(root);
    const project = await resolveProject(root);
    const store = await RequestStore.init(project);
    const context = new ContextService(project, store);

    await expect(context.captureDiff({ kind: "working", maxBytes: 1_024 }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
