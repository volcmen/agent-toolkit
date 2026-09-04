import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET, HARD_BUDGET } from "../src/core/schema";
import { RequestStore } from "../src/core/store";
import { ContextService } from "../src/context/selection";
import { resolveProject } from "../src/security/project";

const temporaryPaths: string[] = [];
const detectFixtureMime = async (path: string): Promise<string> => {
  const content = await readFile(path);
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  const text = content.toString("utf8");
  if (text.startsWith("<html")) return "text/html";
  if (text.startsWith("<svg")) return "image/svg+xml";
  return "text/plain";
};

const makeFixture = async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chatgpt-consult-attachments-"));
  temporaryPaths.push(fixture);
  const root = join(fixture, "project");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(join(root, "copy.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(join(root, "page.html"), "<html><script>alert(1)</script></html>");
  await writeFile(join(root, "vector.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  await writeFile(join(root, "one.txt"), "123456");
  await writeFile(join(root, "two.txt"), "abcdef");
  await writeFile(join(root, "blocked.txt"), "token = ghp_abcdefghijklmnopqrstuvwxyz\n");
  await writeFile(join(root, "confirm.txt"), "password = example-value\n");
  const project = await resolveProject(root);
  const store = await RequestStore.init(project, {
    randomBytes: (size) => Buffer.alloc(size, 31),
  });
  const context = new ContextService(project, store, {
    detectMime: detectFixtureMime,
  });
  return { fixture, root, project, store, context };
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("immutable attachments", () => {
  test("stores an allowed PNG privately and deduplicates it by SHA-256", async () => {
    const { project, store, context } = await makeFixture();
    const descriptors = await context.storeAttachments({
      paths: ["image.png", "copy.png"],
      budget: DEFAULT_BUDGET,
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: descriptors[0]?.sha256,
      name: "image.png",
      bytes: 8,
      mimeType: "image/png",
      sensitivity: { decision: "allowed", reasons: [] },
    });
    const storedPath = join(project.stateDir, "attachments", descriptors[0]!.sha256);
    expect(await readFile(storedPath)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect((await lstat(storedPath)).mode & 0o777).toBe(0o600);

    const created = await store.create({
      projectName: "Fixture",
      goal: "Inspect image",
      profile: "analysis",
      parentId: null,
      conversationUrl: null,
      idempotencyKey: `attachment-${crypto.randomUUID()}`,
      budget: DEFAULT_BUDGET,
      contextManifest: { selectors: [], paths: [], smartSelection: false, exclusions: [] },
      diff: null,
      attachments: descriptors,
      sensitivity: [],
      connectorAllowlist: [],
    });
    await store.claim(created.request.id, created.claimToken);
    const attachment = await context.readAttachment({
      requestId: created.request.id,
      claimToken: created.claimToken,
      id: descriptors[0]!.id,
    });
    expect(attachment).toMatchObject({ mimeType: "image/png", bytes: 8 });
    expect(attachment.data).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await expect(context.readAttachment({
      requestId: created.request.id,
      claimToken: created.claimToken,
      id: "0".repeat(64),
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("denies active HTML and SVG attachments", async () => {
    const { context } = await makeFixture();
    for (const path of ["page.html", "vector.svg"]) {
      await expect(context.storeAttachments({ paths: [path], budget: DEFAULT_BUDGET }))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  test("rejects a safe MIME type with a mismatched extension", async () => {
    const { project, store } = await makeFixture();
    const context = new ContextService(project, store, {
      detectMime: async () => "image/png",
    });

    await expect(context.storeAttachments({ paths: ["one.txt"], budget: DEFAULT_BUDGET }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("copies and classifies the already-open source after a pathname swap", async () => {
    const { fixture, root, project, store } = await makeFixture();
    const outside = join(fixture, "outside.png");
    await writeFile(outside, "<html>outside</html>");
    let swapped = false;
    const context = new ContextService(project, store, {
      detectMime: detectFixtureMime,
      afterAttachmentOpen: async (path) => {
        swapped = true;
        await rename(path, `${path}.original`);
        await symlink(outside, path);
      },
    });

    const [descriptor] = await context.storeAttachments({
      paths: ["image.png"],
      budget: DEFAULT_BUDGET,
    });
    expect(swapped).toBe(true);
    expect(descriptor).toMatchObject({
      bytes: 8,
      sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
      mimeType: "image/png",
    });
  });

  test("applies secret policy to the immutable text snapshot", async () => {
    const { context } = await makeFixture();
    try {
      await context.storeAttachments({ paths: ["blocked.txt"], budget: DEFAULT_BUDGET });
      throw new Error("expected blocked attachment");
    } catch (error) {
      expect(error).toMatchObject({ code: "SENSITIVE_CONTENT" });
      expect(JSON.stringify(error)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    }
    await expect(context.storeAttachments({
      paths: ["confirm.txt"],
      budget: DEFAULT_BUDGET,
    })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT" });

    const [confirmed] = await context.storeAttachments({
      paths: ["confirm.txt"],
      budget: DEFAULT_BUDGET,
      allowSensitive: true,
    });
    expect(confirmed?.sensitivity).toEqual({
      decision: "allowed",
      reasons: ["credential_assignment"],
    });
  });

  test("stops a growing attachment at the configured byte cap", async () => {
    const { project, store } = await makeFixture();
    const context = new ContextService(project, store, {
      detectMime: detectFixtureMime,
      afterAttachmentOpen: async (path) => {
        await appendFile(path, "growth beyond limit");
      },
    });

    await expect(context.storeAttachments({
      paths: ["one.txt"],
      budget: { ...DEFAULT_BUDGET, maxAttachmentBytes: 10 },
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("rejects attachment budgets above hard ceilings", async () => {
    const { context } = await makeFixture();
    await expect(context.storeAttachments({
      paths: ["image.png"],
      budget: { ...DEFAULT_BUDGET, maxAttachmentBytes: HARD_BUDGET.maxAttachmentBytes + 1 },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("enforces per-file and total attachment ceilings", async () => {
    const { context } = await makeFixture();
    await expect(context.storeAttachments({
      paths: ["one.txt"],
      budget: { ...DEFAULT_BUDGET, maxAttachmentBytes: 5 },
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    await expect(context.storeAttachments({
      paths: ["one.txt", "two.txt"],
      budget: { ...DEFAULT_BUDGET, maxAttachmentTotalBytes: 10 },
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("rejects an attachment symlink that escapes the project", async () => {
    const { fixture, root, context } = await makeFixture();
    const outside = join(fixture, "outside.png");
    await writeFile(outside, Buffer.from([137, 80, 78, 71]));
    await symlink(outside, join(root, "escape.png"));

    await expect(context.storeAttachments({ paths: ["escape.png"], budget: DEFAULT_BUDGET }))
      .rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
  });

  test("detects a corrupted existing content-addressed attachment", async () => {
    const { project, context } = await makeFixture();
    const [descriptor] = await context.storeAttachments({
      paths: ["image.png"],
      budget: DEFAULT_BUDGET,
    });
    await writeFile(
      join(project.stateDir, "attachments", descriptor!.sha256),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
    );

    await expect(context.storeAttachments({ paths: ["copy.png"], budget: DEFAULT_BUDGET }))
      .rejects.toMatchObject({ code: "CORRUPT_STATE" });
  });

  test("rejects an approved attachment descriptor above the hard media ceiling", async () => {
    const { store, context } = await makeFixture();
    const digest = "d".repeat(64);
    const created = await store.create({
      projectName: "Fixture",
      goal: "Inspect oversized attachment",
      profile: "analysis",
      parentId: null,
      conversationUrl: null,
      idempotencyKey: `oversized-attachment-${crypto.randomUUID()}`,
      budget: DEFAULT_BUDGET,
      contextManifest: { selectors: [], paths: [], smartSelection: false, exclusions: [] },
      diff: null,
      attachments: [{
        id: digest,
        name: "oversized.png",
        sha256: digest,
        bytes: HARD_BUDGET.maxAttachmentBytes + 1,
        mimeType: "image/png",
        sensitivity: { decision: "allowed", reasons: [] },
      }],
      sensitivity: [],
      connectorAllowlist: [],
    });
    await store.claim(created.request.id, created.claimToken);

    await expect(context.readAttachment({
      requestId: created.request.id,
      claimToken: created.claimToken,
      id: digest,
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});
