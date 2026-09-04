import { describe, expect, test } from "bun:test";
import {
  ALLOWED_CDP_METHODS,
  CdpPageClient,
  MAX_BUFFERED_FRAMES,
  MAX_FRAME_PAYLOAD_BYTES,
  buildCdpPageUrl,
  type MinimalSocket,
} from "../src/browser/cdp-page";
import { ConsultError } from "../src/core/errors";

const VALID_TARGET_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

type Listener = (event: never) => void;

class FakeSocket implements MinimalSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  emitOpen(): void {
    for (const listener of [...(this.listeners.get("open") ?? [])]) listener(undefined as never);
  }

  emitError(): void {
    for (const listener of [...(this.listeners.get("error") ?? [])]) listener(undefined as never);
  }

  emitClose(): void {
    for (const listener of [...(this.listeners.get("close") ?? [])]) listener(undefined as never);
  }

  emitMessage(data: string): void {
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener({ data } as never);
  }
}

function connectedClient(overrides: Record<string, unknown> = {}) {
  const socket = new FakeSocket();
  const client = new CdpPageClient({
    port: 9222,
    targetId: VALID_TARGET_ID,
    socketFactory: () => socket,
    ...overrides,
  } as never);
  return { socket, client };
}

async function connectImmediately(overrides: Record<string, unknown> = {}) {
  const { socket, client } = connectedClient(overrides);
  const connecting = client.connect();
  socket.emitOpen();
  await connecting;
  return { socket, client };
}

function frameMessage(payloadData: string): string {
  return JSON.stringify({
    method: "Network.webSocketFrameReceived",
    params: { requestId: "1", timestamp: 1, response: { opcode: 1, mask: false, payloadData } },
  });
}

describe("buildCdpPageUrl", () => {
  test("builds a loopback devtools page url for a valid port and target id", () => {
    expect(buildCdpPageUrl(9222, VALID_TARGET_ID)).toBe(`ws://127.0.0.1:9222/devtools/page/${VALID_TARGET_ID}`);
  });

  test.each([
    ["port zero", 0, VALID_TARGET_ID],
    ["negative port", -1, VALID_TARGET_ID],
    ["port above range", 65_536, VALID_TARGET_ID],
    ["non-integer port", 9222.5, VALID_TARGET_ID],
    ["non-numeric port", "9222", VALID_TARGET_ID],
    ["target id too short", 9222, "a1b2c3"],
    ["target id too long", 9222, `${VALID_TARGET_ID}a`],
    ["target id with non-hex chars", 9222, "z1b2c3d4e5f60718293a4b5c6d7e8f90"],
    ["empty target id", 9222, ""],
    ["non-string target id", 9222, 12],
    ["target id with path traversal", 9222, "../../etc/passwd0000000000000000"],
  ])("rejects %s", (_name, port, targetId) => {
    expect(buildCdpPageUrl(port as never, targetId as never)).toBeNull();
  });
});

describe("CdpPageClient method allowlist", () => {
  test.each([...ALLOWED_CDP_METHODS])("allows sending %s", async (method) => {
    const { socket, client } = await connectImmediately();
    const pending = client.send(method, {});
    const request = JSON.parse(socket.sent[0]!);
    socket.emitMessage(JSON.stringify({ id: request.id, result: {} }));
    await expect(pending).resolves.toEqual({});
    client.close();
  });

  test.each([
    "Runtime.evaluate",
    "Network.getResponseBody",
    "Network.getRequestPostData",
    "Network.getAllCookies",
    "Storage.getCookies",
    "Storage.clearCookies",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.navigate",
    "Page.bringToFront",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "DOM.getDocument",
    "DOM.querySelectorAll",
  ])("rejects forbidden method %s without sending it", async (method) => {
    const { socket, client } = await connectImmediately();
    await expect(client.send(method, {})).rejects.toThrow(ConsultError);
    expect(socket.sent).toEqual([]);
    client.close();
  });

  test("forbidden method rejection carries INVALID_INPUT code", async () => {
    const { client } = await connectImmediately();
    try {
      await client.send("Runtime.evaluate", {});
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsultError);
      expect((error as ConsultError).code).toBe("INVALID_INPUT");
    }
    client.close();
  });
});

describe("CdpPageClient deadlines", () => {
  test("per-command deadline rejects with EXPIRED and does not leak the pending entry", async () => {
    const { client } = await connectImmediately({ commandDeadlineMs: 20 });
    const start = performance.now();
    await expect(client.send("Page.enable", {})).rejects.toMatchObject({ code: "EXPIRED" });
    expect(performance.now() - start).toBeLessThan(3000);
    client.close();
  });

  test("overall connection deadline rejects a late send synchronously without sending", async () => {
    const { socket, client } = await connectImmediately({ connectionDeadlineMs: 5, commandDeadlineMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(client.send("Page.enable", {})).rejects.toMatchObject({ code: "EXPIRED" });
    expect(socket.sent).toEqual([]);
    client.close();
  });

  test("connect rejects once the connection deadline has already elapsed", async () => {
    const { client } = connectedClient({ connectionDeadlineMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(client.connect()).rejects.toMatchObject({ code: "EXPIRED" });
  });

  test("connect that never opens is bounded by a real timeout", async () => {
    const { client } = connectedClient({ connectionDeadlineMs: 50 });
    const start = performance.now();
    await expect(client.connect()).rejects.toMatchObject({ code: "EXPIRED" });
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe("CdpPageClient connection loss", () => {
  test("a command pending when the socket closes rejects with UNAVAILABLE", async () => {
    const { socket, client } = await connectImmediately({ commandDeadlineMs: 10_000 });
    const pending = client.send("Page.enable", {});
    socket.emitClose();
    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("sending after the socket closes is rejected without touching the socket again", async () => {
    const { socket, client } = await connectImmediately();
    socket.emitClose();
    await expect(client.send("Page.enable", {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(socket.sent).toEqual([]);
  });

  test("onClose fires exactly once when the socket errors during an open connection", async () => {
    const { socket, client } = await connectImmediately();
    let closeCount = 0;
    client.onClose(() => { closeCount += 1; });
    socket.emitClose();
    socket.emitClose();
    expect(closeCount).toBe(1);
  });
});

describe("CdpPageClient close()", () => {
  test("close is idempotent and never throws", async () => {
    const { client } = await connectImmediately();
    expect(() => client.close()).not.toThrow();
    expect(() => client.close()).not.toThrow();
    expect(() => client.close()).not.toThrow();
  });

  test("close removes the message and close listeners from the socket", async () => {
    const { socket, client } = await connectImmediately();
    expect(socket.listenerCount("message")).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);
    client.close();
    expect(socket.listenerCount("message")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  test("close rejects every pending command exactly once with no leaked listeners", async () => {
    const { socket, client } = await connectImmediately({ commandDeadlineMs: 10_000 });
    const first = client.send("Page.enable", {});
    const second = client.send("Network.enable", {});
    void first.catch(() => {});
    void second.catch(() => {});
    client.close();
    await expect(first).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(socket.listenerCount("message")).toBe(0);
  });

  test("repeated command timeouts never grow the socket listener count", async () => {
    const { socket, client } = await connectImmediately({ commandDeadlineMs: 15 });
    await expect(client.send("Page.enable", {})).rejects.toMatchObject({ code: "EXPIRED" });
    await expect(client.send("Network.enable", {})).rejects.toMatchObject({ code: "EXPIRED" });
    await expect(client.send("Page.setWebLifecycleState", {})).rejects.toMatchObject({ code: "EXPIRED" });
    expect(socket.listenerCount("message")).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);
    client.close();
  });
});

describe("CdpPageClient frame bounds", () => {
  test("drops an oversized frame payload without invoking handlers", async () => {
    const { socket, client } = await connectImmediately();
    const received: string[] = [];
    client.onFrame((frame) => received.push(frame.payloadData));
    socket.emitMessage(frameMessage("x".repeat(MAX_FRAME_PAYLOAD_BYTES + 1)));
    expect(received).toEqual([]);
    expect(client.droppedFrames).toBe(1);
    expect(client.bufferedFrames).toBe(0);
    client.close();
  });

  test("accepts a frame payload at exactly the size cap", async () => {
    const { socket, client } = await connectImmediately();
    const received: string[] = [];
    client.onFrame((frame) => received.push(frame.payloadData));
    const exact = "y".repeat(MAX_FRAME_PAYLOAD_BYTES);
    socket.emitMessage(frameMessage(exact));
    expect(received).toEqual([exact]);
    expect(client.droppedFrames).toBe(0);
    client.close();
  });

  test("drops the oldest frame once the buffer is full and keeps the most recent ones", async () => {
    const { socket, client } = await connectImmediately();
    const total = MAX_BUFFERED_FRAMES + 5;
    for (let i = 0; i < total; i += 1) {
      socket.emitMessage(frameMessage(`frame-${i}`));
    }
    expect(client.bufferedFrames).toBe(MAX_BUFFERED_FRAMES);
    expect(client.droppedFrames).toBe(5);

    const replayed: string[] = [];
    client.onFrame((frame) => replayed.push(frame.payloadData));
    expect(replayed[0]).toBe("frame-5");
    expect(replayed[replayed.length - 1]).toBe(`frame-${total - 1}`);
    client.close();
  });

  test("a handler registered after frames arrive is replayed once, then receives live frames without duplication", async () => {
    const { socket, client } = await connectImmediately();
    socket.emitMessage(frameMessage("backlog-1"));
    socket.emitMessage(frameMessage("backlog-2"));

    const received: string[] = [];
    client.onFrame((frame) => received.push(frame.payloadData));
    expect(received).toEqual(["backlog-1", "backlog-2"]);

    socket.emitMessage(frameMessage("live-1"));
    expect(received).toEqual(["backlog-1", "backlog-2", "live-1"]);
    client.close();
  });

  test("unsubscribing a frame handler stops further delivery", async () => {
    const { socket, client } = await connectImmediately();
    const received: string[] = [];
    const unsubscribe = client.onFrame((frame) => received.push(frame.payloadData));
    socket.emitMessage(frameMessage("one"));
    unsubscribe();
    socket.emitMessage(frameMessage("two"));
    expect(received).toEqual(["one"]);
    client.close();
  });
});

describe("CdpPageClient redaction discipline", () => {
  test("no thrown error or command rejection ever contains frame payload content or token-shaped substrings", async () => {
    const secretToken = `eyJ${"a".repeat(40)}.secretpayload.signature`;
    const secretQuery = "verify=1234567890-deadbeefsignature";
    const { socket, client } = await connectImmediately({ commandDeadlineMs: 15 });

    socket.emitMessage(frameMessage(`wss://ws.chatgpt.com/p27/ws/user/user-1?${secretQuery} token=${secretToken}`));

    const observations: unknown[] = [];
    try {
      await client.send("Runtime.evaluate", {});
    } catch (error) {
      observations.push(error);
    }
    try {
      await client.send("Page.enable", {});
    } catch (error) {
      observations.push(error);
    }
    socket.emitClose();
    try {
      await client.send("Network.enable", {});
    } catch (error) {
      observations.push(error);
    }

    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      const serialized = `${(observation as Error).message} ${JSON.stringify(observation)}`;
      expect(serialized).not.toContain(secretToken);
      expect(serialized).not.toContain(secretQuery);
      expect(serialized).not.toContain("eyJ");
    }
    client.close();
  });
});

describe("CdpPageClient construction", () => {
  test("rejects an invalid target immediately without a socket factory call", () => {
    let called = false;
    expect(() => new CdpPageClient({
      port: 9222,
      targetId: "not-a-target-id",
      socketFactory: () => { called = true; return new FakeSocket(); },
    })).toThrow(ConsultError);
    expect(called).toBe(false);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
  ])("rejects a %s command deadline", (_name, commandDeadlineMs) => {
    expect(() => new CdpPageClient({
      port: 9222,
      targetId: VALID_TARGET_ID,
      commandDeadlineMs,
    })).toThrow(ConsultError);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
  ])("rejects a %s connection deadline", (_name, connectionDeadlineMs) => {
    expect(() => new CdpPageClient({
      port: 9222,
      targetId: VALID_TARGET_ID,
      connectionDeadlineMs,
    })).toThrow(ConsultError);
  });
});
