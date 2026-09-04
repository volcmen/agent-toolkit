import { describe, expect, test } from "bun:test";
import {
  CdpPageClient,
  MAX_FRAME_PAYLOAD_BYTES,
  type CdpMethod,
  type MinimalSocket,
  type WebSocketFrameEvent,
} from "../src/browser/cdp-page";
import {
  classifyTurnFrame,
  unthrottlePage,
  watchForTurnCompletion,
  type TurnWatchClient,
  type UnthrottleClient,
} from "../src/browser/turn-watch";

class FakeTransportSocket implements MinimalSocket {
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: never) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(): void {}

  emitOpen(): void {
    for (const listener of [...(this.listeners.get("open") ?? [])]) listener(undefined as never);
  }

  emitMessage(data: string): void {
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener({ data } as never);
  }
}

function transportFrameMessage(payloadData: string): string {
  return JSON.stringify({
    method: "Network.webSocketFrameReceived",
    params: { requestId: "1", timestamp: 1, response: { opcode: 1, mask: false, payloadData } },
  });
}

const RUNS = 200;

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function randomUnicode(length: number): string {
  const pool = ["a", "b", "z", "0", "9", "-", "_", "é", "中", "😀", "‏", "́"];
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += pool[randomInt(pool.length)];
  }
  return out;
}

function randomConversationId(): string {
  return `${crypto.randomUUID()}-${randomUnicode(randomInt(6))}`;
}

function turnTopicId(): string {
  return `conversation-turn-${crypto.randomUUID()}`;
}

function turnIdFromTopicId(topicId: string): string {
  return topicId.slice("conversation-turn-".length);
}

function turnStreamItemEntry(conversationId: string, topicId: string): unknown {
  return {
    type: "message",
    topic_id: topicId,
    payload: {
      type: "conversation-turn-stream",
      metadata: null,
      payload: {
        type: "stream-item",
        conversation_id: conversationId,
        encoded_item: randomUnicode(randomInt(20)),
        parent_stream_item_id: null,
        server_timestamp_ms: Date.now(),
        stream_item_id: crypto.randomUUID(),
        turn_id: turnIdFromTopicId(topicId),
      },
    },
  };
}

function turnHeartbeatEntry(conversationId: string, topicId: string): unknown {
  return {
    type: "message",
    topic_id: topicId,
    payload: {
      type: "conversation-turn-stream",
      metadata: null,
      payload: {
        type: "heartbeat",
        conversation_id: conversationId,
        server_timestamp_ms: Date.now(),
        turn_id: turnIdFromTopicId(topicId),
      },
    },
  };
}

function turnDoneEntry(conversationId: string, topicId: string): unknown {
  return {
    type: "message",
    topic_id: topicId,
    payload: {
      type: "conversation-turn-stream",
      metadata: null,
      payload: {
        type: "done",
        conversation_id: conversationId,
        turn_id: turnIdFromTopicId(topicId),
      },
    },
  };
}

function globalConversationCreatedEntry(conversationId: string): unknown {
  return {
    type: "message",
    topic_id: "conversations",
    payload: {
      type: "conversation-created",
      metadata: null,
      payload: { conversation_id: conversationId },
    },
  };
}

function globalTurnCompleteEntry(conversationId: string): unknown {
  return {
    type: "message",
    topic_id: "conversations",
    payload: {
      type: "conversation-turn-complete",
      metadata: null,
      payload: { conversation_id: conversationId },
    },
  };
}

function shape(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function assertClassification(
  raw: string,
  conversationId: string,
  ourTopicId: string | null,
  expectedKind: string,
  context: unknown,
): void {
  const result = classifyTurnFrame(raw, conversationId, ourTopicId);
  if (result.kind !== expectedKind) {
    throw new Error(
      `expected kind "${expectedKind}" but got "${result.kind}" for conversationId=${conversationId} input=${shape(context)}`,
    );
  }
}

describe("classifyTurnFrame generative properties", () => {
  test("a matching per-turn done entry always classifies as complete, wrapped or not", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const topicId = turnTopicId();
      const entry = turnDoneEntry(conversationId, topicId);
      const wrapAsArray = Math.random() < 0.5;
      const input = wrapAsArray ? [entry] : entry;
      assertClassification(JSON.stringify(input), conversationId, topicId, "complete", input);
    }
  });

  test("classifying a single entry matches classifying it wrapped in a one-element array", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const topicId = turnTopicId();
      const pick = Math.random();
      const entry = pick < 0.34
        ? turnDoneEntry(conversationId, topicId)
        : pick < 0.67
          ? turnStreamItemEntry(conversationId, topicId)
          : turnDoneEntry(`${conversationId}-mismatch`, topicId);

      const single = classifyTurnFrame(JSON.stringify(entry), conversationId, null);
      const wrapped = classifyTurnFrame(JSON.stringify([entry]), conversationId, null);
      if (single.kind !== wrapped.kind) {
        throw new Error(
          `single form gave "${single.kind}" but array form gave "${wrapped.kind}" for entry=${shape(entry)}`,
        );
      }
    }
  });

  test("a done entry for a different conversation id never classifies as complete", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const otherConversationId = `${conversationId}-${randomUnicode(1 + randomInt(5))}`;
      const entry = turnDoneEntry(otherConversationId, turnTopicId());
      const result = classifyTurnFrame(JSON.stringify(entry), conversationId, null);
      if (result.kind === "complete") {
        throw new Error(`mismatched conversation id was classified as complete for entry=${shape(entry)}`);
      }
    }
  });

  test("a matching stream-item entry always classifies as progress and reports its topic id", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const topicId = turnTopicId();
      const entry = turnStreamItemEntry(conversationId, topicId);
      const result = classifyTurnFrame(JSON.stringify(entry), conversationId, null);
      if (result.kind !== "progress" || result.topicId !== topicId) {
        throw new Error(`expected progress with topicId="${topicId}" but got ${shape(result)} for entry=${shape(entry)}`);
      }
    }
  });

  test("a done entry on a different per-turn topic than the one already learned never classifies as complete", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const ourTopicId = turnTopicId();
      const foreignTopicId = turnTopicId();
      const entry = turnDoneEntry(conversationId, foreignTopicId);
      const result = classifyTurnFrame(JSON.stringify(entry), conversationId, ourTopicId);
      if (result.kind === "complete") {
        throw new Error(`foreign topic id was classified as complete for entry=${shape(entry)}`);
      }
    }
  });

  test("an account-global conversation-turn-complete entry for the same conversation never classifies as complete", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const entry = globalTurnCompleteEntry(conversationId);
      const result = classifyTurnFrame(JSON.stringify(entry), conversationId, null);
      if (result.kind === "complete") {
        throw new Error(`account-global completion was classified as complete for entry=${shape(entry)}`);
      }
    }
  });

  test("an array containing our matching per-turn done anywhere among random noise entries always completes", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const topicId = turnTopicId();
      const noiseCount = randomInt(4);
      const entries: unknown[] = [];
      for (let n = 0; n < noiseCount; n += 1) {
        entries.push(turnStreamItemEntry(`${conversationId}-noise-${n}`, turnTopicId()));
      }
      entries.splice(randomInt(entries.length + 1), 0, turnDoneEntry(conversationId, topicId));
      assertClassification(JSON.stringify(entries), conversationId, topicId, "complete", entries);
    }
  });

  test("missing or non-object nesting levels never throw and never classify as complete", () => {
    for (let i = 0; i < RUNS; i += 1) {
      const conversationId = randomConversationId();
      const variant = randomInt(6);
      let input: unknown;
      if (variant === 0) input = { payload: null };
      else if (variant === 1) input = { payload: { payload: null } };
      else if (variant === 2) input = { payload: "not-an-object" };
      else if (variant === 3) input = { payload: { payload: 42 } };
      else if (variant === 4) input = {};
      else input = { payload: { payload: [] } };

      let result: ReturnType<typeof classifyTurnFrame> | undefined;
      let threw = false;
      try {
        result = classifyTurnFrame(JSON.stringify(input), conversationId, null);
      } catch {
        threw = true;
      }
      if (threw) {
        throw new Error(`classifyTurnFrame threw for variant=${variant} input=${shape(input)}`);
      }
      if (result?.kind === "complete") {
        throw new Error(`variant=${variant} input=${shape(input)} unexpectedly classified as complete`);
      }
    }
  });

  test("malformed JSON text never throws and is always unreadable", () => {
    const garbageSamples = [
      "",
      "{",
      "not json at all",
      "{\"a\":}",
      "[1,2,",
      " binary\uD800",
      "null",
      "true",
      "42",
      "\"just a string\"",
      "[]",
      "[null,null,null]",
    ];
    for (const raw of garbageSamples) {
      let threw = false;
      let result: ReturnType<typeof classifyTurnFrame> | undefined;
      try {
        result = classifyTurnFrame(raw, randomConversationId(), null);
      } catch {
        threw = true;
      }
      if (threw) throw new Error(`classifyTurnFrame threw for raw=${JSON.stringify(raw)}`);
      if (result?.kind !== "unreadable") {
        throw new Error(`expected unreadable for raw=${JSON.stringify(raw)} but got ${result?.kind}`);
      }
    }
  });

  test("an oversized frame is always unreadable regardless of otherwise-valid shape", () => {
    for (let i = 0; i < 20; i += 1) {
      const conversationId = randomConversationId();
      const entry = turnDoneEntry(conversationId, turnTopicId()) as Record<string, unknown>;
      (entry.payload as Record<string, unknown>).junk = "z".repeat(MAX_FRAME_PAYLOAD_BYTES + 10);
      const raw = JSON.stringify(entry);
      assertClassification(raw, conversationId, null, "unreadable", { byteLength: Buffer.byteLength(raw, "utf8") });
    }
  });

  test("deep unrelated nesting attached alongside a valid match still classifies as complete", () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 200; i += 1) deep = { child: deep };
    const conversationId = randomConversationId();
    const topicId = turnTopicId();
    const entry = turnDoneEntry(conversationId, topicId) as Record<string, unknown>;
    (entry.payload as Record<string, unknown>).unrelated = deep;
    assertClassification(JSON.stringify(entry), conversationId, topicId, "complete", { depth: 200 });
  });

  test("non-string or empty conversation id is always unreadable", () => {
    const entry = turnDoneEntry("whatever", turnTopicId());
    expect(classifyTurnFrame(JSON.stringify(entry), "", null)).toEqual({ kind: "unreadable" });
    expect(classifyTurnFrame(JSON.stringify(entry), undefined as unknown as string, null)).toEqual({ kind: "unreadable" });
    expect(classifyTurnFrame(undefined as unknown as string, "conv", null)).toEqual({ kind: "unreadable" });
  });
});

describe("classifyTurnFrame pinned regression examples captured live from chatgpt.com", () => {
  const conversationId = "b2c4f1a0-4d3e-4a5b-9c1d-6f7e8a9b0c1d";
  const topicId = "conversation-turn-bb7ffd55-1219-4af5-bf3b-f7f21fd16b6a";

  test("a real per-turn stream-item frame classifies as progress and reports its topic id", () => {
    const raw = JSON.stringify({
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        metadata: null,
        payload: {
          type: "stream-item",
          conversation_id: conversationId,
          encoded_item: "abc123==",
          parent_stream_item_id: null,
          server_timestamp_ms: 1788456968994,
          stream_item_id: "5f9c1b2e-1111-4a5b-9c1d-6f7e8a9b0c1d",
          turn_id: "bb7ffd55-1219-4af5-bf3b-f7f21fd16b6a",
        },
      },
    });
    expect(classifyTurnFrame(raw, conversationId, null)).toEqual({ kind: "progress", topicId });
  });

  test("a real per-turn done frame classifies as complete when it matches our learned topic", () => {
    const raw = JSON.stringify({
      type: "message",
      topic_id: topicId,
      payload: {
        type: "conversation-turn-stream",
        metadata: null,
        payload: {
          type: "done",
          conversation_id: conversationId,
          turn_id: "bb7ffd55-1219-4af5-bf3b-f7f21fd16b6a",
        },
      },
    });
    expect(classifyTurnFrame(raw, conversationId, topicId)).toEqual({ kind: "complete" });
  });

  test("a real account-global conversation-turn-complete frame is never treated as complete, even for the same conversation and a learned topic", () => {
    const raw = JSON.stringify({
      type: "message",
      topic_id: "conversations",
      payload: {
        type: "conversation-turn-complete",
        metadata: null,
        payload: { conversation_id: conversationId },
      },
    });
    expect(classifyTurnFrame(raw, conversationId, topicId).kind).not.toBe("complete");
    expect(classifyTurnFrame(raw, conversationId, null).kind).not.toBe("complete");
  });

  test("a real account-global conversation-created frame is never treated as complete", () => {
    const raw = JSON.stringify(globalConversationCreatedEntry(conversationId));
    expect(classifyTurnFrame(raw, conversationId, null).kind).not.toBe("complete");
  });

  test("a data field carrying stream-item then per-turn done for the same topic within one frame does not complete; it binds the topic as progress instead", () => {
    const streamItem = turnStreamItemEntry(conversationId, topicId);
    const done = turnDoneEntry(conversationId, topicId);
    expect(classifyTurnFrame(JSON.stringify([streamItem, done]), conversationId, null)).toEqual({ kind: "progress", topicId });
  });

  test("a data field carrying stream-item then per-turn done for a topic already bound before this frame still completes", () => {
    const streamItem = turnStreamItemEntry(conversationId, topicId);
    const done = turnDoneEntry(conversationId, topicId);
    expect(classifyTurnFrame(JSON.stringify([streamItem, done]), conversationId, topicId)).toEqual({ kind: "complete" });
  });

  test("a data field carrying a stale done ahead of that same topic's stream-item within one frame does not complete", () => {
    const staleTopicId = turnTopicId();
    const done = turnDoneEntry(conversationId, staleTopicId);
    const streamItem = turnStreamItemEntry(conversationId, staleTopicId);
    expect(classifyTurnFrame(JSON.stringify([done, streamItem]), conversationId, null)).toEqual({
      kind: "progress",
      topicId: staleTopicId,
    });
  });

  test("an account-global complete for a different conversation is never treated as complete", () => {
    const raw = JSON.stringify(globalTurnCompleteEntry("some-other-conversation-id"));
    const result = classifyTurnFrame(raw, conversationId, null);
    expect(result.kind).not.toBe("complete");
  });

  test("a bare done arriving before any stream-item never classifies as complete; it is a hint", () => {
    const raw = JSON.stringify(turnDoneEntry(conversationId, topicId));
    expect(classifyTurnFrame(raw, conversationId, null)).toEqual({ kind: "hint" });
  });

  test("a done frame completes once our own stream-item has established its topic", () => {
    const streamItemRaw = JSON.stringify(turnStreamItemEntry(conversationId, topicId));
    expect(classifyTurnFrame(streamItemRaw, conversationId, null)).toEqual({ kind: "progress", topicId });
    const doneRaw = JSON.stringify(turnDoneEntry(conversationId, topicId));
    expect(classifyTurnFrame(doneRaw, conversationId, topicId)).toEqual({ kind: "complete" });
  });

  test("a done frame on a different per-turn topic than the one we learned does not complete; it is a hint", () => {
    const foreignTopicId = "conversation-turn-foreign-turn-id";
    const doneRaw = JSON.stringify(turnDoneEntry(conversationId, foreignTopicId));
    expect(classifyTurnFrame(doneRaw, conversationId, topicId)).toEqual({ kind: "hint" });
  });

  test("a frame on the account-global 'conversations' topic never establishes the topic even when its conversation id matches, and never produces a hint", () => {
    const streamItemRaw = JSON.stringify(turnStreamItemEntry(conversationId, "conversations"));
    expect(classifyTurnFrame(streamItemRaw, conversationId, null)).toEqual({ kind: "other" });
    const doneRaw = JSON.stringify(turnDoneEntry(conversationId, "conversations"));
    expect(classifyTurnFrame(doneRaw, conversationId, null)).toEqual({ kind: "other" });
  });

  test("a stream-item whose topic id lacks the per-turn prefix never establishes the topic", () => {
    const streamItemRaw = JSON.stringify(turnStreamItemEntry(conversationId, "not-a-turn-topic"));
    expect(classifyTurnFrame(streamItemRaw, conversationId, null)).toEqual({ kind: "other" });
  });
});

function makeTurnWatchClient() {
  const frameHandlers = new Set<(frame: WebSocketFrameEvent) => void>();
  const closeHandlers = new Set<() => void>();
  const client: TurnWatchClient = {
    onFrame(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
  return {
    client,
    emitFrame: (payloadData: string) => {
      for (const handler of [...frameHandlers]) handler({ payloadData });
    },
    emitClose: () => {
      for (const handler of [...closeHandlers]) handler();
    },
    frameHandlerCount: () => frameHandlers.size,
    closeHandlerCount: () => closeHandlers.size,
  };
}

function frameFor(
  kind: "done" | "stream-item" | "heartbeat" | "global-complete" | "conversation-created",
  conversationId: string,
  topicId?: string,
): string {
  if (kind === "global-complete") return JSON.stringify(globalTurnCompleteEntry(conversationId));
  if (kind === "conversation-created") return JSON.stringify(globalConversationCreatedEntry(conversationId));
  const tid = topicId ?? turnTopicId();
  if (kind === "done") return JSON.stringify(turnDoneEntry(conversationId, tid));
  if (kind === "heartbeat") return JSON.stringify(turnHeartbeatEntry(conversationId, tid));
  return JSON.stringify(turnStreamItemEntry(conversationId, tid));
}

describe("watchForTurnCompletion", () => {
  test("resolves complete on the first matching done frame", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-1";
    const topicId = turnTopicId();
    const outcome = watchForTurnCompletion(client, conversationId, 5_000);
    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    await expect(outcome).resolves.toEqual({ kind: "complete" });
  });

  test("ignores a done for another conversation and keeps waiting until the real one arrives", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-mine";
    const topicId = turnTopicId();
    const outcome = watchForTurnCompletion(client, conversationId, 5_000);
    emitFrame(frameFor("done", "conv-someone-else"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    await expect(outcome).resolves.toEqual({ kind: "complete" });
  });

  test("reports deadline expiry distinctly and unsubscribes", async () => {
    const { client, frameHandlerCount, closeHandlerCount } = makeTurnWatchClient();
    const outcome = await watchForTurnCompletion(client, "conv-1", 20);
    expect(outcome).toEqual({ kind: "deadline_exceeded" });
    expect(frameHandlerCount()).toBe(0);
    expect(closeHandlerCount()).toBe(0);
  });

  test("reports connection loss distinctly and unsubscribes", async () => {
    const { client, emitClose, frameHandlerCount, closeHandlerCount } = makeTurnWatchClient();
    const outcome = watchForTurnCompletion(client, "conv-1", 5_000);
    emitClose();
    await expect(outcome).resolves.toEqual({ kind: "connection_lost" });
    expect(frameHandlerCount()).toBe(0);
    expect(closeHandlerCount()).toBe(0);
  });

  test("forwards progress callbacks only for matching stream-item frames", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-1";
    const topicId = turnTopicId();
    let progressCount = 0;
    const outcome = watchForTurnCompletion(client, conversationId, 5_000, { onProgress: () => { progressCount += 1; } });
    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("stream-item", "someone-else"));
    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    await outcome;
    expect(progressCount).toBe(2);
  });

  test("resolving on completion does not also resolve on a later close", async () => {
    const { client, emitFrame, emitClose } = makeTurnWatchClient();
    const conversationId = "conv-1";
    const topicId = turnTopicId();
    const outcome = watchForTurnCompletion(client, conversationId, 5_000);
    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    const first = await outcome;
    emitClose();
    expect(first).toEqual({ kind: "complete" });
  });

  test("resolves immediately when a matching done frame is replayed synchronously on subscribe", async () => {
    const socket = new FakeTransportSocket();
    const client = new CdpPageClient({
      port: 9222,
      targetId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      socketFactory: () => socket,
    });
    const connecting = client.connect();
    socket.emitOpen();
    await connecting;
    const conversationId = "conv-buffered";
    const topicId = turnTopicId();
    socket.emitMessage(transportFrameMessage(frameFor("stream-item", conversationId, topicId)));
    socket.emitMessage(transportFrameMessage(frameFor("done", conversationId, topicId)));

    let progressCount = 0;
    const outcome = await watchForTurnCompletion(client, conversationId, 5_000, {
      onProgress: () => { progressCount += 1; },
    });

    expect(outcome).toEqual({ kind: "complete" });
    expect(client.frameHandlerCount).toBe(0);
    expect(progressCount).toBe(1);
    socket.emitMessage(transportFrameMessage(frameFor("stream-item", conversationId, topicId)));
    expect(progressCount).toBe(1);
  });

  test("a premature account-global completion for our conversation does not complete the wait; only our own turn's done frame does", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-root";
    const topicId = turnTopicId();
    const outcome = watchForTurnCompletion(client, conversationId, 5_000);
    let settled = false;
    outcome.then(() => { settled = true; });

    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("conversation-created", conversationId));
    emitFrame(frameFor("global-complete", conversationId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    emitFrame(frameFor("heartbeat", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    await expect(outcome).resolves.toEqual({ kind: "complete" });
  });

  test("a done frame on a foreign per-turn topic for the same conversation does not complete our watch", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-1";
    const ourTopicId = turnTopicId();
    const foreignTopicId = turnTopicId();
    const outcome = watchForTurnCompletion(client, conversationId, 5_000);
    let settled = false;
    outcome.then(() => { settled = true; });

    emitFrame(frameFor("stream-item", conversationId, ourTopicId));
    emitFrame(frameFor("done", conversationId, foreignTopicId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    emitFrame(frameFor("done", conversationId, ourTopicId));
    await expect(outcome).resolves.toEqual({ kind: "complete" });
  });

  test("a bare done on an unlearned topic does not complete the watch and it keeps waiting for a stream-item first", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-1";
    const topicId = turnTopicId();
    const outcome = watchForTurnCompletion(client, conversationId, 5_000);
    let settled = false;
    outcome.then(() => { settled = true; });

    emitFrame(frameFor("done", conversationId, topicId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    await expect(outcome).resolves.toEqual({ kind: "complete" });
  });

  test("forwards a hint callback for a done on a per-turn topic with nothing bound, without completing", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-1";
    const topicId = turnTopicId();
    let hintCount = 0;
    const outcome = watchForTurnCompletion(client, conversationId, 5_000, { onHint: () => { hintCount += 1; } });
    let settled = false;
    outcome.then(() => { settled = true; });

    emitFrame(frameFor("done", conversationId, topicId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hintCount).toBe(1);
    expect(settled).toBe(false);

    emitFrame(frameFor("stream-item", conversationId, topicId));
    emitFrame(frameFor("done", conversationId, topicId));
    await expect(outcome).resolves.toEqual({ kind: "complete" });
    expect(hintCount).toBe(1);
  });

  test("does not forward a hint callback for the account-global conversations topic", async () => {
    const { client, emitFrame } = makeTurnWatchClient();
    const conversationId = "conv-1";
    let hintCount = 0;
    let progressCount = 0;
    const outcome = watchForTurnCompletion(client, conversationId, 20, {
      onHint: () => { hintCount += 1; },
      onProgress: () => { progressCount += 1; },
    });

    emitFrame(frameFor("conversation-created", conversationId));
    emitFrame(frameFor("global-complete", conversationId));
    await expect(outcome).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(hintCount).toBe(0);
    expect(progressCount).toBe(0);
  });
});

function makeUnthrottleClient(failOn?: CdpMethod) {
  const calls: Array<{ method: CdpMethod; params: Record<string, unknown> | undefined }> = [];
  const client: UnthrottleClient = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === failOn) throw new Error(`boom on ${method}`);
      return {};
    },
  };
  return { client, calls };
}

describe("unthrottlePage", () => {
  test("issues exactly the four expected methods in order and returns ready", async () => {
    const { client, calls } = makeUnthrottleClient();
    const outcome = await unthrottlePage(client);
    expect(outcome.kind).toBe("ready");
    expect(calls.map((c) => c.method)).toEqual([
      "Page.enable",
      "Network.enable",
      "Page.setWebLifecycleState",
      "Emulation.setFocusEmulationEnabled",
    ]);
    expect(calls[2]?.params).toEqual({ state: "active" });
    expect(calls[3]?.params).toEqual({ enabled: true });
  });

  test("restore disables focus emulation again", async () => {
    const { client, calls } = makeUnthrottleClient();
    const outcome = await unthrottlePage(client);
    if (outcome.kind !== "ready") throw new Error("expected ready outcome");
    const restoreOutcome = await outcome.restore();
    expect(restoreOutcome).toEqual({ kind: "restored" });
    const last = calls[calls.length - 1];
    expect(last?.method).toBe("Emulation.setFocusEmulationEnabled");
    expect(last?.params).toEqual({ enabled: false });
  });

  test.each(["Page.enable", "Network.enable", "Page.setWebLifecycleState", "Emulation.setFocusEmulationEnabled"] as const)(
    "a failure on %s yields a degraded outcome naming that method and stops issuing further methods",
    async (failOn) => {
      const { client, calls } = makeUnthrottleClient(failOn);
      const outcome = await unthrottlePage(client);
      expect(outcome).toMatchObject({ kind: "degraded", failedMethod: failOn });
      const expectedOrder: CdpMethod[] = [
        "Page.enable",
        "Network.enable",
        "Page.setWebLifecycleState",
        "Emulation.setFocusEmulationEnabled",
      ];
      const failIndex = expectedOrder.indexOf(failOn);
      expect(calls.map((c) => c.method)).toEqual(expectedOrder.slice(0, failIndex + 1));
    },
  );

  test("restore itself reports a degraded outcome when the disable call fails", async () => {
    const alwaysFailingClient: UnthrottleClient = {
      async send(method) {
        throw new Error(`boom on ${method}`);
      },
    };
    const outcome = await unthrottlePage(alwaysFailingClient);
    if (outcome.kind !== "degraded") throw new Error("expected degraded outcome");
    const restoreOutcome = await outcome.restore();
    expect(restoreOutcome).toEqual({ kind: "degraded", failedMethod: "Emulation.setFocusEmulationEnabled" });
  });
});
