import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { classifyPath } from "../src/security/policy";
import { resolveProject, resolveReadablePath } from "../src/security/project";
import { scanSecrets } from "../src/security/secrets";

const temporaryPaths: string[] = [];

const makeFixture = async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chatgpt-consult-security-"));
  temporaryPaths.push(fixture);

  const root = join(fixture, "project");
  const outside = join(fixture, "outside.txt");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const app = true;\n");
  await writeFile(join(root, ".env"), "SECRET=not-for-context\n");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(root, "link"));

  return { root };
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("project security boundary", () => {
  test("confines readable paths to regular files inside the real project root", async () => {
    const { root } = await makeFixture();
    const project = await resolveProject(root);
    const canonicalRoot = await realpath(root);

    expect(project.root).toBe(canonicalRoot);
    expect(project.stateDir).toBe(join(canonicalRoot, ".chatgpt-consult"));
    expect(project.projectId).toBe(
      createHash("sha256").update(`${canonicalRoot}\0${basename(canonicalRoot)}`).digest("hex").slice(0, 24),
    );
    expect((await resolveReadablePath(project, "src/app.ts")).relative).toBe("src/app.ts");
    await expect(resolveReadablePath(project, "../outside.txt")).rejects.toMatchObject({
      code: "FORBIDDEN_PATH",
    });
    await expect(resolveReadablePath(project, "link")).rejects.toMatchObject({
      code: "FORBIDDEN_PATH",
    });
  });

  test("allows an ordinary source directory named browser while still denying profile trees", () => {
    expect(classifyPath("src/browser/turn-watch.ts").kind).toBe("allow");
    expect(classifyPath("lib/browser/index.ts").kind).toBe("allow");
    for (const denied of [
      "browser-profile/Default/Cookies",
      "chrome-profile/Default/Login Data",
      "firefox-profile/prefs.js",
      ".chatgpt-consult/browser/abc/state.json",
    ]) expect(classifyPath(denied).kind).toBe("deny");
  });

  test("names the rule that rejected a context path", async () => {
    const { root } = await makeFixture();
    const project = await resolveProject(root);

    await expect(resolveReadablePath(project, "node_modules/pkg/index.js")).rejects.toMatchObject({
      code: "FORBIDDEN_PATH",
      message: expect.stringContaining("node_modules"),
    });
  });

  test("denies excluded context paths and identifies secret severity without exposing values", () => {
    expect(classifyPath(".env.local").kind).toBe("deny");
    expect(classifyPath("node_modules/pkg/index.js").kind).toBe("deny");
    expect(scanSecrets("-----BEGIN PRIVATE KEY-----").decision).toBe("block");
    expect(scanSecrets("password = example-value").decision).toBe("confirm");
    expect(scanSecrets("password = example-value").findings[0]).not.toMatchObject({
      preview: expect.stringContaining("example-value"),
    });
  });

  test("blocks a later private key after collecting the maximum confirmation findings", () => {
    const confirmationLines = Array.from(
      { length: 20 },
      (_, index) => `password = example-value-${index + 1}`,
    );

    const scan = scanSecrets([...confirmationLines, "-----BEGIN PRIVATE KEY-----"].join("\n"));

    expect(scan.findings).toHaveLength(20);
    expect(scan.decision).toBe("block");
  });

  test("rejects a permitted-named symlink whose canonical target is excluded", async () => {
    const { root } = await makeFixture();
    const project = await resolveProject(root);
    await symlink(join(root, ".env"), join(root, "safe-link"));

    await expect(resolveReadablePath(project, "safe-link")).rejects.toMatchObject({
      code: "FORBIDDEN_PATH",
    });
  });

  test("rejects a non-regular context path", async () => {
    const { root } = await makeFixture();
    const project = await resolveProject(root);

    await expect(resolveReadablePath(project, "src")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("bounds the public readable-path helper", async () => {
    const { root } = await makeFixture();
    const project = await resolveProject(root);
    const oversized = join(root, "src", "oversized.ts");
    await writeFile(oversized, "");
    await truncate(oversized, 8_388_609);

    await expect(resolveReadablePath(project, "src/oversized.ts")).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });
});
