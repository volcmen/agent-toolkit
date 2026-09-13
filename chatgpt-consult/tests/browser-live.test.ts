import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  configureBrowserCdp,
  initializeProject,
  readLocalConfig,
} from "../src/core/service";
import { resolveProject, type ResolvedProject } from "../src/security/project";
import { conversationBelongsToProject } from "../src/browser/handoff";

const OPT_IN = process.env.CHATGPT_CONSULT_BROWSER_ACCEPTANCE === "1";
const LIVE_TIMEOUT_MS = 10 * 60_000;
const exactToolNames = [
  "consult_start",
  "consult_status",
  "consult_show",
  "consult_followup",
  "consult_cancel",
  "consult_publish",
] as const;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = dirname(packageRoot);
const absoluteBin = join(packageRoot, "bin", "chatgpt-consult.ts");
const temporaryPaths: string[] = [];

interface ToolResult {
  isError?: boolean | undefined;
  structuredContent?: unknown;
}

interface PublicStatus {
  requestId: string;
  state: "pending" | "claimed" | "completed" | "cancelled" | "expired";
  completionSource?: "mcp" | "manual" | "browser";
  completion?: unknown;
  browser?: {
    phase: string;
    reason: string | null;
    submissionCertainty: string;
    workerActive: boolean;
    conversationUrl?: string;
  };
}

const activeWorkerOwnsUncertainSubmission = (status: PublicStatus): boolean =>
  status.browser?.phase === "needs_manual"
  && status.browser.reason === "submission_uncertain"
  && status.browser.submissionCertainty === "uncertain"
  && status.browser.workerActive === true;

test("live poll continues only an active worker's uncertain submission", () => {
  const uncertain = {
    requestId: "a".repeat(32),
    state: "pending" as const,
    browser: {
      phase: "needs_manual",
      reason: "submission_uncertain",
      submissionCertainty: "uncertain",
      workerActive: true,
    },
  };
  expect(activeWorkerOwnsUncertainSubmission(uncertain)).toBeTrue();
  expect(activeWorkerOwnsUncertainSubmission({
    ...uncertain,
    browser: { ...uncertain.browser, workerActive: false },
  })).toBeFalse();
  expect(activeWorkerOwnsUncertainSubmission({
    ...uncertain,
    browser: { ...uncertain.browser, reason: "ui_changed" },
  })).toBeFalse();
  expect(activeWorkerOwnsUncertainSubmission({
    ...uncertain,
    browser: { ...uncertain.browser, phase: "awaiting_response" },
  })).toBeFalse();
  expect(activeWorkerOwnsUncertainSubmission({
    ...uncertain,
    browser: { ...uncertain.browser, submissionCertainty: "not_submitted" },
  })).toBeFalse();
});

const runGit = (root: string, ...args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Git fixture setup failed");
  return result.stdout.toString().trim();
};

const valueOf = (result: ToolResult, operation: string): Record<string, unknown> => {
  if (result.isError === true || result.structuredContent === null
    || typeof result.structuredContent !== "object") {
    throw new Error(`${operation} failed`);
  }
  return result.structuredContent as Record<string, unknown>;
};

const requestIdOf = (value: Record<string, unknown>, operation: string): string => {
  const requestId = value.requestId;
  if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId)) {
    throw new Error(`${operation} returned an invalid request identifier`);
  }
  return requestId;
};

const resolveConfiguredSource = async (): Promise<{
  project: ResolvedProject;
  config: Awaited<ReturnType<typeof readLocalConfig>>;
}> => {
  const current = await resolveProject(packageRoot);
  const currentConfig = await readLocalConfig(current);
  if (currentConfig.chatgptProjectUrl !== undefined) {
    return { project: current, config: currentConfig };
  }

  const commonGitDir = runGit(workspaceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const primaryWorkspace = dirname(commonGitDir);
  const primaryProject = await resolveProject(join(primaryWorkspace, "chatgpt-consult"));
  const primaryConfig = await readLocalConfig(primaryProject);
  if (primaryConfig.chatgptProjectUrl === undefined) {
    throw new Error("Live acceptance requires a configured ChatGPT Project URL");
  }
  return { project: primaryProject, config: primaryConfig };
};

const waitForCompletion = async (
  client: Client,
  requestId: string,
  phases: Set<string>,
): Promise<PublicStatus> => {
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = valueOf(await client.callTool({
      name: "consult_status",
      arguments: { request_id: requestId, wait_seconds: 50 },
    }), "consult_status");
    const status = result as unknown as PublicStatus;
    process.stderr.write(`browser-live request=${requestId} state=${status.state} phase=${status.browser?.phase ?? "none"}\n`);
    if (status.browser?.phase) phases.add(status.browser.phase);
    if (status.state === "completed") return status;
    if (status.state === "cancelled" || status.state === "expired") {
      throw new Error(`Browser consultation reached ${status.state}`);
    }
    if (status.browser?.phase === "needs_login" || status.browser?.phase === "needs_manual") {
      if (activeWorkerOwnsUncertainSubmission(status)) {
        continue;
      }
      throw new Error(
        `Browser consultation requires recovery: ${status.browser.phase}/${status.browser.reason ?? "unknown"}`
        + `/${status.browser.submissionCertainty ?? "unknown"}`,
      );
    }
  }
  throw new Error("Browser consultation did not complete within ten minutes");
};

const runCli = (root: string, args: readonly string[]): void => {
  const result = Bun.spawnSync(["bun", absoluteBin, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Manual fallback command failed");
};

afterEach(async () => {
  if (OPT_IN && process.env.CHATGPT_CONSULT_BROWSER_KEEP === "1") {
    process.stderr.write(`browser-live diagnostic fixtures=${JSON.stringify(temporaryPaths.splice(0))}\n`);
    return;
  }
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("authenticated browser acceptance", () => {
  (OPT_IN ? test : test.skip)("completes the no-key local MCP browser lifecycle", async () => {
    const { config } = await resolveConfiguredSource();
    const projectUrl = config.chatgptProjectUrl;
    if (projectUrl === undefined) throw new Error("Live acceptance is not configured");

    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-browser-live-"));
    temporaryPaths.push(root);
    runGit(root, "init", "-q");
    runGit(root, "config", "user.email", "fixture@example.invalid");
    runGit(root, "config", "user.name", "Browser Acceptance");
    await writeFile(join(root, "context.txt"), "A bounded queue retries three times.\n");
    await writeFile(join(root, "attachment.txt"), "Bounded attachment for browser acceptance.\n");
    const fixture = await resolveProject(root);
    await initializeProject(fixture, { chatgptProjectUrl: projectUrl });
    if (config.browserCdpPort !== undefined) {
      await configureBrowserCdp(fixture, config.browserCdpPort);
    }
    runGit(root, "add", ".gitignore", "context.txt", "attachment.txt");
    runGit(root, "commit", "-qm", "browser acceptance fixture");

    const transport = new StdioClientTransport({
      command: "bun",
      args: [absoluteBin, "serve", "local"],
      cwd: root,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "chatgpt-consult-browser-live", version: "1.0.0" });
    const peerTransport = new StdioClientTransport({
      command: "bun", args: [absoluteBin, "serve", "local"], cwd: root, stderr: "pipe",
    });
    peerTransport.stderr?.on("data", () => {});
    const peer = new Client({ name: "chatgpt-consult-browser-peer", version: "1.0.0" });
    const phases = new Set<string>();
    const sources = new Set<string>();
    try {
      await Promise.all([client.connect(transport), peer.connect(peerTransport)]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([...exactToolNames]);

      const [rootResult, peerResult] = await Promise.all([client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Return a concise review of the bounded retry statement.",
          profile: "lean",
          files: ["context.txt"],
          open: true,
          idempotency_key: "browser-live-root",
        },
      }), peer.callTool({
        name: "consult_start",
        arguments: {
          goal: "Return the marker PARALLEL-B in the answer field. This is a synthetic concurrency check.",
          profile: "lean", open: true, idempotency_key: "browser-live-peer",
        },
      })]);
      const rootStart = valueOf(rootResult, "consult_start");
      const peerStart = valueOf(peerResult, "parallel consult_start");
      const rootId = requestIdOf(rootStart, "consult_start");
      const peerId = requestIdOf(peerStart, "parallel consult_start");
      const [rootStatus, peerStatus] = await Promise.all([
        waitForCompletion(client, rootId, phases), waitForCompletion(peer, peerId, phases),
      ]);
      if (rootStatus.completionSource !== "browser"
        || rootStatus.browser?.submissionCertainty !== "submitted"
        || typeof rootStatus.browser.conversationUrl !== "string") {
        throw new Error("Root consultation did not produce a proven browser completion");
      }
      sources.add(rootStatus.completionSource);
      const rootConversationUrl = rootStatus.browser.conversationUrl;
      expect(peerStatus.completionSource).toBe("browser");
      expect(peerStatus.browser?.conversationUrl).toBeString();
      expect(peerStatus.browser?.conversationUrl).not.toBe(rootConversationUrl);
      expect(conversationBelongsToProject(rootConversationUrl, config.chatgptProjectUrl!)).toBeTrue();
      expect(conversationBelongsToProject(peerStatus.browser!.conversationUrl!, config.chatgptProjectUrl!)).toBeTrue();
      const peerShow = valueOf(await peer.callTool({ name: "consult_show", arguments: { request_id: peerId } }), "parallel consult_show");
      expect((peerShow.completion as { answer: string }).answer).toContain("PARALLEL-B");
      process.stderr.write("browser-live parallel roots completed with distinct conversations using shared authentication\n");
      const rootShow = valueOf(await client.callTool({
        name: "consult_show",
        arguments: { request_id: rootId },
      }), "consult_show") as unknown as PublicStatus;
      if (rootShow.completionSource !== "browser" || rootShow.completion === null) {
        throw new Error("Root result was not available through consult_show");
      }

      const followupStart = valueOf(await client.callTool({
        name: "consult_followup",
        arguments: {
          parent_id: rootId,
          goal: "Give one follow-up risk in the same conversation.",
          profile: "lean",
          open: true,
          idempotency_key: "browser-live-followup",
        },
      }), "consult_followup");
      const followupId = requestIdOf(followupStart, "consult_followup");
      const followupStatus = await waitForCompletion(client, followupId, phases);
      if (followupStatus.completionSource !== "browser"
        || followupStatus.browser?.conversationUrl !== rootConversationUrl) {
        throw new Error("Follow-up did not complete in the proven root conversation");
      }
      sources.add(followupStatus.completionSource);

      const attachmentStart = valueOf(await client.callTool({
        name: "consult_followup",
        arguments: {
          parent_id: followupId,
          goal: "Acknowledge the bounded text attachment in one sentence.",
          profile: "lean",
          attachments: ["attachment.txt"],
          open: true,
          idempotency_key: "browser-live-attachment",
        },
      }), "consult_followup attachment");
      const attachmentId = requestIdOf(attachmentStart, "consult_followup attachment");
      const attachmentStatus = await waitForCompletion(client, attachmentId, phases);
      if (attachmentStatus.completionSource !== "browser"
        || attachmentStatus.browser?.conversationUrl !== rootConversationUrl) {
        throw new Error("Attachment follow-up did not complete in the proven conversation");
      }
      sources.add(attachmentStatus.completionSource);

      const freshStart = valueOf(await client.callTool({
        name: "consult_followup",
        arguments: {
          parent_id: attachmentId,
          goal: "In this fresh chat, give one sentence about the previous consultation summary.",
          profile: "lean", chat_mode: "new", open: true,
          idempotency_key: "browser-live-fresh",
        },
      }), "consult_followup fresh");
      const freshStatus = await waitForCompletion(client, requestIdOf(freshStart, "consult_followup fresh"), phases);
      expect(freshStatus.completionSource).toBe("browser");
      expect(freshStatus.browser?.submissionCertainty).toBe("submitted");
      expect(freshStatus.browser?.conversationUrl).not.toBe(rootConversationUrl);
      expect(conversationBelongsToProject(freshStatus.browser!.conversationUrl!, config.chatgptProjectUrl!)).toBeTrue();

      const manualStart = valueOf(await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Exercise the bounded manual import fallback.",
          profile: "lean",
          open: false,
          idempotency_key: "browser-live-manual",
        },
      }), "manual consult_start");
      const manualId = requestIdOf(manualStart, "manual consult_start");
      runCli(root, ["handoff", manualId, "--json"]);
      await writeFile(join(root, "manual-result.json"), JSON.stringify({
        summary: "Manual fallback",
        answer: "The manual fallback completed through validated local import.",
        evidence: [],
        assumptions: [],
        risks: [],
        recommendations: [],
        followUpQuestions: [],
      }));
      runCli(root, ["import-result", manualId, "--input", "manual-result.json", "--json"]);
      const manualShow = valueOf(await client.callTool({
        name: "consult_show",
        arguments: { request_id: manualId },
      }), "manual consult_show") as unknown as PublicStatus;
      if (manualShow.state !== "completed" || manualShow.completionSource !== "manual") {
        throw new Error("Manual fallback did not complete through the manual source");
      }
      sources.add(manualShow.completionSource);

      const publicationPath = join(root, "docs", "consultations", "browser-live.md");
      if (await Bun.file(publicationPath).exists()) {
        throw new Error("Publication existed before explicit consult_publish");
      }
      const published = valueOf(await client.callTool({
        name: "consult_publish",
        arguments: {
          request_id: rootId,
          output: "docs/consultations/browser-live.md",
        },
      }), "consult_publish");
      if (published.path !== "docs/consultations/browser-live.md"
        || !await Bun.file(publicationPath).exists()
        || (await readFile(publicationPath, "utf8")).length === 0) {
        throw new Error("Explicit temporary publication was not created");
      }

      process.stderr.write(
        `browser-live phases=${[...phases].sort().join(",")} sources=${[...sources].sort().join(",")}\n`,
      );
    } finally {
      await Promise.allSettled([client.close(), peer.close()]);
    }
  }, LIVE_TIMEOUT_MS * 5);
});
