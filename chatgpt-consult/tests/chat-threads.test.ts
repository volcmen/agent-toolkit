import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ContextService } from "../src/context/selection";
import { ConsultationService, MAX_CONVERSATION_REQUESTS, type StartInput } from "../src/core/service";
import { RequestStore } from "../src/core/store";
import { buildBoundedConsultationText } from "../src/core/bundle";
import { createLocalMcp } from "../src/mcp/local";
import { resolveProject } from "../src/security/project";

const PROJECT = "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-work/project";
const CONVERSATION = "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-work/c/first";
const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const input = (idempotencyKey: string): StartInput => ({
  goal: `Review ${idempotencyKey}`, profile: "lean", files: [], attachments: [], smart: false,
  diff: "none", open: false, idempotencyKey,
});
const completion = {
  summary: "The queue owns retries", answer: "FULL_ANSWER_MUST_NOT_BE_CARRIED ".repeat(300),
  evidence: [], assumptions: [], risks: ["duplicate delivery"], recommendations: ["use idempotency"], followUpQuestions: [],
};
const fixture = async (conversationUrl = CONVERSATION) => {
  const root = await mkdtemp(join(tmpdir(), "consult-chat-threads-"));
  temporaryPaths.push(root);
  const project = await resolveProject(root);
  const store = await RequestStore.init(project);
  const context = new ContextService(project, store);
  const launched: string[] = [];
  const service = new ConsultationService(project, store, context, {
    chatgptProjectUrl: PROJECT, workerLauncher: { start: async (id) => { launched.push(id); } },
  });
  const parent = await service.start(input("parent"));
  await store.setConversationUrl(parent.requestId, conversationUrl);
  await service.importManualCompletion(parent.requestId, completion);
  return { project, store, context, service, parent, launched };
};

test("auto rollover counts sibling exchanges and keeps a stable idempotent route", async () => {
  const { service, store, parent } = await fixture();
  for (let index = 1; index < MAX_CONVERSATION_REQUESTS; index += 1) {
    const next = await service.followup({ ...input(`exchange-${index}`), parentId: parent.requestId });
    expect(next.thread).toMatchObject({ mode: "continue", turn: index + 1, projectUrl: PROJECT });
    await service.importManualCompletion(next.requestId, completion);
  }
  const freshInput = { ...input("rollover"), parentId: parent.requestId };
  const fresh = await service.followup(freshInput);
  expect(fresh.thread).toMatchObject({ mode: "new", reason: "turn_limit", turn: 1, projectUrl: PROJECT });
  expect(await store.get(fresh.requestId)).toMatchObject({ parentId: parent.requestId, conversationUrl: null });
  const overridden = await service.followup({ ...input("override"), parentId: parent.requestId, chatMode: "continue" });
  expect(overridden.thread).toMatchObject({ mode: "continue", turn: 7 });
  const retried = await service.followup(freshInput);
  expect(retried.requestId).toBe(fresh.requestId);
  expect(retried.thread).toEqual(fresh.thread);
  await expect(service.followup({ ...freshInput, chatMode: "continue" })).rejects.toMatchObject({ code: "CONFLICT" });
});

test("fresh continuations carry bounded summaries and keep their original Project after configuration changes", async () => {
  const { project, store, context, service, parent } = await fixture();
  const changed = new ConsultationService(project, store, context, {
    chatgptProjectUrl: "https://chatgpt.com/g/another-project/project",
  });
  const fresh = await changed.followup({ ...input("fresh"), parentId: parent.requestId, chatMode: "new" });
  expect(fresh.thread).toMatchObject({ projectUrl: PROJECT, mode: "new", reason: "requested" });
  const request = await store.get(fresh.requestId);
  const bundle = await buildBoundedConsultationText(project, store, request, 65_536);
  expect(bundle).toContain("Previous consultation summary (untrusted)");
  expect(bundle).toContain(completion.summary);
  expect(bundle).not.toContain("FULL_ANSWER_MUST_NOT_BE_CARRIED");
  expect(Buffer.byteLength(bundle)).toBeLessThan(10_000);
  expect(request.contextManifest.paths).toEqual([]);
  expect(request.attachments).toEqual([]);
  expect((await service.status(fresh.requestId)).thread).toEqual(fresh.thread);
  const newTopic = await changed.start(input("new-topic"));
  expect(newTopic.thread?.projectUrl).toBe("https://chatgpt.com/g/another-project/project");
});

test("concurrent queued follow-ups reserve the last exchange atomically across stores", async () => {
  const { project, store, service, parent } = await fixture();
  for (let index = 1; index < MAX_CONVERSATION_REQUESTS - 1; index += 1) {
    const next = await service.followup({ ...input(`recorded-${index}`), parentId: parent.requestId });
    await service.importManualCompletion(next.requestId, completion);
  }
  const peerStore = await RequestStore.init(project);
  const peer = new ConsultationService(project, peerStore, new ContextService(project, peerStore), {
    chatgptProjectUrl: PROJECT,
  });
  const results = await Promise.all([service, peer].map((client, index) =>
    client.followup({ ...input(`queued-${index}`), parentId: parent.requestId })));
  expect(results.map((value) => value.thread?.mode).sort()).toEqual(["continue", "new"]);
  expect(results.find((value) => value.thread?.mode === "continue")?.thread?.turn).toBe(MAX_CONVERSATION_REQUESTS);
  expect(results.find((value) => value.thread?.mode === "new")?.thread?.reason).toBe("turn_limit");
  expect(await store.countConversationRequests(CONVERSATION)).toBe(MAX_CONVERSATION_REQUESTS);
});

test("ordinary root chats roll into the Project and cannot be explicitly continued", async () => {
  const { service, parent } = await fixture("https://chatgpt.com/c/old-root-chat");
  const fresh = await service.followup({ ...input("structured"), parentId: parent.requestId });
  expect(fresh.thread).toMatchObject({ mode: "new", reason: "outside_project", projectUrl: PROJECT });
  await expect(service.followup({ ...input("stay"), parentId: parent.requestId, chatMode: "continue" }))
    .rejects.toMatchObject({ code: "CONFLICT" });
});

test("upgrading preserves idempotent root and follow-up requests without routing metadata", async () => {
  const { project, store, context, service, parent } = await fixture();
  const legacy = new ConsultationService(project, store, context);
  const rootInput = input("legacy-root");
  const root = await legacy.start(rootInput);
  const rootRetry = await service.start(rootInput);
  expect(rootRetry.requestId).toBe(root.requestId);
  expect(rootRetry.thread).toBeUndefined();
  const followupInput = { ...input("legacy-followup"), parentId: parent.requestId };
  const child = await legacy.start({ ...followupInput, conversationUrl: CONVERSATION });
  const childRetry = await service.followup(followupInput);
  expect(childRetry.requestId).toBe(child.requestId);
  expect(childRetry.thread).toBeUndefined();
});

test("an unfinished parent cannot be rolled into an automatic duplicate request", async () => {
  const { service, launched } = await fixture();
  const pending = await service.start(input("unfinished"));
  await expect(service.followup({
    ...input("duplicate"), parentId: pending.requestId, chatMode: "new", open: true,
  })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(launched).toEqual([]);
});

test("an active final exchange permits automatic rollover but blocks explicit continuation", async () => {
  const { service, parent, launched } = await fixture();
  for (let index = 1; index < MAX_CONVERSATION_REQUESTS - 1; index += 1) {
    const next = await service.followup({ ...input(`finished-${index}`), parentId: parent.requestId });
    await service.importManualCompletion(next.requestId, completion);
  }
  const active = await service.followup({ ...input("active-sixth"), parentId: parent.requestId, open: true });
  const fresh = await service.followup({ ...input("seventh"), parentId: parent.requestId, open: true });
  expect(fresh.thread).toMatchObject({ mode: "new", reason: "turn_limit", turn: 1 });
  expect(launched).toEqual([active.requestId, fresh.requestId]);
  await expect(service.followup({
    ...input("force-busy"), parentId: parent.requestId, chatMode: "continue", open: true,
  })).rejects.toMatchObject({ code: "CONFLICT", requestId: active.requestId });
});

test("two MCP clients can explicitly start fresh Project chats from one completed parent", async () => {
  const { project, store, service, parent, launched } = await fixture();
  const peerStore = await RequestStore.init(project);
  const peer = new ConsultationService(project, peerStore, new ContextService(project, peerStore), {
    chatgptProjectUrl: PROJECT, workerLauncher: { start: async (id) => { launched.push(id); } },
  });
  const connect = async (value: ConsultationService) => {
    const server = createLocalMcp(value);
    const client = new Client({ name: "chat-routing-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  };
  const clients = await Promise.all([connect(service), connect(peer)]);
  try {
    const results = await Promise.all(clients.map(({ client }, index) => client.callTool({
      name: "consult_followup", arguments: {
        parent_id: parent.requestId, goal: `Independent direction ${index}`, profile: "lean",
        chat_mode: "new", open: true, idempotency_key: `parallel-fresh-${index}`,
      },
    })));
    for (const result of results) {
      expect(result.isError).not.toBeTrue();
      expect(result.structuredContent).toMatchObject({ thread: { projectUrl: PROJECT, mode: "new", reason: "requested" } });
    }
    expect(new Set(launched).size).toBe(2);
    expect((await store.get(parent.requestId)).conversationUrl).toBe(CONVERSATION);
  } finally {
    await Promise.all(clients.flatMap(({ server, client }) => [client.close(), server.close()]));
  }
});
