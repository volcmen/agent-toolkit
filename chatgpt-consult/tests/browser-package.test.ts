import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { prepareBrowserPackage, cleanupBrowserPackage } from "../src/browser/package";
import { ContextService } from "../src/context/selection";
import { ConsultationService } from "../src/core/service";
import { type ConsultationRequest } from "../src/core/schema";
import { RequestStore } from "../src/core/store";
import { resolveProject } from "../src/security/project";

const temporaryPaths: string[] = [];
const fixedTime = new Date("2026-08-31T12:00:00.000Z");

const runGit = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const fixtureMime = async (path: string): Promise<string> => {
  const content = await readFile(path);
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
  return "text/plain";
};

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-browser-package-"));
  temporaryPaths.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "review.ts"), "export const retry = true;\n");
  await writeFile(join(root, "review.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(join(root, "report.pdf"), Buffer.from("%PDF-1.4\nreview\n"));
  runGit(root, "init", "-q");
  runGit(root, "config", "user.email", "test@example.com");
  runGit(root, "config", "user.name", "Test User");
  runGit(root, "add", "src/review.ts");
  runGit(root, "commit", "-qm", "fixture");
  await appendFile(join(root, "src", "review.ts"), "export const jitter = 10;\n");
  const project = await resolveProject(root);
  const store = await RequestStore.init(project, {
    now: () => fixedTime,
    randomBytes: (size) => Buffer.alloc(size, 44),
  });
  const context = new ContextService(project, store, { detectMime: fixtureMime });
  const service = new ConsultationService(project, store, context, { now: () => fixedTime });
  const started = await service.start({
    goal: "Review retry packaging",
    profile: "analysis",
    files: ["src/review.ts"],
    smart: false,
    attachments: ["review.png", "report.pdf"],
    diff: "working",
    open: false,
    idempotencyKey: "browser-package",
  });
  return { root, project, store, request: await store.get(started.requestId) };
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("browser request packages", () => {
  test("stages immutable attachments in a private bounded package", async () => {
    const { root, project, store, request } = await makeFixture();
    const value = await prepareBrowserPackage(project, store, request);

    expect(value.requestId).toBe(request.id);
    expect(value.expectedRevision).toBe(request.revision);
    expect(Buffer.byteLength(value.prompt, "utf8")).toBeLessThanOrEqual(65_536);
    expect(value.uploadPaths.map((path) => basename(path))).toEqual(["001-review.png", "002-report.pdf"]);
    expect(value.uploadPaths).toHaveLength(2);
    expect(relative(value.directory, value.uploadPaths[0]!)).not.toMatch(/^\.\./);
    expect(await readFile(value.uploadPaths[0]!)).toEqual(
      await readFile(join(project.stateDir, "attachments", request.attachments[0]!.sha256)),
    );
    expect(await readFile(value.uploadPaths[1]!)).toEqual(
      await readFile(join(project.stateDir, "attachments", request.attachments[1]!.sha256)),
    );
    expect((await lstat(value.directory)).mode & 0o777).toBe(0o700);
    await Promise.all(value.uploadPaths.map(async (path) => {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }));

    await cleanupBrowserPackage(value);
    expect(await Bun.file(value.directory).exists()).toBe(false);
    expect(await Bun.file(join(root, ".chatgpt-consult", "attachments", request.attachments[0]!.sha256)).exists())
      .toBe(true);
  });

  test("refuses a symlinked staging ancestor", async () => {
    const { root, project, store, request } = await makeFixture();
    const outside = await mkdtemp(join(tmpdir(), "chatgpt-consult-browser-outside-"));
    temporaryPaths.push(outside);
    await symlink(outside, join(project.stateDir, "browser"));

    await expect(prepareBrowserPackage(project, store, request)).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect(await Bun.file(join(outside, request.id, "uploads")).exists()).toBe(false);
    expect(await Bun.file(join(root, ".chatgpt-consult", "attachments", request.attachments[0]!.sha256)).exists())
      .toBe(true);
  });

  test("refuses a changed immutable source blob", async () => {
    const { project, store, request } = await makeFixture();
    await writeFile(join(project.stateDir, "attachments", request.attachments[0]!.sha256), "changed");

    await expect(prepareBrowserPackage(project, store, request)).rejects.toMatchObject({ code: "CORRUPT_STATE" });
  });

  test("rejects duplicate unsafe attachment names before staging", async () => {
    const { project, store, request } = await makeFixture();
    const unsafe: ConsultationRequest = {
      ...request,
      attachments: request.attachments.map((attachment) => ({ ...attachment, name: "../review.png" })),
    };

    await expect(prepareBrowserPackage(project, store, unsafe)).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
  });

  test("refuses attachment totals above the request budget", async () => {
    const { project, store, request } = await makeFixture();
    const overBudget: ConsultationRequest = {
      ...request,
      budget: { ...request.budget, maxAttachmentTotalBytes: 8 },
    };

    await expect(prepareBrowserPackage(project, store, overBudget)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("refuses an immutable attachment above the request per-file budget", async () => {
    const { project, store, request } = await makeFixture();
    const overBudget: ConsultationRequest = {
      ...request,
      budget: { ...request.budget, maxAttachmentBytes: 7 },
    };

    await expect(prepareBrowserPackage(project, store, overBudget)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("refuses to clean a caller-forged staging package", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-forged-package-"));
    temporaryPaths.push(root);
    const requestId = "c".repeat(32);
    const directory = join(root, ".chatgpt-consult", "browser", requestId, "uploads");
    await mkdir(directory, { recursive: true, mode: 0o700 });

    await expect(cleanupBrowserPackage({
      requestId,
      expectedRevision: 0,
      prompt: "",
      uploadPaths: [],
      directory,
    })).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });

  test("refuses a mutated prepared package without deleting another request directory", async () => {
    const { project, store, request } = await makeFixture();
    const value = await prepareBrowserPackage(project, store, request);
    const otherId = "d".repeat(32);
    const otherDirectory = join(project.stateDir, "browser", otherId, "uploads");
    await mkdir(otherDirectory, { recursive: true, mode: 0o700 });
    value.requestId = otherId;
    value.directory = otherDirectory;

    await expect(cleanupBrowserPackage(value)).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect((await lstat(otherDirectory)).isDirectory()).toBe(true);
  });

  test("reclaims a stale exact-request package after a simulated process restart", async () => {
    const { project, store, request } = await makeFixture();
    const first = await prepareBrowserPackage(project, store, request);
    const reloaded = await import(`../src/browser/package?restart=${crypto.randomUUID()}`);

    const recovered = await reloaded.prepareBrowserPackage(project, store, request);
    expect(recovered.directory).toBe(first.directory);
    await reloaded.cleanupBrowserPackage(recovered);
  });

  test("fails closed when immutable storage replaces stale quarantined uploads during restart recovery", async () => {
    const { project, store, request } = await makeFixture();
    const stale = await prepareBrowserPackage(project, store, request);
    const reloaded = await import(`../src/browser/package?restart-swap=${crypto.randomUUID()}`);
    const attachments = join(project.stateDir, "attachments");
    const sentinelName = request.attachments[0]!.sha256;
    const before = await readFile(join(attachments, sentinelName));

    await expect(reloaded.prepareBrowserPackage(project, store, request, {
      hooks: {
        beforeRecursiveCleanup: async (quarantine: string) => {
          const uploads = join(quarantine, "uploads");
          await rename(uploads, `${uploads}.original`);
          await rename(attachments, uploads);
        },
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });

    const browser = join(project.stateDir, "browser");
    const entries = await (await import("node:fs/promises")).readdir(browser);
    const quarantine = entries.find((entry) => entry.startsWith(`.cleanup-${request.id}-`));
    expect(quarantine).toBeDefined();
    const replacement = join(browser, quarantine!, "uploads");
    expect((await lstat(replacement)).isDirectory()).toBe(true);
    expect(await readFile(join(replacement, sentinelName))).toEqual(before);
    expect(stale.directory).toBe(join(project.stateDir, "browser", request.id, "uploads"));
  });

  test("fails closed when a staging ancestor is swapped before a file mutation", async () => {
    const { project, store, request } = await makeFixture();
    const browser = join(project.stateDir, "browser");

    await expect(prepareBrowserPackage(project, store, request, {
      hooks: {
        beforeFileCreate: async () => {
          await rename(browser, `${browser}.original`);
          await mkdir(browser, { mode: 0o700 });
        },
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect((await lstat(browser)).isDirectory()).toBe(true);
    await expect(lstat(join(browser, request.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed when a cleanup ancestor is swapped before quarantine", async () => {
    const { project, store, request } = await makeFixture();
    const browser = join(project.stateDir, "browser");
    const value = await prepareBrowserPackage(project, store, request, {
      hooks: {
        beforeQuarantine: async () => {
          await rename(browser, `${browser}.original`);
          await mkdir(browser, { mode: 0o700 });
        },
      },
    });

    await expect(cleanupBrowserPackage(value)).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect((await lstat(browser)).isDirectory()).toBe(true);
    await expect(lstat(join(browser, request.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed when immutable attachment storage replaces the uploads directory", async () => {
    const { project, store, request } = await makeFixture();
    const value = await prepareBrowserPackage(project, store, request);
    const attachments = join(project.stateDir, "attachments");
    const sentinel = join(attachments, request.attachments[0]!.sha256);
    const before = await readFile(sentinel);
    await rename(value.directory, `${value.directory}.original`);
    await rename(attachments, value.directory);

    await expect(cleanupBrowserPackage(value)).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    expect(await readFile(join(value.directory, request.attachments[0]!.sha256))).toEqual(before);
    expect((await lstat(value.directory)).isDirectory()).toBe(true);
  });

  test("fails closed when immutable storage replaces quarantined uploads before removal", async () => {
    const { project, store, request } = await makeFixture();
    const attachments = join(project.stateDir, "attachments");
    const sentinel = join(attachments, request.attachments[0]!.sha256);
    const before = await readFile(sentinel);
    const value = await prepareBrowserPackage(project, store, request, {
      hooks: {
        beforeRecursiveCleanup: async (quarantine) => {
          const uploads = join(quarantine, "uploads");
          await rename(uploads, `${uploads}.original`);
          await rename(attachments, uploads);
        },
      },
    });

    await expect(cleanupBrowserPackage(value)).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
    const browser = join(project.stateDir, "browser");
    const entries = await (await import("node:fs/promises")).readdir(browser);
    const quarantine = entries.find((entry) => entry.startsWith(`.cleanup-${request.id}-`));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(browser, quarantine!, "uploads", request.attachments[0]!.sha256))).toEqual(before);
  });

  test("stages sequentially and cleans only after the failed write settles", async () => {
    const { project, store, request } = await makeFixture();
    const calls: number[] = [];

    await expect(prepareBrowserPackage(project, store, request, {
      hooks: {
        beforeFileCreate: async (_directory, index) => {
          calls.push(index);
          if (index === 1) throw new Error("second attachment refused");
        },
      },
    })).rejects.toThrow("second attachment refused");
    expect(calls).toEqual([0, 1]);
    await expect(lstat(join(project.stateDir, "browser", request.id))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
