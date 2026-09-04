import { MAX_FRAME_PAYLOAD_BYTES, type CdpMethod, type WebSocketFrameEvent } from "./cdp-page.js";

export type TurnFrameClassification =
  | { kind: "complete" }
  | { kind: "progress"; topicId: string }
  | { kind: "hint" }
  | { kind: "other"; topicId?: string }
  | { kind: "unreadable" };

interface InnerTurnPayload {
  readonly outerType: unknown;
  readonly type: unknown;
  readonly conversationId: unknown;
  readonly topicId: unknown;
}

function extractInnerPayload(entry: unknown): InnerTurnPayload | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const outer = record.payload;
  if (outer === null || typeof outer !== "object") return null;
  const outerRecord = outer as Record<string, unknown>;
  const inner = outerRecord.payload;
  if (inner === null || typeof inner !== "object") return null;
  const innerRecord = inner as Record<string, unknown>;
  return {
    outerType: outerRecord.type,
    type: innerRecord.type,
    conversationId: innerRecord.conversation_id,
    topicId: record.topic_id,
  };
}

const PER_TURN_TOPIC_PREFIX = "conversation-turn-";

export function classifyTurnFrame(
  rawFrameData: string,
  conversationId: string,
  ourTopicId: string | null,
): TurnFrameClassification {
  if (typeof rawFrameData !== "string" || typeof conversationId !== "string" || conversationId.length === 0) {
    return { kind: "unreadable" };
  }
  if (Buffer.byteLength(rawFrameData, "utf8") > MAX_FRAME_PAYLOAD_BYTES) {
    return { kind: "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrameData);
  } catch {
    return { kind: "unreadable" };
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) return { kind: "unreadable" };

  let learnedTopicId = ourTopicId;
  let sawReadable = false;
  let sawProgress = false;
  let sawHint = false;

  try {
    for (const entry of entries) {
      const inner = extractInnerPayload(entry);
      if (inner === null) continue;
      sawReadable = true;
      if (inner.outerType !== "conversation-turn-stream" || inner.conversationId !== conversationId) continue;
      if (typeof inner.topicId !== "string" || !inner.topicId.startsWith(PER_TURN_TOPIC_PREFIX)) continue;
      if (learnedTopicId === null) {
        if (inner.type !== "stream-item") {
          if (inner.type === "done") sawHint = true;
          continue;
        }
        learnedTopicId = inner.topicId;
      }
      if (inner.topicId !== learnedTopicId) {
        if (inner.type === "done") sawHint = true;
        continue;
      }
      if (inner.type === "done") {
        if (ourTopicId !== null) return { kind: "complete" };
        continue;
      }
      if (inner.type === "stream-item") sawProgress = true;
    }
  } catch {
    return { kind: "unreadable" };
  }

  if (sawProgress) return { kind: "progress", topicId: learnedTopicId as string };
  if (sawHint) return { kind: "hint" };
  if (sawReadable) return learnedTopicId === null ? { kind: "other" } : { kind: "other", topicId: learnedTopicId };
  return { kind: "unreadable" };
}

export interface TurnWatchClient {
  onFrame(handler: (frame: WebSocketFrameEvent) => void): () => void;
  onClose(handler: () => void): () => void;
}

export type TurnWatchOutcome =
  | { kind: "complete" }
  | { kind: "deadline_exceeded" }
  | { kind: "connection_lost" };

export interface TurnWatchOptions {
  readonly now?: () => number;
  readonly onProgress?: () => void;
  readonly onHint?: () => void;
}

export async function watchForTurnCompletion(
  client: TurnWatchClient,
  conversationId: string,
  deadlineMs: number,
  options: TurnWatchOptions = {},
): Promise<TurnWatchOutcome> {
  const boundedDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 0;

  return await new Promise<TurnWatchOutcome>((resolve) => {
    let settled = false;
    let unsubscribeFrame = () => {};
    let unsubscribeClose = () => {};

    const finish = (outcome: TurnWatchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeFrame();
      unsubscribeClose();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: "deadline_exceeded" }), boundedDeadlineMs);

    let ourTopicId: string | null = null;
    unsubscribeFrame = client.onFrame((frame) => {
      const classification = classifyTurnFrame(frame.payloadData, conversationId, ourTopicId);
      if (classification.kind === "complete") {
        finish({ kind: "complete" });
        return;
      }
      if (ourTopicId === null && "topicId" in classification && classification.topicId !== undefined) {
        ourTopicId = classification.topicId;
      }
      if (classification.kind === "progress") {
        options.onProgress?.();
      }
      if (classification.kind === "hint") {
        options.onHint?.();
      }
    });
    if (settled) {
      unsubscribeFrame();
    }

    unsubscribeClose = client.onClose(() => finish({ kind: "connection_lost" }));
  });
}

export interface UnthrottleClient {
  send(method: CdpMethod, params?: Record<string, unknown>): Promise<unknown>;
}

export type UnthrottleRestoreOutcome =
  | { kind: "restored" }
  | { kind: "degraded"; failedMethod: CdpMethod };

export type UnthrottleOutcome =
  | { kind: "ready"; restore: () => Promise<UnthrottleRestoreOutcome> }
  | { kind: "degraded"; failedMethod: CdpMethod; restore: () => Promise<UnthrottleRestoreOutcome> };

async function restoreFocusEmulation(client: UnthrottleClient): Promise<UnthrottleRestoreOutcome> {
  try {
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    return { kind: "restored" };
  } catch {
    return { kind: "degraded", failedMethod: "Emulation.setFocusEmulationEnabled" };
  }
}

export async function unthrottlePage(client: UnthrottleClient): Promise<UnthrottleOutcome> {
  const restore = () => restoreFocusEmulation(client);

  try {
    await client.send("Page.enable", {});
  } catch {
    return { kind: "degraded", failedMethod: "Page.enable", restore };
  }
  try {
    await client.send("Network.enable", {});
  } catch {
    return { kind: "degraded", failedMethod: "Network.enable", restore };
  }
  try {
    await client.send("Page.setWebLifecycleState", { state: "active" });
  } catch {
    return { kind: "degraded", failedMethod: "Page.setWebLifecycleState", restore };
  }
  try {
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch {
    return { kind: "degraded", failedMethod: "Emulation.setFocusEmulationEnabled", restore };
  }

  return { kind: "ready", restore };
}
