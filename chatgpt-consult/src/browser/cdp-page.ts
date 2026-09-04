import { ConsultError } from "../core/errors.js";

const LOOPBACK_HOST = "127.0.0.1";
const TARGET_ID_RE = /^[A-Fa-f0-9]{32}$/;

export const DEFAULT_COMMAND_DEADLINE_MS = 5_000;
export const DEFAULT_CONNECTION_DEADLINE_MS = 30_000;
export const MAX_FRAME_PAYLOAD_BYTES = 262_144;
export const MAX_BUFFERED_FRAMES = 256;
export const MAX_INCOMING_MESSAGE_BYTES = 1_048_576;

export type CdpMethod =
  | "Page.enable"
  | "Network.enable"
  | "Page.setWebLifecycleState"
  | "Emulation.setFocusEmulationEnabled";

export const ALLOWED_CDP_METHODS: readonly CdpMethod[] = [
  "Page.enable",
  "Network.enable",
  "Page.setWebLifecycleState",
  "Emulation.setFocusEmulationEnabled",
];

const ALLOWED_METHOD_SET: ReadonlySet<string> = new Set(ALLOWED_CDP_METHODS);

export interface WebSocketFrameEvent {
  readonly payloadData: string;
}

export interface MinimalSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "open" | "close", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: string }) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type SocketFactory = (url: string) => MinimalSocket;

function defaultSocketFactory(url: string): MinimalSocket {
  return new WebSocket(url) as unknown as MinimalSocket;
}

export function buildCdpPageUrl(port: unknown, targetId: unknown): string | null {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  if (typeof targetId !== "string" || !TARGET_ID_RE.test(targetId)) {
    return null;
  }
  return `ws://${LOOPBACK_HOST}:${port}/devtools/page/${targetId}`;
}

export interface CdpPageClientOptions {
  readonly port: number;
  readonly targetId: string;
  readonly socketFactory?: SocketFactory;
  readonly commandDeadlineMs?: number;
  readonly connectionDeadlineMs?: number;
  readonly now?: () => number;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpPageClient {
  private readonly url: string;
  private readonly socketFactory: SocketFactory;
  private readonly now: () => number;
  private readonly commandDeadlineMs: number;
  private readonly connectionDeadline: number;

  private socket: MinimalSocket | null = null;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private droppedFrameCount = 0;

  private readonly pending = new Map<number, PendingCommand>();
  private readonly frameHandlers = new Set<(frame: WebSocketFrameEvent) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private frameQueue: string[] = [];

  private readonly onMessageEvent = (event: { data: string }) => this.handleMessage(event.data);
  private readonly onCloseEvent = () => this.handleClose();

  constructor(options: CdpPageClientOptions) {
    const url = buildCdpPageUrl(options.port, options.targetId);
    if (url === null) {
      throw new ConsultError("INVALID_INPUT", "CDP page target is not a valid loopback page endpoint");
    }
    this.url = url;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? Date.now;

    const commandDeadlineMs = options.commandDeadlineMs ?? DEFAULT_COMMAND_DEADLINE_MS;
    if (!Number.isFinite(commandDeadlineMs) || commandDeadlineMs <= 0) {
      throw new ConsultError("INVALID_INPUT", "CDP command deadline must be a positive finite number");
    }
    this.commandDeadlineMs = commandDeadlineMs;

    const connectionDeadlineMs = options.connectionDeadlineMs ?? DEFAULT_CONNECTION_DEADLINE_MS;
    if (!Number.isFinite(connectionDeadlineMs) || connectionDeadlineMs <= 0) {
      throw new ConsultError("INVALID_INPUT", "CDP connection deadline must be a positive finite number");
    }
    this.connectionDeadline = this.now() + connectionDeadlineMs;
  }

  get droppedFrames(): number {
    return this.droppedFrameCount;
  }

  get bufferedFrames(): number {
    return this.frameQueue.length;
  }

  get frameHandlerCount(): number {
    return this.frameHandlers.size;
  }

  resetBufferedFrames(): void {
    this.frameQueue = [];
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new ConsultError("UNAVAILABLE", "CDP connection is closed");
    }
    if (this.socket !== null) {
      throw new ConsultError("INVALID_INPUT", "CDP connection is already established");
    }
    const remainingMs = this.connectionDeadline - this.now();
    if (remainingMs <= 0) {
      throw new ConsultError("EXPIRED", "CDP connection deadline has already elapsed");
    }

    const socket = this.socketFactory(this.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        this.teardown();
        reject(new ConsultError("EXPIRED", "CDP connection did not open before its deadline"));
      }, remainingMs);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        this.ready = true;
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        this.teardown();
        reject(new ConsultError("UNAVAILABLE", "CDP connection failed to open"));
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("message", this.onMessageEvent);
      socket.addEventListener("close", this.onCloseEvent);
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!ALLOWED_METHOD_SET.has(method)) {
      throw new ConsultError("INVALID_INPUT", "CDP method is not on the allowlist", { method });
    }
    if (this.closed) {
      throw new ConsultError("UNAVAILABLE", "CDP connection is closed");
    }
    if (!this.ready || this.socket === null) {
      throw new ConsultError("UNAVAILABLE", "CDP connection is not open");
    }

    const commandDeadline = Math.min(this.now() + this.commandDeadlineMs, this.connectionDeadline);
    const remainingMs = commandDeadline - this.now();
    if (remainingMs <= 0) {
      throw new ConsultError("EXPIRED", "CDP connection deadline has already elapsed");
    }

    const id = this.nextId;
    this.nextId += 1;
    const socket = this.socket;

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConsultError("EXPIRED", "CDP command exceeded its deadline", { method }));
      }, remainingMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ConsultError("UNAVAILABLE", "CDP command could not be sent", { method }));
      }
    });
  }

  onFrame(handler: (frame: WebSocketFrameEvent) => void): () => void {
    for (const payloadData of this.frameQueue) {
      try {
        handler({ payloadData });
      } catch {}
    }
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    if (this.closed) {
      queueMicrotask(handler);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
  }

  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket !== null) {
      try {
        socket.removeEventListener("message", this.onMessageEvent);
        socket.removeEventListener("close", this.onCloseEvent);
        socket.close();
      } catch {}
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ConsultError("UNAVAILABLE", "CDP connection closed"));
    }
    this.pending.clear();
    this.frameHandlers.clear();
    this.frameQueue = [];

    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) {
      try {
        handler();
      } catch {}
    }
  }

  private handleMessage(raw: string): void {
    if (this.closed) return;
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_INCOMING_MESSAGE_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const value = parsed as Record<string, unknown>;
    if (typeof value.id === "number") {
      this.resolveCommand(value.id, value);
      return;
    }
    if (value.method === "Network.webSocketFrameReceived") {
      this.handleFrame(value.params);
    }
  }

  private resolveCommand(id: number, value: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in value) {
      pending.reject(new ConsultError("UNAVAILABLE", "CDP command returned an error"));
      return;
    }
    pending.resolve(value.result);
  }

  private handleFrame(rawParams: unknown): void {
    if (rawParams === null || typeof rawParams !== "object") return;
    const response = (rawParams as Record<string, unknown>).response;
    if (response === null || typeof response !== "object") return;
    const payloadData = (response as Record<string, unknown>).payloadData;
    if (typeof payloadData !== "string") return;
    if (Buffer.byteLength(payloadData, "utf8") > MAX_FRAME_PAYLOAD_BYTES) {
      this.droppedFrameCount += 1;
      return;
    }
    if (this.frameQueue.length >= MAX_BUFFERED_FRAMES) {
      this.frameQueue.shift();
      this.droppedFrameCount += 1;
    }
    this.frameQueue.push(payloadData);
    const frame: WebSocketFrameEvent = { payloadData };
    for (const handler of this.frameHandlers) {
      try {
        handler(frame);
      } catch {}
    }
  }
}
