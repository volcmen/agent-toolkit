import { sanitizeChatgptUrl, type BrowserSubmitInput, type BrowserSubmitResult, type BrowserSubmitter } from "./handoff.js";

const DEFAULT_DEADLINE_MS = 15_000;
const POLL_DELAY_MS = 100;
const MAX_NODES_PER_SELECTOR = 8;

const SELECTORS = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  "textarea",
] as const;

const USER_MSG_SELECTOR = '[data-message-author-role="user"]';

const MSG_UNAVAILABLE_RUNTIME = "WebView runtime is not available.";
const MSG_UNAVAILABLE_TARGET = "Target URL is not a valid ChatGPT endpoint.";
const MSG_UNAVAILABLE_CREATE = "Browser view could not be created.";
const MSG_MANUAL_PROMPT = "Prompt area not found.";
const MSG_MANUAL_SUBMISSION = "Submission could not complete.";

interface MinimalView {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

type ViewFactory = (options: {
  backend: { type: "chrome"; url: string };
  url: string;
}) => MinimalView;

export interface WebViewSubmitterOptions {
  webViewFactory?: ViewFactory | null | undefined;
  deadlineMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

function detectWebView(): boolean {
  try {
    return typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
      && typeof ((globalThis as Record<string, unknown>).Bun as Record<string, unknown>)?.WebView === "function";
  } catch {
    return false;
  }
}

function defaultViewFactory(session: { webSocketUrl: string }, canonicalUrl: string): MinimalView {
  const BunGlobal = globalThis as Record<string, unknown>;
  const BunNS = BunGlobal.Bun as Record<string, unknown>;
  const WebViewClass = BunNS.WebView as new (options: Record<string, unknown>) => MinimalView;
  return new WebViewClass({
    backend: { type: "chrome", url: session.webSocketUrl },
    url: canonicalUrl,
  });
}

function defaultWait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class WebViewSubmitter implements BrowserSubmitter {
  private readonly factory: ViewFactory | null | undefined;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(options?: WebViewSubmitterOptions) {
    const deadline = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0) {
      throw new TypeError("deadlineMs must be a positive finite number");
    }
    if (options?.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (options?.wait !== undefined && typeof options.wait !== "function") {
      throw new TypeError("wait must be a function");
    }
    this.deadlineMs = deadline;
    this.factory = options?.webViewFactory;
    this.now = options?.now ?? performance.now.bind(performance);
    this.wait = options?.wait ?? defaultWait;
  }

  async submit(input: BrowserSubmitInput): Promise<BrowserSubmitResult> {
    if (this.factory === null) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_RUNTIME };
    }
    if (this.factory === undefined && !detectWebView()) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_RUNTIME };
    }

    const canonicalUrl = sanitizeChatgptUrl(input.targetUrl, input.targetKind);
    if (canonicalUrl === null) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_TARGET };
    }

    const deadline = this.now() + this.deadlineMs;

    let view: MinimalView;
    try {
      view = this.factory !== undefined
        ? this.factory({
          backend: { type: "chrome", url: input.session.webSocketUrl },
          url: canonicalUrl,
        })
        : defaultViewFactory(input.session, canonicalUrl);
    } catch {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_CREATE };
    }

    try {
      return await this.performSubmission(view, input, deadline, canonicalUrl);
    } catch {
      return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
    } finally {
      try {
        view.close();
      } catch {
        // Swallow close failure exactly once
      }
    }
  }

  private async performSubmission(
    view: MinimalView,
    input: BrowserSubmitInput,
    deadline: number,
    canonicalUrl: string,
  ): Promise<BrowserSubmitResult> {
    await this.safeCdp(view, "DOM.enable", {}, deadline);
    await this.safeCdp(view, "Page.enable", {}, deadline);

    const preNavUrl = await this.readCurrentUrl(view, deadline);
    if (preNavUrl === null) {
      return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
    }

    const candidate = await this.pollForCandidate(view, deadline);
    if (candidate === null) {
      return { kind: "unavailable", message: MSG_MANUAL_PROMPT };
    }

    const baselineCount = await this.countUserMessages(view, deadline);
    if (baselineCount === null) {
      return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
    }

    const preMutUrl = await this.readCurrentUrl(view, deadline);
    if (preMutUrl === null || preMutUrl !== preNavUrl) {
      return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
    }

    await this.safeCdp(view, "DOM.focus", { nodeId: candidate }, deadline);
    await this.safeCdp(view, "Input.insertText", { text: input.handoff }, deadline);
    await this.safeCdp(view, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    }, deadline);
    await this.safeCdp(view, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    }, deadline);

    const confirmation = await this.pollForConfirmation(
      view, input, deadline, preMutUrl, baselineCount,
    );

    if (confirmation.confirmed) {
      if (confirmation.conversationUrl !== undefined) {
        return { kind: "submitted", conversationUrl: confirmation.conversationUrl };
      }
      return { kind: "submitted" };
    }
    return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
  }

  private async safeCdp(
    view: MinimalView,
    method: string,
    params: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown> {
    if (this.now() >= deadline) {
      throw new Error("deadline");
    }
    const raw = view.cdp(method, params);
    void raw.catch(() => {});
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      throw new Error("deadline");
    }
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error("deadline")), remaining);
    });
    try {
      const result = await Promise.race([raw, timeout]);
      if (this.now() >= deadline) {
        throw new Error("deadline");
      }
      return result;
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  }

  private async pollForCandidate(view: MinimalView, deadline: number): Promise<number | null> {
    for (;;) {
      if (this.now() >= deadline) return null;
      const candidates = new Set<number>();
      for (const selector of SELECTORS) {
        if (this.now() >= deadline) return null;
        const nodeId = await this.findUniqueEditableVisibleNode(view, selector, deadline);
        if (nodeId === "ambiguous") return null;
        if (nodeId !== null) candidates.add(nodeId);
        if (candidates.size > 1) return null;
      }
      if (candidates.size === 1) return [...candidates][0]!;
      const remaining = deadline - this.now();
      if (remaining <= 0) return null;
      const delay = Math.min(POLL_DELAY_MS, remaining);
      if (!Number.isFinite(delay) || delay <= 0) return null;
      await this.wait(delay);
      if (this.now() >= deadline) return null;
    }
  }

  private async findUniqueEditableVisibleNode(
    view: MinimalView,
    selector: string,
    deadline: number,
  ): Promise<number | "ambiguous" | null> {
    let nodeIds: number[];
    try {
      const docResult = await this.safeCdp(view, "DOM.getDocument", {}, deadline) as {
        root: { nodeId: number };
      };
      const queryResult = await this.safeCdp(view, "DOM.querySelectorAll", {
        nodeId: docResult.root.nodeId,
        selector,
      }, deadline) as { nodeIds: number[] };
      nodeIds = queryResult.nodeIds;
      if (!Array.isArray(nodeIds)) return null;
    } catch {
      return null;
    }

    if (nodeIds.length > MAX_NODES_PER_SELECTOR) return "ambiguous";
    const candidates: number[] = [];
    const capped = nodeIds.slice(0, MAX_NODES_PER_SELECTOR);
    for (const nodeId of capped) {
      if (this.now() >= deadline) return null;
      try {
        const descResult = await this.safeCdp(view, "DOM.describeNode", { nodeId }, deadline) as {
          node: { nodeName: string; attributes?: string[] };
        };
        if (!isEditable(descResult.node)) continue;

        const boxResult = await this.safeCdp(view, "DOM.getBoxModel", { nodeId }, deadline) as {
          model: { width: number; height: number };
        };
        if (!isVisible(boxResult.model)) continue;

        candidates.push(nodeId);
        if (candidates.length > 1) return "ambiguous";
      } catch {
        continue;
      }
    }
    return candidates[0] ?? null;
  }

  private async readCurrentUrl(
    view: MinimalView,
    deadline: number,
  ): Promise<string | null> {
    try {
      const result = await this.safeCdp(view, "Page.getFrameTree", {}, deadline) as {
        frameTree?: { frame?: { url?: unknown } };
      };
      const rawUrl = result?.frameTree?.frame?.url;
      if (typeof rawUrl !== "string") return null;
      const sanitized = sanitizeChatgptUrl(rawUrl, "conversation") ?? sanitizeChatgptUrl(rawUrl, "configured");
      if (sanitized === null) return null;
      return sanitized;
    } catch {
      return null;
    }
  }

  private async countUserMessages(
    view: MinimalView,
    deadline: number,
  ): Promise<number | null> {
    try {
      const docResult = await this.safeCdp(view, "DOM.getDocument", {}, deadline) as {
        root: { nodeId: number };
      };
      const queryResult = await this.safeCdp(view, "DOM.querySelectorAll", {
        nodeId: docResult.root.nodeId,
        selector: USER_MSG_SELECTOR,
      }, deadline) as { nodeIds: number[] };
      if (!Array.isArray(queryResult?.nodeIds)) return null;
      return queryResult.nodeIds.length;
    } catch {
      return null;
    }
  }

  private async pollForConfirmation(
    view: MinimalView,
    input: BrowserSubmitInput,
    deadline: number,
    preMutUrl: string,
    baselineCount: number,
  ): Promise<{ confirmed: boolean; conversationUrl?: string }> {
    for (;;) {
      if (this.now() >= deadline) return { confirmed: false };

      const currentUrl = await this.readCurrentUrl(view, deadline);
      if (currentUrl === null) return { confirmed: false };

      if (input.targetKind === "configured" && currentUrl !== preMutUrl) {
        return { confirmed: true, conversationUrl: currentUrl };
      }

      const count = await this.countUserMessages(view, deadline);
      if (count === null) return { confirmed: false };
      if (count > baselineCount) {
        if (input.targetKind === "configured" && currentUrl === preMutUrl) {
          return { confirmed: true };
        }
        if (input.targetKind === "conversation") {
          return { confirmed: true, conversationUrl: currentUrl };
        }
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) return { confirmed: false };
      const delay = Math.min(POLL_DELAY_MS, remaining);
      if (!Number.isFinite(delay) || delay <= 0) return { confirmed: false };
      await this.wait(delay);
    }
  }
}

function isEditable(node: { nodeName: string; attributes?: string[] }): boolean {
  const attrs = node.attributes ?? [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === "aria-disabled" && attrs[i + 1] === "true") return false;
  }

  if (node.nodeName === "TEXTAREA") {
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === "disabled") return false;
      if (attrs[i] === "readonly") return false;
    }
    return true;
  }

  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === "contenteditable") {
      const val = attrs[i + 1];
      if (val === "true" || val === "plaintext-only") return true;
    }
  }
  return false;
}

function isVisible(model: { width: number; height: number }): boolean {
  return Number.isFinite(model.width) && Number.isFinite(model.height)
    && model.width > 0 && model.height > 0;
}
