import type { ChromeSession } from "./chrome.js";
import type { BrowserFailureReason, SubmissionCertainty } from "../core/schema.js";

const CHATGPT_HOST = "chatgpt.com";

function isAuthOrLoginPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/")
    || pathname === "/login" || pathname.startsWith("/login/");
}

function hasExplicitPort(value: string): boolean {
  const schemeIndex = value.indexOf("://");
  if (schemeIndex === -1) return false;
  let authority = value.slice(schemeIndex + 3);
  const end = authority.search(/[/?#]/);
  if (end !== -1) authority = authority.slice(0, end);
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return hostPort.includes(":");
}

export type ObservedChatgptUrl =
  | { kind: "page"; url: string }
  | { kind: "root" }
  | { kind: "login" }
  | { kind: "invalid" };

export function classifyObservedChatgptUrl(value: unknown): ObservedChatgptUrl {
  if (typeof value !== "string" || value.length === 0) return { kind: "invalid" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.hostname !== CHATGPT_HOST || hasExplicitPort(value)) {
    return { kind: "invalid" };
  }
  if (isAuthOrLoginPath(parsed.pathname)) return { kind: "login" };
  if (parsed.pathname === "" || parsed.pathname === "/") return { kind: "root" };
  return { kind: "page", url: `https://${CHATGPT_HOST}${parsed.pathname}` };
}

export function formatChatgptHandoff(requestId: string, claimToken: string): string {
  return `Use the ChatGPT Consult MCP tools. Call request_get with request_id "${requestId}" and claim_token "${claimToken}", selectively inspect context, then call request_complete.`;
}

export type SanitizePurpose = "configured" | "conversation";

export function sanitizeChatgptUrl(value: unknown, purpose: SanitizePurpose): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname !== CHATGPT_HOST) return null;

  // Detect explicit ports in raw input (URL normalizes default ports away).
  if (hasExplicitPort(value)) return null;

  const pathname = parsed.pathname;

  if (purpose === "conversation") {
    if (!/^\/(?:g\/[A-Za-z0-9_-]+\/)?c\/[A-Za-z0-9_-]+$/.test(pathname)) return null;
    return `https://${CHATGPT_HOST}${pathname}`;
  }

  if (parsed.hash !== "") return null;
  if (!/^\/g\/(?:[A-Za-z0-9_-]+\/project|projects\/[A-Za-z0-9_-]+)$/.test(pathname)) return null;
  return `https://${CHATGPT_HOST}${pathname}`;
}

export const conversationBelongsToProject = (conversationUrl: string, projectUrl: string): boolean => {
  const project = sanitizeChatgptUrl(projectUrl, "configured");
  const conversation = sanitizeChatgptUrl(conversationUrl, "conversation");
  if (project === null || conversation === null) return false;
  const parts = new URL(project).pathname.split("/");
  const projectSegment = parts[2] === "projects" ? parts[3] : parts[2];
  const conversationSegment = /^\/g\/([^/]+)\/c\//.exec(new URL(conversation).pathname)?.[1];
  const identity = (segment: string | undefined) => segment?.match(/^(g-p-[a-f0-9]{32})(?:-|$)/)?.[1] ?? segment;
  return conversationSegment !== undefined && identity(conversationSegment) === identity(projectSegment);
};

export interface BrowserSubmitInput {
  readonly session: ChromeSession;
  readonly targetUrl: string;
  readonly handoff: string;
  readonly requestId: string;
  readonly targetKind: "configured" | "conversation";
}

export interface BrowserAutomationInput {
  readonly session: ChromeSession;
  readonly mode: "submit_and_collect" | "collect_only";
  readonly requestId: string;
  readonly targetUrl: string;
  readonly targetKind: "configured" | "conversation";
  readonly projectUrl?: string;
  readonly prompt: string;
  readonly uploadPaths: readonly string[];
  readonly stagingDirectory: string;
  readonly maximumResponseBytes: number;
}

export interface AuthenticationProbeInput {
  readonly session: ChromeSession;
  readonly projectUrl: string;
  readonly deadlineMs: number;
}

export interface BrowserAutomationHooks {
  beforeSubmission(): Promise<void>;
  submissionConfirmed(conversationUrl: string): Promise<void>;
  heartbeat(): Promise<void>;
  isCancelled(): Promise<boolean>;
  navigationConfirmed?(): Promise<void>;
}

export type BrowserCollectionPath = "event" | "polling" | "event_recovered" | "immediate";

export type BrowserAutomationResult =
  | { kind: "completed"; conversationUrl: string; responseText: string; collectionPath?: BrowserCollectionPath }
  | {
      kind: "recovery";
      phase: "needs_login" | "needs_manual";
      reason: BrowserFailureReason;
      certainty: SubmissionCertainty;
      conversationUrl?: string;
      collectionPath?: BrowserCollectionPath;
      rejectedText?: string;
    };

export type BrowserSubmitResult =
  | { kind: "submitted"; conversationUrl?: string; message?: string }
  | { kind: "opened_manual"; conversationUrl?: string; message?: string }
  | { kind: "unavailable"; message?: string };

const PUBLIC_MESSAGE_LIMIT = 240;

function sanitizePublicMessage(value: unknown, claimToken: string): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/[\x00-\x1f\x7f]/g, " ");
  text = text.replace(/\s+/g, " ");
  if (claimToken.length > 0) {
    text = text.split(claimToken).join("[REDACTED CLAIM]");
  }
  text = text.trim();
  if (text.length > PUBLIC_MESSAGE_LIMIT) {
    text = text.slice(0, PUBLIC_MESSAGE_LIMIT);
  }
  return text.length > 0 ? text : undefined;
}

export interface BrowserSubmitter {
  submit(input: BrowserSubmitInput): Promise<BrowserSubmitResult>;
}

export type LauncherResult =
  | {
      kind: "submitted";
      requestId: string;
      opened: true;
      manual: false;
      conversationUrl?: string;
      message?: string;
    }
  | {
      kind: "opened_manual";
      requestId: string;
      opened: true;
      manual: true;
      handoff: string;
      conversationUrl?: string;
      message?: string;
    }
  | {
      kind: "manual_required";
      requestId: string;
      opened: false;
      manual: true;
      handoff: string;
      message?: string;
    };

export interface ChatgptBrowserLauncherOptions {
  controller: { ensureRunning(): Promise<ChromeSession> };
  primary: BrowserSubmitter;
  fallback: BrowserSubmitter;
  projectUrl?: string;
}

export class ChatgptBrowserLauncher {
  private readonly controller: { ensureRunning(): Promise<ChromeSession> };
  private readonly primary: BrowserSubmitter;
  private readonly fallback: BrowserSubmitter;
  private readonly validatedProjectUrl: string | null;

  constructor(options: ChatgptBrowserLauncherOptions) {
    this.controller = options.controller;
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.validatedProjectUrl = options.projectUrl != null
      ? sanitizeChatgptUrl(options.projectUrl, "configured")
      : null;
  }

  async open(input: {
    requestId: string;
    claimToken: string;
    conversationUrl?: string;
  }): Promise<LauncherResult> {
    const { requestId, claimToken, conversationUrl } = input;

    const { targetUrl, targetKind } = this.resolveTargetWithKind(conversationUrl);
    if (targetUrl === null) {
      return {
        kind: "manual_required",
        requestId,
        opened: false,
        manual: true,
        handoff: formatChatgptHandoff(requestId, claimToken),
      };
    }

    const handoff = formatChatgptHandoff(requestId, claimToken);

    const validatedConversationUrl = conversationUrl != null
      ? sanitizeChatgptUrl(conversationUrl, "conversation")
      : null;

    let session: ChromeSession;
    try {
      session = await this.controller.ensureRunning();
    } catch {
      return {
        kind: "manual_required",
        requestId,
        opened: false,
        manual: true,
        handoff,
        message: "Browser launch unavailable; use the manual handoff.",
      };
    }

    const submitInput: BrowserSubmitInput = {
      session,
      targetUrl,
      handoff,
      requestId,
      targetKind,
    };

    let primaryResult: BrowserSubmitResult;
    try {
      primaryResult = await this.primary.submit(submitInput);
    } catch {
      primaryResult = { kind: "unavailable", message: "Primary submit failed." };
    }

    if (primaryResult.kind === "submitted") {
      return this.buildSubmittedResult(requestId, claimToken, primaryResult, validatedConversationUrl);
    }

    let fallbackResult: BrowserSubmitResult;
    try {
      fallbackResult = await this.fallback.submit(submitInput);
    } catch {
      fallbackResult = { kind: "unavailable", message: "Fallback submit failed." };
    }

    if (fallbackResult.kind === "submitted") {
      return this.buildSubmittedResult(requestId, claimToken, fallbackResult, validatedConversationUrl);
    }

    const anyOpened =
      primaryResult.kind === "opened_manual" || fallbackResult.kind === "opened_manual";

    if (anyOpened) {
      const adapterUrl = this.resolveOpenedManualConversationUrl(
        primaryResult,
        fallbackResult,
        validatedConversationUrl,
      );
      return {
        kind: "opened_manual",
        requestId,
        opened: true,
        manual: true,
        handoff,
        ...(adapterUrl !== null ? { conversationUrl: adapterUrl } : {}),
      };
    }

    return {
      kind: "manual_required",
      requestId,
      opened: false,
      manual: true,
      handoff,
    };
  }

  private resolveTargetWithKind(
    conversationUrl: string | undefined,
  ): { targetUrl: string | null; targetKind: "configured" | "conversation" } {
    if (conversationUrl != null) {
      const sanitized = sanitizeChatgptUrl(conversationUrl, "conversation");
      if (sanitized !== null) return { targetUrl: sanitized, targetKind: "conversation" };
    }
    return { targetUrl: this.validatedProjectUrl, targetKind: "configured" };
  }

  private buildSubmittedResult(
    requestId: string,
    claimToken: string,
    result: Extract<BrowserSubmitResult, { kind: "submitted" }>,
    validatedConversationUrl: string | null,
  ): LauncherResult {
    const candidateUrl = result.conversationUrl != null
      ? sanitizeChatgptUrl(result.conversationUrl, "conversation")
      : null;
    const conversationUrl = candidateUrl ?? validatedConversationUrl;
    const message = sanitizePublicMessage(result.message, claimToken);
    return {
      kind: "submitted",
      requestId,
      opened: true,
      manual: false,
      ...(conversationUrl !== null ? { conversationUrl } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  private resolveOpenedManualConversationUrl(
    primaryResult: BrowserSubmitResult,
    fallbackResult: BrowserSubmitResult,
    validatedConversationUrl: string | null,
  ): string | null {
    const fallbackUrl = fallbackResult.kind === "opened_manual"
      ? sanitizeChatgptUrl(fallbackResult.conversationUrl, "conversation")
      : null;
    if (fallbackUrl !== null) return fallbackUrl;

    const primaryUrl = primaryResult.kind === "opened_manual"
      ? sanitizeChatgptUrl(primaryResult.conversationUrl, "conversation")
      : null;
    if (primaryUrl !== null) return primaryUrl;

    return validatedConversationUrl;
  }
}
