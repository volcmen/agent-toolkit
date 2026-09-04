import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ContextService } from "../src/context/selection";
import {
  ConsultationService,
  type BrowserStatus,
  type BrowserWorkerLauncher,
} from "../src/core/service";
import { RequestStore } from "../src/core/store";
import { createLocalMcp } from "../src/mcp/local";
import { browserRecoveryInstruction } from "../src/mcp/results";
import { resolveProject } from "../src/security/project";

const temporaryPaths: string[] = [];
const fixedTime = new Date("2026-08-30T12:00:00.000Z");

const makeFixture = async (options: {
  beforePublicationCommit?: (directory: string) => Promise<void>;
  workerLauncher?: BrowserWorkerLauncher;
  now?: () => Date;
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-local-mcp-"));
  temporaryPaths.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "queue.ts"), "export const retries = 3;\n");
  const project = await resolveProject(root);
  let randomCall = 0;
  const store = await RequestStore.init(project, {
    now: options.now ?? (() => fixedTime),
    randomBytes: (size) => Buffer.alloc(size, 71 + randomCall++),
  });
  const context = new ContextService(project, store);
  const service = new ConsultationService(project, store, context, {
    now: options.now ?? (() => fixedTime),
    ...(options.beforePublicationCommit
      ? { beforePublicationCommit: options.beforePublicationCommit }
      : {}),
    ...(options.workerLauncher ? { workerLauncher: options.workerLauncher } : {}),
  });
  return { root, store, service };
};

const connect = async (service: ConsultationService, defaultProfile?: "lean" | "research" | "analysis" | "connected") => {
  const server = defaultProfile === undefined
    ? createLocalMcp(service)
    : createLocalMcp(service, defaultProfile);
  const client = new Client({ name: "local-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
};

const structured = (result: { structuredContent?: unknown }): Record<string, unknown> => {
  expect(result.structuredContent).toBeObject();
  return result.structuredContent as Record<string, unknown>;
};

const runGit = (root: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const makeGitFixture = async (options: {
  workerLauncher?: BrowserWorkerLauncher;
  now?: () => Date;
} = {}) => {
  const fixture = await makeFixture(options);
  runGit(fixture.root, "init", "-q");
  runGit(fixture.root, "config", "user.email", "test@example.com");
  runGit(fixture.root, "config", "user.name", "Test User");
  runGit(fixture.root, "add", "src/queue.ts");
  runGit(fixture.root, "commit", "-qm", "fixture");
  await appendFile(join(fixture.root, "src", "queue.ts"), "export const backoff = true;\n");
  return fixture;
};

const textOf = (result: { content: readonly { type: string; text?: string }[] }): string => {
  const content = result.content[0];
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
};

interface InputPropertySchema {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: InputPropertySchema;
}

interface ListedInputSchema {
  default?: unknown;
  additionalProperties?: boolean;
  required?: string[];
  properties: Record<string, InputPropertySchema>;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("browserRecoveryInstruction", () => {
  test("recommends open for a proven submission stalled in needs_manual", () => {
    expect(browserRecoveryInstruction("needs_manual", "submitted")).toContain("Run open");
  });

  test("recommends open for an unattempted submission stalled in needs_manual", () => {
    expect(browserRecoveryInstruction("needs_manual", "not_submitted")).toContain("Run open");
  });

  test("recommends open for needs_manual when certainty is unknown", () => {
    expect(browserRecoveryInstruction("needs_manual")).toContain("Run open");
  });

  test("never recommends open for an uncertain submission", () => {
    const text = browserRecoveryInstruction("needs_manual", "uncertain");
    expect(text).not.toContain("Run open");
    expect(text).toContain("manual handoff/import-result");
  });

  test("keeps its needs_login guidance unchanged by submission certainty", () => {
    expect(browserRecoveryInstruction("needs_login", "not_submitted")).toContain("setup browser");
    expect(browserRecoveryInstruction("needs_login", "uncertain")).toContain("setup browser");
  });

  test("returns null outside needs_login and needs_manual", () => {
    expect(browserRecoveryInstruction("awaiting_response", "not_submitted")).toBeNull();
    expect(browserRecoveryInstruction(undefined, undefined)).toBeNull();
  });
});

describe("local MCP", () => {
  test("advertises only the six focused lifecycle tools with accurate schemas and annotations", async () => {
    const { service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "consult_start",
        "consult_status",
        "consult_show",
        "consult_followup",
        "consult_cancel",
        "consult_publish",
      ]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBeTrue();
      expect(listed.tools.every((tool) => tool.outputSchema?.type === "object")).toBeTrue();
      const startSchema = listed.tools.find((tool) => tool.name === "consult_start")
        ?.inputSchema as unknown as ListedInputSchema;
      const statusSchema = listed.tools.find((tool) => tool.name === "consult_status")
        ?.inputSchema as unknown as ListedInputSchema;
      const followupSchema = listed.tools.find((tool) => tool.name === "consult_followup")
        ?.inputSchema as unknown as ListedInputSchema;
      const publishSchema = listed.tools.find((tool) => tool.name === "consult_publish")
        ?.inputSchema as unknown as ListedInputSchema;
      expect(startSchema.default).toBeUndefined();
      expect(startSchema.additionalProperties).toBeFalse();
      expect(startSchema.required).toEqual(["goal"]);
      expect(startSchema.properties.goal).toMatchObject({
        maxLength: 8_192,
        pattern: "\\S",
      });
      expect(startSchema.properties.connectors?.items).toMatchObject({
        maxLength: 128,
        pattern: "\\S",
      });
      expect(startSchema.properties.idempotency_key).toMatchObject({
        maxLength: 128,
        pattern: "^[A-Za-z0-9._:-]{1,128}$",
      });
      expect(startSchema.properties.files?.items?.maxLength).toBe(4_096);
      expect(startSchema.properties.files?.items?.pattern).toContain("\\.\\.");
      expect(startSchema.properties.files?.items?.pattern).toContain("\\0");
      for (const schema of [statusSchema, followupSchema, publishSchema]) {
        expect(schema.default).toBeUndefined();
        expect(schema.additionalProperties).toBeFalse();
      }
      expect(statusSchema.required).toEqual(["request_id"]);
      expect(statusSchema.properties.request_id).toMatchObject({
        minLength: 32,
        maxLength: 32,
        pattern: "^[a-f0-9]{32}$",
      });
      expect(followupSchema.required).toEqual(["parent_id", "goal"]);
      expect(followupSchema.properties.parent_id?.pattern).toBe("^[a-f0-9]{32}$");
      expect(publishSchema.required).toEqual(["request_id"]);
      expect(publishSchema.properties.output?.pattern).toContain("\\.\\.");
      expect(listed.tools.find((tool) => tool.name === "consult_start")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(listed.tools.find((tool) => tool.name === "consult_status")?.annotations)
        .toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(listed.tools.find((tool) => tool.name === "consult_show")?.annotations)
        .toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(listed.tools.find((tool) => tool.name === "consult_followup")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(listed.tools.find((tool) => tool.name === "consult_cancel")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
      expect(listed.tools.find((tool) => tool.name === "consult_publish")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });

      const instructions = client.getInstructions() ?? "";
      expect(instructions.length).toBeLessThanOrEqual(512);
      expect(instructions.toLowerCase()).toContain("asynchronous");
      expect(instructions.toLowerCase()).toContain("poll consult_status");
      expect(instructions).toMatch(
        /needs_manual[^.]+submission_uncertain[^.]+submission certainty uncertain[^.]+workerActive true[^.]+poll consult_status/i,
      );
      expect(instructions).toMatch(/needs_login[^.]+setup browser/i);
      expect(instructions).toMatch(/every other recovery tuple[^.]+manual handoff\/import-result/i);
      expect(instructions.toLowerCase()).toContain("explicit user intent");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start without a profile uses the configured default, not a hardcoded lean", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "analysis");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false },
      });
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "analysis" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start without a profile keeps the configured default when the request carries no context", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false },
      });
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "lean" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test.each([
    ["files", { files: ["src/queue.ts"] }],
    ["attachments", { attachments: ["notes.txt"] }],
  ])("consult_start without a profile resolves to analysis when the request carries %s", async (_name, extra) => {
    const { root, store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    await writeFile(join(root, "notes.txt"), "queue attachment notes\n");
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, ...extra },
      });
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "analysis" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start without a profile resolves to analysis when the request carries a working diff", async () => {
    const { store, service } = await makeGitFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, diff: "working" },
      });
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "analysis" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start honours an explicit lean profile even when the request carries files", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "analysis");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Review the retry policy",
          open: false,
          profile: "lean",
          files: ["src/queue.ts"],
        },
      });
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "lean" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_followup without a profile inherits the parent's profile", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, profile: "research" },
      });
      const parentId = structured(started).requestId as string;

      const followed = await client.callTool({
        name: "consult_followup",
        arguments: { parent_id: parentId, goal: "Now assess backoff", open: false },
      });
      const followupId = structured(followed).requestId as string;
      expect(await store.get(followupId)).toMatchObject({ profile: "research" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_followup treats an explicit null profile as absent and inherits the parent's profile", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, profile: "research" },
      });
      const parentId = structured(started).requestId as string;

      const followed = await client.callTool({
        name: "consult_followup",
        arguments: { parent_id: parentId, goal: "Now assess backoff", open: false, profile: null },
      });
      expect(followed.isError).not.toBe(true);
      const followupId = structured(followed).requestId as string;
      expect(await store.get(followupId)).toMatchObject({ profile: "research" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start treats an explicit null profile as absent and resolves to analysis when the request carries files", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Review the retry policy",
          open: false,
          profile: null,
          files: ["src/queue.ts"],
        },
      });
      expect(started.isError).not.toBe(true);
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "analysis" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start treats an explicit null profile as absent and keeps the configured default when the request carries no context", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service, "lean");
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, profile: null },
      });
      expect(started.isError).not.toBe(true);
      const value = structured(started);
      expect(await store.get(value.requestId as string)).toMatchObject({ profile: "lean" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start treats an explicit null idempotency_key as absent", async () => {
    const { store, service } = await makeFixture({
      workerLauncher: { start: async () => {} },
    });
    const { client, server } = await connect(service);
    try {
      const first = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, idempotency_key: null },
      });
      const second = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Review the retry policy", open: false, idempotency_key: null },
      });
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      const firstId = structured(first).requestId as string;
      const secondId = structured(second).requestId as string;
      expect(firstId).not.toBe(secondId);
      const firstRequest = await store.get(firstId);
      const secondRequest = await store.get(secondId);
      expect(firstRequest.idempotencyKey).not.toBeNull();
      expect(firstRequest.idempotencyKey).not.toBe(secondRequest.idempotencyKey);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("consult_start queues browser execution when open is omitted", async () => {
    const launched: string[] = [];
    const { service } = await makeFixture({
      workerLauncher: { start: async (requestId) => { launched.push(requestId); } },
    });
    const { client, server } = await connect(service);
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Default to an automatic browser consultation" },
      });
      expect(started.isError).not.toBe(true);
      const startValue = structured(started);
      expect(startValue).toMatchObject({ browser: { phase: "queued" } });
      expect(launched).toEqual([startValue.requestId as string]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("runs start, status, show, follow-up, cancel, and explicit publish through normalized dual results", async () => {
    const { root, service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Review queue policy",
          files: ["src/queue.ts"],
          profile: "lean",
          open: false,
          idempotency_key: "mcp-parent",
        },
      });
      expect(started.isError).not.toBe(true);
      const startValue = structured(started);
      expect(startValue).toMatchObject({ state: "pending", revision: 0 });
      expect(started.content).toEqual([{
        type: "text",
        text: `Consultation ${startValue.requestId} is pending. Use the returned handoff, then poll consult_status.`,
      }]);
      const requestId = startValue.requestId as string;
      const claimToken = startValue.claimToken as string;
      expect(claimToken).toBeString();
      expect(JSON.stringify(startValue)).toContain(claimToken);

      const status = await client.callTool({
        name: "consult_status",
        arguments: { request_id: requestId },
      });
      expect(structured(status)).toMatchObject({ requestId, state: "pending" });
      expect(JSON.stringify(status)).not.toContain(claimToken);

      const shown = await client.callTool({
        name: "consult_show",
        arguments: { request_id: requestId },
      });
      expect(structured(shown)).toMatchObject({ requestId, completion: null });
      expect(JSON.stringify(shown)).not.toContain(claimToken);

      const followed = await client.callTool({
        name: "consult_followup",
        arguments: {
          parent_id: requestId,
          goal: "Now assess backoff",
          files: ["src/queue.ts"],
          open: false,
          idempotency_key: "mcp-child",
        },
      });
      const followupValue = structured(followed);
      expect(followupValue).toMatchObject({ state: "pending" });
      expect(followupValue.claimToken).toBeString();

      const cancelled = await client.callTool({
        name: "consult_cancel",
        arguments: { request_id: followupValue.requestId },
      });
      expect(structured(cancelled)).toMatchObject({
        requestId: followupValue.requestId,
        state: "cancelled",
      });
      expect(JSON.stringify(cancelled)).not.toContain(followupValue.claimToken as string);

      await service.importManualCompletion(requestId, {
        summary: "Queue ownership",
        answer: "Keep retries in the queue.",
        evidence: ["src/queue.ts"],
        assumptions: [],
        risks: [],
        recommendations: ["Use an idempotency key"],
        followUpQuestions: [],
      });
      const published = await client.callTool({
        name: "consult_publish",
        arguments: { request_id: requestId, output: "docs/consultations/queue.md" },
      });
      expect(published.isError).not.toBe(true);
      expect(structured(published)).toEqual({ path: "docs/consultations/queue.md" });
      expect(await Bun.file(join(root, "docs", "consultations", "queue.md")).exists()).toBeTrue();
      expect(JSON.stringify(published)).not.toContain(claimToken);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("reports automatic browser progress and closed recovery guidance without changing six tools", async () => {
    const launched: string[] = [];
    const { store, service } = await makeFixture({
      workerLauncher: { start: async (requestId) => { launched.push(requestId); } },
    });
    const { client, server } = await connect(service);
    try {
      const started = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Automatic browser consultation",
          open: true,
          idempotency_key: "mcp-browser-start",
        },
      });
      const startValue = structured(started);
      expect(startValue).toMatchObject({
        browser: {
          phase: "queued",
          reason: null,
          attempt: 0,
          submissionCertainty: "not_submitted",
        },
      });
      expect(started.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("poll consult_status"),
      });
      const requestId = startValue.requestId as string;
      expect(launched).toEqual([requestId]);

      const ownerId = "c".repeat(32);
      await store.acquireBrowserLease(requestId, ownerId);
      await store.recordBrowserProgress(requestId, ownerId, {
        phase: "needs_login",
        reason: "login_required",
      });
      await store.releaseBrowserLease(requestId, ownerId);
      const loginStatus = await client.callTool({
        name: "consult_status",
        arguments: { request_id: requestId },
      });
      expect(structured(loginStatus)).toMatchObject({
        browser: {
          phase: "needs_login",
          reason: "login_required",
          attempt: 1,
          submissionCertainty: "not_submitted",
        },
      });
      expect(loginStatus.content[0]).toMatchObject({ type: "text" });
      expect(textOf(loginStatus)).toContain("setup browser");
      expect(textOf(loginStatus)).toContain("No browser worker is running");

      await store.acquireBrowserLease(requestId, ownerId);
      await store.recordBrowserProgress(requestId, ownerId, {
        phase: "needs_manual",
        reason: "ui_changed",
      });
      await store.releaseBrowserLease(requestId, ownerId);
      const manualStatus = await client.callTool({
        name: "consult_status",
        arguments: { request_id: requestId },
      });
      expect(manualStatus.content[0]).toMatchObject({ type: "text" });
      expect(textOf(manualStatus)).toContain("manual handoff");
      expect(textOf(manualStatus)).toContain("No browser worker is running");
      expect(textOf(manualStatus)).toContain("Run open");

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "consult_start",
        "consult_status",
        "consult_show",
        "consult_followup",
        "consult_cancel",
        "consult_publish",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("polls transient submission uncertainty only while its worker lease is active", async () => {
    let now = fixedTime;
    const { store, service } = await makeFixture({ now: () => now });
    const { client, server } = await connect(service);
    try {
      const started = await service.start({
        goal: "Observe one active browser attempt",
        profile: "lean",
        files: [],
        smart: false,
        attachments: [],
        diff: "none",
        open: false,
        idempotencyKey: "active-browser-attempt",
      });
      await store.queueBrowserExecution(started.requestId);
      const ownerId = "d".repeat(32);
      await store.acquireBrowserLease(started.requestId, ownerId);
      await store.recordBrowserProgress(started.requestId, ownerId, {
        phase: "awaiting_browser",
        reason: null,
      });
      await store.beginBrowserSubmission(started.requestId, ownerId);

      const active = await client.callTool({
        name: "consult_status",
        arguments: { request_id: started.requestId },
      });
      expect(structured(active)).toMatchObject({
        browser: {
          phase: "needs_manual",
          reason: "submission_uncertain",
          submissionCertainty: "uncertain",
          workerActive: true,
        },
      });
      expect(active.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("poll consult_status"),
      });

      now = new Date(fixedTime.getTime() + 30_001);
      const durable = await client.callTool({
        name: "consult_status",
        arguments: { request_id: started.requestId },
      });
      expect(structured(durable)).toMatchObject({
        browser: { workerActive: false },
      });
      expect(durable.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("manual handoff"),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("routes every near-miss active uncertainty tuple to manual recovery", async () => {
    const requestId = "e".repeat(32);
    const exact: BrowserStatus = {
      phase: "needs_manual",
      reason: "submission_uncertain",
      attempt: 1,
      submissionCertainty: "uncertain",
      workerActive: true,
    };
    let browser: BrowserStatus = exact;
    const fake = {
      start: async () => ({
        requestId,
        state: "pending",
        revision: 0,
        claimToken: "claim",
        handoff: "handoff",
        browser,
      }),
      status: async () => ({
        requestId,
        state: "pending",
        revision: 0,
        goal: "Check exact recovery routing",
        profile: "lean",
        parentId: null,
        createdAt: fixedTime.toISOString(),
        updatedAt: fixedTime.toISOString(),
        expiresAt: new Date(fixedTime.getTime() + 60_000).toISOString(),
        browser,
      }),
    } as unknown as ConsultationService;
    const { client, server } = await connect(fake);
    const guidance = async (): Promise<string[]> => {
      const started = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Check exact recovery routing", open: true },
      });
      const status = await client.callTool({
        name: "consult_status",
        arguments: { request_id: requestId },
      });
      return [started, status].map((result) => {
        const content = result.content[0];
        return content?.type === "text" ? content.text : "";
      });
    };
    try {
      for (const mismatch of [
        { ...exact, phase: "awaiting_response" as const },
        { ...exact, reason: "ui_changed" as const },
        { ...exact, submissionCertainty: "not_submitted" as const },
        { ...exact, workerActive: false },
      ]) {
        browser = mismatch;
        for (const text of await guidance()) {
          expect(text).toContain("manual handoff/import-result");
          expect(text).not.toContain("poll consult_status");
        }
      }

      browser = exact;
      for (const text of await guidance()) {
        expect(text).toContain("poll consult_status");
        expect(text).toContain("do not resubmit");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("automatic MCP follow-up queues in the parent's proven conversation", async () => {
    const launched: string[] = [];
    const { store, service } = await makeFixture({
      workerLauncher: { start: async (requestId) => { launched.push(requestId); } },
    });
    const parent = await service.start({
      goal: "MCP parent",
      profile: "lean",
      files: [],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
      idempotencyKey: "mcp-followup-parent",
    });
    await store.setConversationUrl(parent.requestId, "https://chatgpt.com/c/mcp-parent");
    const { client, server } = await connect(service);
    try {
      const followed = await client.callTool({
        name: "consult_followup",
        arguments: {
          parent_id: parent.requestId,
          goal: "Continue automatically",
          open: true,
          idempotency_key: "mcp-followup-child",
        },
      });
      const value = structured(followed);
      expect(value).toMatchObject({ browser: { phase: "queued" } });
      expect(launched).toEqual([value.requestId as string]);
      expect(await store.get(value.requestId as string)).toMatchObject({
        parentId: parent.requestId,
        conversationUrl: "https://chatgpt.com/c/mcp-parent",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns compact structured errors for invalid input and domain failures", async () => {
    const { service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const marker = "unrequested-sensitive-marker";
      const invalid = await client.callTool({
        name: "consult_start",
        arguments: { goal: marker, profile: 7 },
      });
      expect(invalid.isError).toBe(true);
      expect(structured(invalid)).toEqual({
        error: { code: "INVALID_INPUT", message: "The request is invalid. profile: invalid_value" },
      });
      expect(invalid.content).toEqual([{
        type: "text",
        text: "INVALID_INPUT: The request is invalid. profile: invalid_value",
      }]);
      expect(JSON.stringify(invalid)).not.toContain(marker);
      expect(JSON.stringify(invalid).length).toBeLessThan(300);

      const missing = await client.callTool({
        name: "consult_status",
        arguments: { request_id: "00000000000000000000000000000000" },
      });
      expect(missing.isError).toBe(true);
      expect(structured(missing)).toEqual({
        error: { code: "NOT_FOUND", message: "The consultation was not found." },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects malformed boundary syntax and unknown keys without invoking service methods", async () => {
    const calls: string[] = [];
    const shouldNotRun = (name: string) => async () => {
      calls.push(name);
      throw new Error(`service method ${name} was invoked`);
    };
    const fake = {
      start: shouldNotRun("start"),
      status: shouldNotRun("status"),
      show: shouldNotRun("show"),
      followup: shouldNotRun("followup"),
      cancel: shouldNotRun("cancel"),
      publish: shouldNotRun("publish"),
    } as unknown as ConsultationService;
    const { client, server } = await connect(fake);
    try {
      const cases = [
        { name: "consult_start", arguments: { goal: "   " }, expected: "goal: invalid_format" },
        {
          name: "consult_start",
          arguments: { goal: "Review", connectors: ["  "] },
          expected: "connectors.0: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", idempotency_key: "bad key" },
          expected: "idempotency_key: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", files: ["../secret"] },
          expected: "files.0: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", files: ["   "] },
          expected: "files.0: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", files: ["src/que\0ue.ts"] },
          expected: "files.0: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", files: ["C:\\private.txt"] },
          expected: "files.0: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", attachments: ["/tmp/image.png"] },
          expected: "attachments.0: invalid_format",
        },
        {
          name: "consult_start",
          arguments: { goal: "Review", unexpected: "private marker" },
          expected: "(root): unrecognized_keys [unexpected]",
        },
        {
          name: "consult_status",
          arguments: { request_id: "missing-request" },
          expected: "request_id: too_small; request_id: invalid_format",
        },
        {
          name: "consult_followup",
          arguments: { parent_id: "A".repeat(32), goal: "Review" },
          expected: "parent_id: invalid_format",
        },
        {
          name: "consult_publish",
          arguments: { request_id: "0".repeat(32), output: "docs/../escaped.md" },
          expected: "output: invalid_format",
        },
      ];
      for (const { expected, ...input } of cases) {
        const result = await client.callTool(input);
        expect(result.isError).toBeTrue();
        expect(structured(result)).toEqual({
          error: { code: "INVALID_INPUT", message: `The request is invalid. ${expected}` },
        });
        expect(JSON.stringify(result)).not.toContain("private marker");
      }
      expect(calls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test.each([
    ["diff: false", { diff: false }, "diff: invalid_value"],
    ["smart: \"true\"", { smart: "true" }, "smart: invalid_type"],
    ["files as a bare string", { files: "tsconfig.json" }, "files: invalid_type"],
    ["idempotency_key with whitespace", { idempotency_key: "a b" }, "idempotency_key: invalid_format"],
  ])("names the offending field for %s", async (_name, extra, expected) => {
    const { service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const result = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Fix the bug", ...extra },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual({
        error: { code: "INVALID_INPUT", message: `The request is invalid. ${expected}` },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("names an unrecognized key and still rejects it", async () => {
    const { service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const result = await client.callTool({
        name: "consult_start",
        arguments: { goal: "Fix the bug", spuriousOption: true },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "The request is invalid. (root): unrecognized_keys [spuriousOption]",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps a secret-shaped value and a distinctive path out of the validation error", async () => {
    const { service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const secretValue = "sk-live-9f2a6c7d4b1e8a3f0c5d9e2b7a4f1c8d";
      const distinctivePath = "src/very-distinctive-unlikely-path-marker.ts";
      const result = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Fix the bug",
          profile: secretValue,
          files: [distinctivePath],
        },
      });
      expect(result.isError).toBeTrue();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretValue);
      expect(serialized).not.toContain(distinctivePath);
      expect(structured(result)).toEqual({
        error: { code: "INVALID_INPUT", message: "The request is invalid. profile: invalid_value" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("bounds validation error text when many fields are invalid", async () => {
    const { service } = await makeFixture();
    const { client, server } = await connect(service);
    try {
      const result = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: 1,
          profile: 2,
          files: 3,
          smart: 4,
          attachments: 5,
          diff: 6,
          open: 7,
          allow_sensitive: 8,
          connectors: 9,
          idempotency_key: 10,
        },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "The request is invalid. goal: invalid_type; profile: invalid_value; "
            + "files: invalid_type; smart: invalid_type; attachments: invalid_type (+5 more)",
        },
      });
      expect(JSON.stringify(result).length).toBeLessThan(600);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects claim-bearing publication output without writing or echoing the claim", async () => {
    const { root, service } = await makeFixture();
    const started = await service.start({
      goal: "Publish without claim leakage",
      profile: "lean",
      files: [],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
      idempotencyKey: "local-mcp-claim-publication",
    });
    await service.importManualCompletion(started.requestId, {
      summary: "Safe output",
      answer: "Do not publish capabilities.",
      evidence: [],
      assumptions: [],
      risks: [],
      recommendations: [],
      followUpQuestions: [],
    });
    const { client, server } = await connect(service);
    try {
      const result = await client.callTool({
        name: "consult_publish",
        arguments: {
          request_id: started.requestId,
          output: `claim-output/x${started.claimToken}x.md`,
        },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "Publication path contains forbidden claim material",
        },
      });
      expect(JSON.stringify(result)).not.toContain(started.claimToken);
      expect(await Bun.file(join(root, "claim-output")).exists()).toBeFalse();
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("maps malformed service output to generic INTERNAL without validation diagnostics", async () => {
    const marker = "malformed-output-private-marker";
    const calls: string[] = [];
    const fake = {
      status: async () => {
        calls.push("status");
        return { requestId: marker, state: "impossible" };
      },
    } as unknown as ConsultationService;
    const { client, server } = await connect(fake);
    try {
      const result = await client.callTool({
        name: "consult_status",
        arguments: { request_id: "0".repeat(32) },
      });
      expect(calls).toEqual(["status"]);
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual({
        error: { code: "INTERNAL", message: "The operation failed." },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain("ZodError");
      expect(JSON.stringify(result)).not.toContain("validation");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps human result text concise while preserving the normalized structured completion", async () => {
    const { service } = await makeFixture();
    const started = await service.start({
      goal: "Summarize safely",
      profile: "lean",
      files: [],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
      idempotencyKey: "concise-result-text",
    });
    const longSummary = `Summary ${"x".repeat(4_096)}`;
    await service.importManualCompletion(started.requestId, {
      summary: longSummary,
      answer: "Keep structured detail intact.",
      evidence: [],
      assumptions: [],
      risks: [],
      recommendations: [],
      followUpQuestions: [],
    });
    const { client, server } = await connect(service);
    try {
      const shown = await client.callTool({
        name: "consult_show",
        arguments: { request_id: started.requestId },
      });
      expect(structured(shown)).toMatchObject({
        completion: { summary: longSummary },
      });
      const text = shown.content[0];
      expect(text?.type).toBe("text");
      expect(text && "text" in text ? text.text.length : Number.MAX_SAFE_INTEGER)
        .toBeLessThan(512);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("turns unknown failures into a generic result without leaking paths or adapter diagnostics", async () => {
    let root = "";
    const fixture = await makeFixture({
      beforePublicationCommit: async () => {
        throw new Error(`adapter diagnostic at ${root}`);
      },
    });
    root = fixture.root;
    const started = await fixture.service.start({
      goal: "Publish safely",
      profile: "lean",
      files: [],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
      idempotencyKey: "internal-error-fixture",
    });
    await fixture.service.importManualCompletion(started.requestId, {
      summary: "Safe publication",
      answer: "Publish deliberately.",
      evidence: [],
      assumptions: [],
      risks: [],
      recommendations: [],
      followUpQuestions: [],
    });
    const { client, server } = await connect(fixture.service);
    try {
      const result = await client.callTool({
        name: "consult_publish",
        arguments: { request_id: started.requestId },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toEqual({
        error: { code: "INTERNAL", message: "The operation failed." },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("adapter diagnostic");
      expect(JSON.stringify(result)).not.toContain(started.claimToken);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("serve rejection guard", () => {
  test("suppresses an unhandled rejection and keeps the process listener removable", async () => {
    const { installServeRejectionGuard } = await import("../src/mcp/local");
    const messages: string[] = [];
    const before = process.listenerCount("unhandledRejection");
    const remove = installServeRejectionGuard((message) => { messages.push(message); });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    const guard = process.listeners("unhandledRejection").at(-1)!;
    expect(() => guard(new Error("stray webview rejection"), Promise.resolve())).not.toThrow();
    expect(messages).toEqual(["chatgpt-consult: suppressed background rejection\n"]);
    remove();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
