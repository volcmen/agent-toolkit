import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ContextService } from "../src/context/selection";
import { DEFAULT_BUDGET, HARD_BUDGET, type ContextBudget } from "../src/core/schema";
import { ConsultationService } from "../src/core/service";
import { RequestStore } from "../src/core/store";
import { createChatgptMcp } from "../src/mcp/chatgpt";
import { resolveProject } from "../src/security/project";

const temporaryPaths: string[] = [];
const baseTime = new Date("2026-08-30T12:00:00.000Z");

const mimeForFixture = async (path: string): Promise<string> => {
  const content = await readFile(path);
  if (content[0] === 137 && content[1] === 80) return "image/png";
  if (content.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  if (content.subarray(0, 3).toString() === "ID3") return "audio/mpeg";
  if (content.toString() === "fixture-video") return "video/mp4";
  throw new Error("unexpected fixture MIME");
};

interface Fixture {
  root: string;
  store: RequestStore;
  context: ContextService;
  service: ConsultationService;
  setNow(value: Date): void;
}

const makeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-chatgpt-mcp-"));
  temporaryPaths.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "queue.ts"),
    "export const queue = 'queue';\nexport const retry = 'queue';\n",
  );
  await writeFile(join(root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(join(root, "report.pdf"), Buffer.from("%PDF-1.7\nfixture\n"));
  await writeFile(join(root, "voice.mp3"), Buffer.from([0x49, 0x44, 0x33, 0x04]));
  await writeFile(join(root, "clip.mp4"), Buffer.from("fixture-video"));

  const git = Bun.which("git");
  if (!git) throw new Error("git is required for this test fixture");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
    ["add", "src/queue.ts"],
    ["commit", "-qm", "fixture"],
  ]) {
    const result = Bun.spawnSync([git, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  await writeFile(
    join(root, "src", "queue.ts"),
    "export const queue = 'queue';\nexport const retry = 'queue';\nexport const limit = 3;\n",
  );

  let now = baseTime;
  const project = await resolveProject(root);
  let randomCall = 0;
  const store = await RequestStore.init(project, {
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 31 + randomCall++),
  });
  const context = new ContextService(project, store, { detectMime: mimeForFixture });
  const service = new ConsultationService(project, store, context, { now: () => now });
  return {
    root,
    store,
    context,
    service,
    setNow: (value) => { now = value; },
  };
};

const connect = async (store: RequestStore, context: ContextService) => {
  const server = createChatgptMcp({ store, context });
  const client = new Client({ name: "chatgpt-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
};

const structured = (result: { structuredContent?: unknown }): Record<string, unknown> => {
  expect(result.structuredContent).toBeObject();
  return result.structuredContent as Record<string, unknown>;
};

const start = async (
  fixture: Fixture,
  idempotencyKey: string,
  options: {
    profile?: "lean" | "research" | "analysis" | "connected";
    files?: string[];
    attachments?: string[];
    diff?: "working" | "none";
    connectors?: string[];
    budget?: Partial<ContextBudget>;
  } = {},
) => fixture.service.start({
  goal: "Review queue policy",
  profile: options.profile ?? "lean",
  files: options.files ?? ["src/queue.ts"],
  smart: false,
  attachments: options.attachments ?? [],
  diff: options.diff ?? "none",
  open: false,
  ...(options.connectors ? { connectors: options.connectors } : {}),
  idempotencyKey,
  ...(options.budget ? { budget: options.budget } : {}),
});

const completion = {
  summary: "Queue policy is bounded.",
  answer: "Keep the retry limit explicit.",
  evidence: ["src/queue.ts"],
  assumptions: [],
  risks: ["Retries can amplify load."],
  recommendations: ["Measure exhausted retries."],
  followUpQuestions: [],
};

const safeError = (code: string, message: string) => ({ error: { code, message } });

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("ChatGPT MCP", () => {
  test("advertises exactly six strict project-pinned tools with accurate annotations and instructions", async () => {
    const fixture = await makeFixture();
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "request_get",
        "context_search",
        "context_read",
        "diff_get",
        "attachment_get",
        "request_complete",
      ]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBeTrue();
      expect(listed.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBeTrue();
      expect(listed.tools.every((tool) => tool.outputSchema?.type === "object")).toBeTrue();
      for (const tool of listed.tools) {
        const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
        expect(tool.inputSchema.required).toContain("request_id");
        expect(tool.inputSchema.required).toContain("claim_token");
        expect(properties.request_id).toMatchObject({
          minLength: 32,
          maxLength: 32,
          pattern: "^[a-f0-9]{32}$",
        });
        expect(properties.claim_token).toMatchObject({
          minLength: 43,
          maxLength: 43,
          pattern: "^[A-Za-z0-9_-]{43}$",
        });
      }
      expect(listed.tools.slice(0, 5).every((tool) =>
        tool.annotations?.readOnlyHint === true)).toBeTrue();
      expect(listed.tools.find((tool) => tool.name === "request_get")?.annotations)
        .toMatchObject({ idempotentHint: true });
      expect(listed.tools.find((tool) => tool.name === "attachment_get")?.annotations)
        .toMatchObject({ idempotentHint: true });
      for (const name of ["context_search", "context_read", "diff_get"]) {
        expect(listed.tools.find((tool) => tool.name === name)?.annotations)
          .toMatchObject({ readOnlyHint: true, idempotentHint: false });
      }
      expect(listed.tools.find((tool) => tool.name === "request_complete")?.annotations)
        .toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        });
      const instructions = client.getInstructions() ?? "";
      expect(instructions.length).toBeLessThanOrEqual(512);
      expect(instructions.toLowerCase()).toContain("call request_get first");
      expect(instructions.toLowerCase()).toContain("untrusted");
      expect(instructions.toLowerCase()).toContain("retrieve selectively");
      expect(instructions.toLowerCase()).toContain("cite project paths");
      expect(instructions.toLowerCase()).toContain("approved manifest");
      expect(instructions.toLowerCase()).toContain("request_complete exactly once");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("runs pending through selective read, search, diff, attachment, and compact completion", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "full-lifecycle", {
      profile: "connected",
      files: ["src/queue.ts"],
      attachments: ["image.png"],
      diff: "working",
      connectors: ["github"],
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const auth = { request_id: started.requestId, claim_token: started.claimToken };
      const claimed = await client.callTool({ name: "request_get", arguments: auth });
      expect(claimed.isError).not.toBeTrue();
      expect(structured(claimed)).toMatchObject({
        request: {
          requestId: started.requestId,
          state: "claimed",
          revision: 1,
          goal: "Review queue policy",
          profile: "connected",
          projectName: fixture.root.split("/").at(-1),
          connectorAllowlist: ["github"],
          budget: {
            current: { servedTextBytes: 0, servedSearchHits: 0 },
            remaining: { textBytes: DEFAULT_BUDGET.maxServedTextBytes, searchHits: 50 },
          },
        },
      });
      const projection = JSON.stringify(claimed);
      expect(projection).not.toContain(fixture.root);
      expect(projection).not.toContain(started.claimToken);
      for (const forbidden of [
        "claimHash", "claimToken", "idempotencyKey", "creationFingerprint", "conversationUrl",
        "stateDir", "sha256",
      ]) expect(projection).not.toContain(forbidden);
      expect(projection).not.toContain("export const queue");

      const again = await client.callTool({ name: "request_get", arguments: auth });
      expect(structured(again)).toMatchObject({ request: { state: "claimed", revision: 1 } });

      const read = await client.callTool({
        name: "context_read",
        arguments: { ...auth, path: "src/queue.ts", offset: 0, limit: 4_096 },
      });
      expect(structured(read)).toMatchObject({ path: "src/queue.ts", eof: true });
      expect(JSON.stringify(read)).toContain("export const queue");
      expect(JSON.stringify(read)).not.toContain("sha256");
      expect((structured(read).budget as { current: { servedTextBytes: number } })
        .current.servedTextBytes).toBeGreaterThan(0);

      const searched = await client.callTool({
        name: "context_search",
        arguments: { ...auth, query: "queue", paths: ["src/queue.ts"] },
      });
      expect((structured(searched).hits as Array<Record<string, unknown>>)[0])
        .toMatchObject({ path: "src/queue.ts", line: 1 });
      expect((structured(searched).budget as { current: { servedSearchHits: number } })
        .current.servedSearchHits).toBeGreaterThan(0);

      const diff = await client.callTool({
        name: "diff_get",
        arguments: { ...auth, offset: 0, limit: 4_096 },
      });
      expect(structured(diff)).toMatchObject({ path: "working.diff", eof: true });
      expect(JSON.stringify(diff)).toContain("export const limit");
      expect(JSON.stringify(diff)).not.toContain("sha256");

      const request = (structured(claimed).request as {
        attachments: Array<{ id: string }>;
      });
      const image = await client.callTool({
        name: "attachment_get",
        arguments: { ...auth, attachment_id: request.attachments[0]!.id },
      });
      expect(image.content).toEqual([{
        type: "image",
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
        mimeType: "image/png",
      }]);
      expect(JSON.stringify(image.structuredContent)).not.toContain("iVBOR");

      const completed = await client.callTool({
        name: "request_complete",
        arguments: { ...auth, expected_revision: 1, completion },
      });
      expect(completed.content).toEqual([{
        type: "text",
        text: `Consultation ${started.requestId} was completed.`,
      }]);
      expect(structured(completed)).toEqual({
        requestId: started.requestId,
        state: "completed",
        revision: 2,
        acknowledged: true,
      });
      expect(JSON.stringify(completed)).not.toContain(completion.answer);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects malformed, unknown, wrong-claim, unapproved, and expired access with safe results", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "access-errors");
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const unknownMarker = "unrequested-private-marker";
      const malformed = await client.callTool({
        name: "request_get",
        arguments: {
          request_id: started.requestId,
          claim_token: started.claimToken,
          unexpected: unknownMarker,
        },
      });
      expect(malformed.isError).toBeTrue();
      expect(structured(malformed)).toEqual(safeError(
        "INVALID_INPUT",
        "The request is invalid. (root): unrecognized_keys [unexpected]",
      ));
      expect(JSON.stringify(malformed)).not.toContain(unknownMarker);
      expect((await fixture.store.get(started.requestId)).state).toBe("pending");

      const wrongClaim = await client.callTool({
        name: "request_get",
        arguments: { request_id: started.requestId, claim_token: "A".repeat(43) },
      });
      expect(wrongClaim.isError).toBeTrue();
      expect(structured(wrongClaim)).toEqual(safeError(
        "NOT_FOUND",
        "The consultation was not found.",
      ));
      expect(JSON.stringify(wrongClaim)).not.toContain(started.claimToken);

      await client.callTool({
        name: "request_get",
        arguments: { request_id: started.requestId, claim_token: started.claimToken },
      });
      const unapproved = await client.callTool({
        name: "context_read",
        arguments: {
          request_id: started.requestId,
          claim_token: started.claimToken,
          path: "src/not-selected.ts",
        },
      });
      expect(unapproved.isError).toBeTrue();
      expect(structured(unapproved)).toEqual(safeError(
        "FORBIDDEN_PATH",
        "The requested project path is not allowed.",
      ));
      expect(JSON.stringify(unapproved)).not.toContain("not-selected");

      const expiring = await start(fixture, "expired", {
        budget: { expiresAfterMs: 1 },
      });
      fixture.setNow(new Date(baseTime.getTime() + 2));
      const expired = await client.callTool({
        name: "request_get",
        arguments: { request_id: expiring.requestId, claim_token: expiring.claimToken },
      });
      expect(expired.isError).toBeTrue();
      expect(structured(expired)).toEqual(safeError("EXPIRED", "The consultation has expired."));
      expect(JSON.stringify(expired)).not.toContain(expiring.claimToken);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("maps wrong claims to NOT_FOUND across non-active retrieval and completion states", async () => {
    const fixture = await makeFixture();
    const wrongClaim = "A".repeat(43);
    const completed = await start(fixture, "wrong-claim-completed");
    await fixture.store.claim(completed.requestId, completed.claimToken);
    await fixture.store.complete(completed.requestId, completed.claimToken, 1, completion);
    const cancelled = await start(fixture, "wrong-claim-cancelled", {
      attachments: ["image.png"],
    });
    await fixture.store.claim(cancelled.requestId, cancelled.claimToken);
    await fixture.store.cancel(cancelled.requestId);
    const expiring = await start(fixture, "wrong-claim-expired", {
      budget: { expiresAfterMs: 1 },
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const completedRead = await client.callTool({
        name: "context_read",
        arguments: {
          request_id: completed.requestId,
          claim_token: wrongClaim,
          path: "src/queue.ts",
        },
      });
      expect(structured(completedRead)).toEqual(safeError(
        "NOT_FOUND",
        "The consultation was not found.",
      ));

      const cancelledCompletion = await client.callTool({
        name: "request_complete",
        arguments: {
          request_id: cancelled.requestId,
          claim_token: wrongClaim,
          expected_revision: 1,
          completion,
        },
      });
      expect(structured(cancelledCompletion)).toEqual(safeError(
        "NOT_FOUND",
        "The consultation was not found.",
      ));
      const cancelledAttachment = await client.callTool({
        name: "attachment_get",
        arguments: {
          request_id: cancelled.requestId,
          claim_token: wrongClaim,
          attachment_id: "0".repeat(64),
        },
      });
      expect(structured(cancelledAttachment)).toEqual(safeError(
        "NOT_FOUND",
        "The consultation was not found.",
      ));

      fixture.setNow(new Date(baseTime.getTime() + 2));
      await fixture.store.get(expiring.requestId);
      const expiredGet = await client.callTool({
        name: "request_get",
        arguments: { request_id: expiring.requestId, claim_token: wrongClaim },
      });
      expect(structured(expiredGet)).toEqual(safeError(
        "NOT_FOUND",
        "The consultation was not found.",
      ));
      for (const result of [completedRead, cancelledCompletion, cancelledAttachment, expiredGet]) {
        expect(JSON.stringify(result)).not.toContain(completed.claimToken);
        expect(JSON.stringify(result)).not.toContain(cancelled.claimToken);
        expect(JSON.stringify(result)).not.toContain(expiring.claimToken);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("validates malformed input before invoking injected dependencies", async () => {
    const calls: string[] = [];
    const shouldNotRun = (name: string) => async () => {
      calls.push(name);
      throw new Error(`dependency ${name} invoked`);
    };
    const store = {
      claim: shouldNotRun("claim"),
      authorize: shouldNotRun("authorize"),
      complete: shouldNotRun("complete"),
    } as unknown as RequestStore;
    const context = {
      read: shouldNotRun("read"),
      search: shouldNotRun("search"),
      readDiff: shouldNotRun("readDiff"),
      readAttachment: shouldNotRun("readAttachment"),
    } as unknown as ContextService;
    const { client, server } = await connect(store, context);
    try {
      const cases = [
        {
          name: "request_get",
          arguments: { request_id: "0".repeat(31), claim_token: "A".repeat(43) },
          expected: "request_id: too_small; request_id: invalid_format",
        },
        {
          name: "context_search",
          arguments: { request_id: "0".repeat(32), claim_token: "A".repeat(43), query: " " },
          expected: "query: invalid_format",
        },
        {
          name: "context_read",
          arguments: { request_id: "0".repeat(32), claim_token: "A".repeat(43), path: "../secret" },
          expected: "path: invalid_format",
        },
        {
          name: "diff_get",
          arguments: { request_id: "0".repeat(32), claim_token: "A".repeat(42) },
          expected: "claim_token: too_small; claim_token: invalid_format",
        },
        {
          name: "attachment_get",
          arguments: { request_id: "0".repeat(32), claim_token: "A".repeat(43), attachment_id: "nope" },
          expected: "attachment_id: too_small; attachment_id: invalid_format",
        },
        {
          name: "request_complete",
          arguments: { request_id: "0".repeat(32), claim_token: "A".repeat(43), expected_revision: -1, completion },
          expected: "expected_revision: too_small",
        },
      ];
      for (const { expected, ...input } of cases) {
        const result = await client.callTool(input);
        expect(result.isError).toBeTrue();
        expect(structured(result)).toEqual(safeError(
          "INVALID_INPUT",
          `The request is invalid. ${expected}`,
        ));
      }
      expect(calls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps connected guidance bounded when the separate allowlist is large", async () => {
    const fixture = await makeFixture();
    const connectors = Array.from(
      { length: 100 },
      (_, index) => `connector-${index}-${"x".repeat(100)}`,
    );
    const started = await start(fixture, "large-connector-list", {
      profile: "connected",
      connectors,
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const claimed = await client.callTool({
        name: "request_get",
        arguments: { request_id: started.requestId, claim_token: started.claimToken },
      });
      expect(claimed.isError).not.toBeTrue();
      const request = structured(claimed).request as {
        connectorAllowlist: string[];
        profileInstructions: string;
      };
      expect(request.connectorAllowlist).toEqual(connectors.slice().sort());
      expect(request.profileInstructions.length).toBeLessThanOrEqual(512);
      expect(request.profileInstructions).not.toContain(connectors[0]!);
      expect(request.profileInstructions).toContain("connectorAllowlist");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("normalizes an explicit selector through service persistence and request projection", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "normalized-selector", {
      files: ["src/../src/queue.ts"],
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const result = await client.callTool({
        name: "request_get",
        arguments: { request_id: started.requestId, claim_token: started.claimToken },
      });
      expect(result.isError).not.toBeTrue();
      const request = structured(result).request as {
        manifest: {
          selectors: string[];
          paths: Array<{ path: string; selectionReason: string[] }>;
        };
      };
      expect(request.manifest.selectors).toEqual(["src/queue.ts"]);
      expect(request.manifest.paths).toEqual([expect.objectContaining({
        path: "src/queue.ts",
        selectionReason: ["explicit:0"],
      })]);
      expect(JSON.stringify(result)).not.toContain("src/../src/queue.ts");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects aggregate completion content above the hard ceiling before store invocation", async () => {
    const calls: string[] = [];
    const store = {
      complete: async () => {
        calls.push("complete");
        throw new Error("store must not receive an over-hard-limit completion");
      },
    } as unknown as RequestStore;
    const { client, server } = await connect(store, {} as ContextService);
    try {
      const result = await client.callTool({
        name: "request_complete",
        arguments: {
          request_id: "0".repeat(32),
          claim_token: "A".repeat(43),
          expected_revision: 1,
          completion: {
            ...completion,
            summary: "s".repeat(600_000),
            answer: "a".repeat(600_000),
          },
        },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual(safeError(
        "INVALID_INPUT",
        "The request is invalid. completion: custom",
      ));
      expect(calls).toEqual([]);
      expect(JSON.stringify(result).length).toBeLessThan(300);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("enforces text and search budgets and returns refreshed counters", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "text-budget", {
      budget: { maxReadBytes: 8, maxServedTextBytes: 12 },
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    try {
      await client.callTool({ name: "request_get", arguments: auth });
      const first = await client.callTool({
        name: "context_read",
        arguments: { ...auth, path: "src/queue.ts", limit: 8 },
      });
      expect(structured(first)).toMatchObject({
        budget: {
          current: { servedTextBytes: 8, servedSearchHits: 0 },
          remaining: { textBytes: 4, searchHits: 50 },
        },
      });
      const exhausted = await client.callTool({
        name: "context_read",
        arguments: { ...auth, path: "src/queue.ts", offset: 8, limit: 8 },
      });
      expect(exhausted.isError).toBeTrue();
      expect(structured(exhausted)).toEqual(safeError(
        "BUDGET_EXCEEDED",
        "The consultation budget was exceeded.",
      ));

      const searchStarted = await start(fixture, "search-budget", {
        budget: { maxSearchHits: 1 },
      });
      const searchAuth = {
        request_id: searchStarted.requestId,
        claim_token: searchStarted.claimToken,
      };
      await client.callTool({ name: "request_get", arguments: searchAuth });
      const searched = await client.callTool({
        name: "context_search",
        arguments: { ...searchAuth, query: "queue" },
      });
      expect(structured(searched)).toMatchObject({
        hits: [{ path: "src/queue.ts", line: 1 }],
        budget: {
          current: { servedSearchHits: 1 },
          remaining: { searchHits: 0 },
        },
      });
      const noMoreHits = await client.callTool({
        name: "context_search",
        arguments: { ...searchAuth, query: "queue" },
      });
      expect(structured(noMoreHits)).toMatchObject({
        hits: [],
        budget: {
          current: { servedSearchHits: 1 },
          remaining: { searchHits: 0 },
        },
      });

      const textLimited = await start(fixture, "search-text-budget", {
        budget: { maxServedTextBytes: 29, maxSearchHits: 50 },
      });
      const textAuth = {
        request_id: textLimited.requestId,
        claim_token: textLimited.claimToken,
      };
      await client.callTool({ name: "request_get", arguments: textAuth });
      const oneTextHit = await client.callTool({
        name: "context_search",
        arguments: { ...textAuth, query: "queue" },
      });
      expect(structured(oneTextHit)).toMatchObject({
        hits: [{ path: "src/queue.ts", line: 1 }],
        budget: {
          current: { servedTextBytes: 29, servedSearchHits: 1 },
          remaining: { textBytes: 0, searchHits: 49 },
        },
      });
      const textExhausted = await client.callTool({
        name: "context_search",
        arguments: { ...textAuth, query: "queue" },
      });
      expect(structured(textExhausted)).toMatchObject({
        hits: [],
        budget: { remaining: { textBytes: 0, searchHits: 49 } },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns a maximum escaped chunk after charging its real text budget", async () => {
    const fixture = await makeFixture();
    const escapedPath = "src/escaped.txt";
    const escapedText = "\"\n".repeat(HARD_BUDGET.maxReadBytes / 2);
    await writeFile(join(fixture.root, escapedPath), escapedText);
    const started = await start(fixture, "maximum-escaped-chunk", {
      files: [escapedPath],
      budget: {
        maxReadBytes: HARD_BUDGET.maxReadBytes,
        maxServedTextBytes: HARD_BUDGET.maxReadBytes,
      },
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    try {
      await client.callTool({ name: "request_get", arguments: auth });
      const result = await client.callTool({
        name: "context_read",
        arguments: { ...auth, path: escapedPath, limit: HARD_BUDGET.maxReadBytes },
      });
      expect((await fixture.store.get(started.requestId)).servedTextBytes).toBe(262_144);
      expect(result.isError).not.toBeTrue();
      expect(structured(result)).toMatchObject({
        path: escapedPath,
        text: escapedText,
        budget: {
          current: { servedTextBytes: 262_144 },
          remaining: { textBytes: 0 },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns large schema-valid escaped search output after charging real budgets", async () => {
    const fixture = await makeFixture();
    const longPath = `src/${"p".repeat(180)}.txt`;
    const snippet = `needle${"\"".repeat(234)}`;
    await writeFile(join(fixture.root, longPath), `${snippet}\n`.repeat(500));
    const started = await start(fixture, "large-escaped-search", {
      files: [longPath],
      budget: {
        maxSearchHits: HARD_BUDGET.maxSearchHits,
        maxServedTextBytes: 120_000,
      },
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    try {
      await client.callTool({ name: "request_get", arguments: auth });
      const result = await client.callTool({
        name: "context_search",
        arguments: { ...auth, query: "needle", paths: [longPath] },
      });
      expect(await fixture.store.get(started.requestId)).toMatchObject({
        servedTextBytes: 120_000,
        servedSearchHits: 500,
      });
      expect(result.isError).not.toBeTrue();
      const value = structured(result) as {
        hits: Array<{ path: string; line: number; snippet: string }>;
        budget: {
          current: { servedTextBytes: number; servedSearchHits: number };
          remaining: { textBytes: number; searchHits: number };
        };
      };
      expect(value.hits).toHaveLength(500);
      expect(value.hits[0]).toEqual({ path: longPath, line: 1, snippet });
      expect(value.hits[499]).toEqual({ path: longPath, line: 500, snippet });
      expect(value.budget).toMatchObject({
        current: { servedTextBytes: 120_000, servedSearchHits: 500 },
        remaining: { textBytes: 0, searchHits: 0 },
      });
      expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeGreaterThan(262_144);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns safe NOT_FOUND for absent diff and absent or unknown attachments", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "missing-approved-resources", {
      attachments: ["image.png"],
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    try {
      await client.callTool({ name: "request_get", arguments: auth });
      const missingDiff = await client.callTool({ name: "diff_get", arguments: auth });
      expect(structured(missingDiff)).toEqual(safeError(
        "NOT_FOUND",
        "The consultation was not found.",
      ));

      for (const attachmentId of ["0".repeat(64), "f".repeat(64)]) {
        const missingAttachment = await client.callTool({
          name: "attachment_get",
          arguments: { ...auth, attachment_id: attachmentId },
        });
        expect(structured(missingAttachment)).toEqual(safeError(
          "NOT_FOUND",
          "The consultation was not found.",
        ));
        expect(JSON.stringify(missingAttachment)).not.toContain(fixture.root);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects invalid, oversized, and claim-bearing completion before persistence", async () => {
    const fixture = await makeFixture();
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const invalidStarted = await start(fixture, "invalid-completion");
      const invalidAuth = { request_id: invalidStarted.requestId, claim_token: invalidStarted.claimToken };
      await client.callTool({ name: "request_get", arguments: invalidAuth });
      const invalid = await client.callTool({
        name: "request_complete",
        arguments: {
          ...invalidAuth,
          expected_revision: 1,
          completion: { ...completion, answer: "", extra: "private marker" },
        },
      });
      expect(structured(invalid)).toEqual(safeError(
        "INVALID_INPUT",
        "The request is invalid. completion.answer: too_small; completion: unrecognized_keys [extra]",
      ));
      expect(JSON.stringify(invalid)).not.toContain("private marker");
      expect(await fixture.store.getCompletion(invalidStarted.requestId)).toBeNull();

      const oversizedStarted = await start(fixture, "oversized-completion", {
        budget: { maxCompletionBytes: 128 },
      });
      const oversizedAuth = { request_id: oversizedStarted.requestId, claim_token: oversizedStarted.claimToken };
      await client.callTool({ name: "request_get", arguments: oversizedAuth });
      const oversized = await client.callTool({
        name: "request_complete",
        arguments: {
          ...oversizedAuth,
          expected_revision: 1,
          completion: { ...completion, answer: "x".repeat(256) },
        },
      });
      expect(structured(oversized)).toEqual(safeError(
        "BUDGET_EXCEEDED",
        "The consultation budget was exceeded.",
      ));
      expect(await fixture.store.getCompletion(oversizedStarted.requestId)).toBeNull();

      const claimStarted = await start(fixture, "claim-completion");
      const claimAuth = { request_id: claimStarted.requestId, claim_token: claimStarted.claimToken };
      await client.callTool({ name: "request_get", arguments: claimAuth });
      const claimBearing = await client.callTool({
        name: "request_complete",
        arguments: {
          ...claimAuth,
          expected_revision: 1,
          completion: { ...completion, answer: `never persist x${claimStarted.claimToken}x` },
        },
      });
      expect(structured(claimBearing)).toEqual(safeError(
        "INVALID_INPUT",
        "Completion contains forbidden claim material",
      ));
      expect(JSON.stringify(claimBearing)).not.toContain(claimStarted.claimToken);
      expect(await fixture.store.getCompletion(claimStarted.requestId)).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("accepts an identical completion retry at its original revision and conflicts on a difference", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "duplicate-completion");
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      await client.callTool({ name: "request_get", arguments: auth });
      const first = await client.callTool({
        name: "request_complete",
        arguments: { ...auth, expected_revision: 1, completion },
      });
      const repeated = await client.callTool({
        name: "request_complete",
        arguments: { ...auth, expected_revision: 1, completion },
      });
      expect(structured(repeated)).toEqual(structured(first));

      const different = await client.callTool({
        name: "request_complete",
        arguments: {
          ...auth,
          expected_revision: 1,
          completion: { ...completion, answer: "A different answer." },
        },
      });
      expect(different.isError).toBeTrue();
      expect(structured(different)).toEqual(safeError(
        "CONFLICT",
        "The consultation cannot be changed in its current state.",
      ));
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns image data only as an image block and non-image media as opaque embedded resources", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "media-blocks", {
      attachments: ["image.png", "report.pdf", "voice.mp3", "clip.mp4"],
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    try {
      const claimed = await client.callTool({ name: "request_get", arguments: auth });
      const attachments = (structured(claimed).request as {
        attachments: Array<{ id: string; mimeType: string }>;
      }).attachments;
      for (const descriptor of attachments) {
        const result = await client.callTool({
          name: "attachment_get",
          arguments: { ...auth, attachment_id: descriptor.id },
        });
        expect(result.content).toHaveLength(1);
        const block = result.content[0]!;
        if (descriptor.mimeType === "image/png") {
          expect(block).toEqual({
            type: "image",
            data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
            mimeType: "image/png",
          });
        } else {
          expect(block.type).toBe("resource");
          expect(block).toMatchObject({
            resource: {
              uri: `consult-attachment://${descriptor.id}`,
              mimeType: descriptor.mimeType,
            },
          });
          const resource = "resource" in block ? block.resource : undefined;
          expect(resource && "blob" in resource ? resource.blob : undefined).toBeString();
        }
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(fixture.root);
        expect(serialized).not.toContain(".chatgpt-consult/attachments/");
        expect(JSON.stringify(result.structuredContent)).not.toContain(
          "resource" in block && "blob" in block.resource ? block.resource.blob : "iVBOR",
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("maps malformed dependency output and unknown failures to compact generic INTERNAL", async () => {
    const marker = "/private/root/malformed-output-marker";
    const store = {
      claim: async () => ({
        id: "0".repeat(32),
        state: "claimed",
        goal: marker,
      }),
    } as unknown as RequestStore;
    const context = {} as ContextService;
    const { client, server } = await connect(store, context);
    try {
      const result = await client.callTool({
        name: "request_get",
        arguments: { request_id: "0".repeat(32), claim_token: "A".repeat(43) },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual(safeError("INTERNAL", "The operation failed."));
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain("ZodError");
      expect(JSON.stringify(result).length).toBeLessThan(300);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects valid-shaped poisoned project identity without exposing machine paths", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "poisoned-project-identity");
    const request = await fixture.store.get(started.requestId);
    for (const poisoned of [
      { ...request, state: "claimed" as const, revision: 1, projectName: fixture.root },
      { ...request, state: "claimed" as const, revision: 1, projectId: "not-an-opaque-id" },
    ]) {
      const store = { claim: async () => poisoned } as unknown as RequestStore;
      const { client, server } = await connect(store, {} as ContextService);
      try {
        const result = await client.callTool({
          name: "request_get",
          arguments: { request_id: started.requestId, claim_token: started.claimToken },
        });
        expect(result.isError).toBeTrue();
        expect(structured(result)).toEqual(safeError("INTERNAL", "The operation failed."));
        expect(JSON.stringify(result)).not.toContain(fixture.root);
        expect(JSON.stringify(result)).not.toContain("not-an-opaque-id");
        expect(JSON.stringify(result)).not.toContain(started.claimToken);
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  test("binds valid-shaped retrieval output to the first authorized request snapshot", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "poisoned-retrieval-output", {
      attachments: ["image.png"],
      diff: "working",
    });
    const snapshot = await fixture.store.get(started.requestId);
    const descriptor = snapshot.attachments[0]!;
    let searchPath = fixture.root;
    let attachmentVariant = 0;
    const fakeContext = {
      search: async () => [{ path: searchPath, line: 1, snippet: "poisoned" }],
      read: async () => ({
        path: "src/not-approved.ts",
        offset: 0,
        nextOffset: 4,
        eof: true,
        text: "safe",
        sha256: descriptor.sha256,
      }),
      readDiff: async () => ({
        path: "src/queue.ts",
        offset: 0,
        nextOffset: 4,
        eof: true,
        text: "safe",
        sha256: snapshot.diff!.sha256,
      }),
      readAttachment: async () => {
        const base = { ...descriptor, data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
        if (attachmentVariant === 0) return { ...base, id: "f".repeat(64) };
        if (attachmentVariant === 1) return { ...base, name: "substituted.png" };
        if (attachmentVariant === 2) return { ...base, mimeType: "image/jpeg" };
        if (attachmentVariant === 3) return { ...base, bytes: descriptor.bytes - 1 };
        if (attachmentVariant === 4) {
          return { ...base, sensitivity: { decision: "redacted", reasons: ["poisoned"] } };
        }
        return { ...base, data: Buffer.from([137]) };
      },
    } as unknown as ContextService;
    const { client, server } = await connect(fixture.store, fakeContext);
    const auth = { request_id: started.requestId, claim_token: started.claimToken };
    const expectInternal = (result: Awaited<ReturnType<Client["callTool"]>>) => {
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual(safeError("INTERNAL", "The operation failed."));
      expect(JSON.stringify(result)).not.toContain(fixture.root);
      expect(JSON.stringify(result)).not.toContain(started.claimToken);
    };
    try {
      await client.callTool({ name: "request_get", arguments: auth });
      expectInternal(await client.callTool({
        name: "context_search",
        arguments: { ...auth, query: "queue", paths: ["src/queue.ts"] },
      }));
      searchPath = "src/not-approved.ts";
      expectInternal(await client.callTool({
        name: "context_search",
        arguments: { ...auth, query: "queue", paths: ["src/queue.ts"] },
      }));
      expectInternal(await client.callTool({
        name: "context_read",
        arguments: { ...auth, path: "src/queue.ts" },
      }));
      expectInternal(await client.callTool({ name: "diff_get", arguments: auth }));
      for (attachmentVariant = 0; attachmentVariant < 6; attachmentVariant += 1) {
        expectInternal(await client.callTool({
          name: "attachment_get",
          arguments: { ...auth, attachment_id: descriptor.id },
        }));
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects same-length attachment byte substitution against the approved digest", async () => {
    const fixture = await makeFixture();
    const started = await start(fixture, "attachment-byte-substitution", {
      attachments: ["image.png"],
    });
    const snapshot = await fixture.store.get(started.requestId);
    const descriptor = snapshot.attachments[0]!;
    const substituted = Buffer.from([137, 80, 78, 71, 13, 10, 26, 11]);
    expect(substituted.byteLength).toBe(8);
    const fakeContext = {
      readAttachment: async () => ({ ...descriptor, data: substituted }),
    } as unknown as ContextService;
    const { client, server } = await connect(fixture.store, fakeContext);
    try {
      await client.callTool({
        name: "request_get",
        arguments: { request_id: started.requestId, claim_token: started.claimToken },
      });
      const result = await client.callTool({
        name: "attachment_get",
        arguments: {
          request_id: started.requestId,
          claim_token: started.claimToken,
          attachment_id: descriptor.id,
        },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual(safeError("INTERNAL", "The operation failed."));
      expect(result.content).toEqual([{ type: "text", text: "INTERNAL: The operation failed." }]);
      expect(JSON.stringify(result)).not.toContain(substituted.toString("base64"));
      expect(JSON.stringify(result)).not.toContain(started.claimToken);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("never emits the presented claim when valid dependency data contains it", async () => {
    const fixture = await makeFixture();
    const predictedClaim = Buffer.alloc(32, 32).toString("base64url");
    const poisoned = await fixture.service.start({
      goal: `Do not echo x${predictedClaim}x`,
      profile: "lean",
      files: ["src/queue.ts"],
      smart: false,
      attachments: [],
      diff: "none",
      open: false,
      idempotencyKey: "claim-in-projection",
    });
    expect(poisoned.claimToken).toBe(predictedClaim);
    const projectionConnection = await connect(fixture.store, fixture.context);
    try {
      const result = await projectionConnection.client.callTool({
        name: "request_get",
        arguments: { request_id: poisoned.requestId, claim_token: poisoned.claimToken },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual(safeError("INTERNAL", "The operation failed."));
      expect(JSON.stringify(result)).not.toContain(poisoned.claimToken);
    } finally {
      await projectionConnection.client.close();
      await projectionConnection.server.close();
    }

    const clean = await start(fixture, "claim-in-read");
    const fakeContext = {
      read: async () => ({
        path: "src/queue.ts",
        offset: 0,
        nextOffset: clean.claimToken.length,
        eof: true,
        text: `x${clean.claimToken}x`,
        sha256: "a".repeat(64),
      }),
    } as unknown as ContextService;
    const readConnection = await connect(fixture.store, fakeContext);
    try {
      const auth = { request_id: clean.requestId, claim_token: clean.claimToken };
      await readConnection.client.callTool({ name: "request_get", arguments: auth });
      const result = await readConnection.client.callTool({
        name: "context_read",
        arguments: { ...auth, path: "src/queue.ts" },
      });
      expect(result.isError).toBeTrue();
      expect(structured(result)).toEqual(safeError("INTERNAL", "The operation failed."));
      expect(JSON.stringify(result)).not.toContain(clean.claimToken);
    } finally {
      await readConnection.client.close();
      await readConnection.server.close();
    }
  });

  test("serves a compact maximum-cardinality projection above ten thousand JSON nodes", async () => {
    const fixture = await makeFixture();
    const reasons = Array.from({ length: 100 }, (_, index) => `explicit:${index}`);
    const paths = Array.from({ length: 100 }, (_, index) => ({
      path: `src/file-${index.toString().padStart(3, "0")}.ts`,
      sha256: index.toString(16).padStart(64, "0"),
      bytes: 10,
      mimeType: "text/typescript",
      selectionReason: reasons,
      sensitivity: { decision: "allowed" as const, reasons: [] },
    }));
    expect(paths.reduce((total, entry) => total + entry.selectionReason.length, 0)).toBe(10_000);
    const created = await fixture.store.create({
      projectName: fixture.root.split("/").at(-1)!,
      goal: "Review a maximum-cardinality approved context",
      profile: "analysis",
      parentId: null,
      conversationUrl: null,
      idempotencyKey: "maximum-cardinality-projection",
      budget: { ...DEFAULT_BUDGET, maxPaths: 100 },
      contextManifest: {
        selectors: paths.map((entry) => entry.path),
        paths,
        smartSelection: false,
        exclusions: ["default-deny paths"],
      },
      diff: null,
      attachments: [],
      sensitivity: paths.map((entry) => ({
        scope: `context:${entry.path}`,
        decision: "allowed" as const,
        reasons: [],
      })),
      connectorAllowlist: [],
    });
    const { client, server } = await connect(fixture.store, fixture.context);
    try {
      const result = await client.callTool({
        name: "request_get",
        arguments: { request_id: created.request.id, claim_token: created.claimToken },
      });
      expect(result.isError).not.toBeTrue();
      const serialized = JSON.stringify(structured(result));
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(262_144);
      const request = structured(result).request as {
        manifest: { paths: Array<Record<string, unknown>> };
        attachments: Array<Record<string, unknown>>;
      };
      expect(request.manifest.paths).toHaveLength(100);
      expect(request.manifest.paths.every((entry) => entry.sensitivity === undefined)).toBeTrue();
      expect(request.attachments.every((entry) => entry.sensitivity === undefined)).toBeTrue();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
