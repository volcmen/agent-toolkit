import { describe, expect, test } from "bun:test";
import type { BrowserSubmitInput } from "../src/browser/handoff";
import type { ChromeSession } from "../src/browser/chrome";

const SESSION: ChromeSession = {
  pid: 1,
  port: 9222,
  webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
  profileDir: "/tmp/profile",
  ownership: "owned",
  visibility: "headless",
  reused: false,
};

const HANDOFF = `Use the ChatGPT Consult MCP tools. Call request_get with request_id "req_01" and claim_token "claim_abc", selectively inspect context, then call request_complete.`;
const PROJECT_URL = "https://chatgpt.com/g/projects/aaa-bbb-ccc";
const CONVERSATION_URL = "https://chatgpt.com/c/abc-123";

function makeInput(overrides?: Partial<BrowserSubmitInput>): BrowserSubmitInput {
  return {
    session: SESSION,
    targetUrl: PROJECT_URL,
    handoff: HANDOFF,
    requestId: "req_01",
    targetKind: "configured",
    ...overrides,
  };
}

interface CdpCall {
  method: string;
  params: Record<string, unknown> | undefined;
}

interface FakeViewOptions {
  cdpResponses?: Map<string, unknown>;
  selectorNodes?: Map<string, number[]>;
  describeResults?: Map<number, { nodeName: string; attributes?: string[] }>;
  boxModels?: Map<number, { width: number; height: number } | null>;
  frameUrl?: string | null;
  frameUrls?: string[];
  userMessageCounts?: number[];
  malformedBaseline?: boolean;
  closeThrows?: boolean;
  hangMethod?: string;
  describeThrows?: Set<number>;
  confirmSubmission?: boolean;
  repeatLast?: boolean;
  now?: () => number;
}

function createFakeView(opts: FakeViewOptions = {}) {
  const cdpCalls: CdpCall[] = [];
  const cdpCallTimes: number[] = [];
  let closeCount = 0;
  let insertTextCalled = false;
  const confirmSubmission = opts.confirmSubmission !== false;

  const describeResults = opts.describeResults ?? new Map();
  const boxModels = opts.boxModels ?? new Map();
  const describeThrows = opts.describeThrows ?? new Set();

  const defaultResponses = new Map<string, unknown>([
    ["DOM.enable", {}],
    ["Page.enable", {}],
    ["DOM.getDocument", { root: { nodeId: 1 } }],
  ]);
  const cdpResponses = opts.cdpResponses ?? defaultResponses;
  const hangMethod = opts.hangMethod;

  let frameUrlIdx = 0;
  let userMsgIdx = 0;

  const view = {
    cdpCalls,
    cdpCallTimes,
    closeCount: () => closeCount,
    async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
      cdpCalls.push({ method, params });
      if (opts.now !== undefined) cdpCallTimes.push(opts.now());
      if (hangMethod === method) {
        return new Promise(() => {});
      }
      if (method === "DOM.querySelectorAll") {
        const selector = params?.selector as string;
        if (selector === '[data-message-author-role="user"]') {
          if (opts.malformedBaseline) return { nodeIds: "not-a-number" } as unknown as { nodeIds: number[] };
          if (opts.userMessageCounts !== undefined) {
            if (opts.userMessageCounts.length === 0) return { nodeIds: "malformed" } as unknown as { nodeIds: number[] };
            if (userMsgIdx >= opts.userMessageCounts.length) {
              if (opts.repeatLast) {
                const count = opts.userMessageCounts[opts.userMessageCounts.length - 1];
                return { nodeIds: new Array(count).fill(0) };
              }
              return { nodeIds: "malformed" } as unknown as { nodeIds: number[] };
            }
            return { nodeIds: new Array(opts.userMessageCounts[userMsgIdx++]).fill(0) };
          }
          return { nodeIds: confirmSubmission && insertTextCalled ? [100] : [] };
        }
        const nodes = opts.selectorNodes?.get(selector) ?? [];
        return { nodeIds: nodes };
      }
      if (method === "DOM.describeNode") {
        const nodeId = params?.nodeId as number;
        if (describeThrows.has(nodeId)) throw new Error("stale node");
        const info = describeResults.get(nodeId);
        if (info) {
          return {
            node: { nodeId, nodeName: info.nodeName, attributes: info.attributes ?? [] },
          };
        }
        return { node: { nodeId, nodeName: "DIV", attributes: [] } };
      }
      if (method === "DOM.getBoxModel") {
        const nodeId = params?.nodeId as number;
        const model = boxModels.get(nodeId);
        if (model === null || model === undefined) throw new Error("no box model");
        return { model: { width: model.width, height: model.height } };
      }
      if (method === "DOM.focus" || method === "Input.insertText" || method === "Input.dispatchKeyEvent") {
        if (method === "Input.insertText") insertTextCalled = true;
        return {};
      }
      if (method === "Page.getFrameTree") {
        if (opts.frameUrls !== undefined) {
          if (opts.frameUrls.length === 0) return { garbage: true };
          if (frameUrlIdx >= opts.frameUrls.length) {
            if (opts.repeatLast) {
              const url = opts.frameUrls[opts.frameUrls.length - 1];
              if (url === null) return { garbage: true };
              return { frameTree: { frame: { url } } };
            }
            return { garbage: true };
          }
          const url = opts.frameUrls[frameUrlIdx++];
          if (url === null) return { garbage: true };
          return { frameTree: { frame: { url } } };
        }
        if (opts.frameUrl === null) return { garbage: true };
        if (opts.frameUrl !== undefined) return { frameTree: { frame: { url: opts.frameUrl } } };
        return { frameTree: { frame: { url: "https://chatgpt.com/c/new-conv" } } };
      }
      const explicit = cdpResponses.get(method);
      if (explicit !== undefined) return explicit;
      return {};
    },
    close() {
      closeCount++;
      if (opts.closeThrows) throw new Error("close exploded with secret claim");
    },
  };
  return view;
}

type FakeView = ReturnType<typeof createFakeView>;

function makeFactory(view: FakeView) {
  const calls: Array<{ backend: unknown; url: string }> = [];
  return {
    factory: (_options: { backend: { type: "chrome"; url: string }; url: string }) => {
      calls.push({ backend: _options.backend, url: _options.url });
      return view;
    },
    calls,
  };
}

function immediateWait(): (ms: number) => Promise<void> {
  return async (_ms: number) => {};
}

function makeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
    get: () => t,
  };
}

async function importSubmitter() {
  const mod = await import("../src/browser/webview");
  return mod.WebViewSubmitter;
}

function successView() {
  const selectorNodes = new Map<string, number[]>([
    ['[data-testid="prompt-textarea"]', [10]],
  ]);
  const describeResults = new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]);
  const boxModels = new Map([[10, { width: 100, height: 50 }]]);
  return createFakeView({ selectorNodes, describeResults, boxModels });
}

describe("WebViewSubmitter", () => {
  describe("module export", () => {
    test("module exists and exports WebViewSubmitter", async () => {
      const mod = await import("../src/browser/webview");
      expect(mod.WebViewSubmitter).toBeDefined();
      expect(typeof mod.WebViewSubmitter).toBe("function");
    });
  });

  describe("feature detection and validation", () => {
    test("null factory returns unavailable without constructing", async () => {
      const WebViewSubmitter = await importSubmitter();
      const submitter = new WebViewSubmitter({ webViewFactory: null });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(result.message).toBe("WebView runtime is not available.");
    });

    test("factory throwing at construction returns unavailable without calling cdp", async () => {
      const WebViewSubmitter = await importSubmitter();
      const submitter = new WebViewSubmitter({
        webViewFactory: (() => { throw new Error("boom"); }) as never,
      });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(result.message).toBe("Browser view could not be created.");
    });

    test("invalid target URL returns unavailable without constructing", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView();
      const { factory, calls } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory });
      const result = await submitter.submit(makeInput({ targetUrl: "https://evil.com/attack" }));
      expect(result.kind).toBe("unavailable");
      expect(calls.length).toBe(0);
    });

    test("non-chatgpt host returns unavailable", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView();
      const { factory, calls } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory });
      const result = await submitter.submit(makeInput({ targetUrl: "https://openai.com/api" }));
      expect(result.kind).toBe("unavailable");
      expect(calls.length).toBe(0);
    });
  });

  describe("constructor options", () => {
    test("exact constructor options attach to supplied WebSocket", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = successView();
      const { factory, calls } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory });
      await submitter.submit(makeInput());
      expect(calls.length).toBe(1);
      const call = calls[0]!;
      expect(call.backend).toEqual({ type: "chrome", url: SESSION.webSocketUrl });
      expect(call.url).toBe(PROJECT_URL);
    });

    test("constructor options contain no dataStore, path, argv, or profile", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = successView();
      const rawCalls: unknown[] = [];
      const factory = (options: unknown) => {
        rawCalls.push(options);
        return view;
      };
      const submitter = new WebViewSubmitter({ webViewFactory: factory as never });
      await submitter.submit(makeInput());
      const opts = rawCalls[0] as Record<string, unknown>;
      expect(opts).not.toHaveProperty("dataStore");
      expect(opts).not.toHaveProperty("path");
      expect(opts).not.toHaveProperty("argv");
      expect(opts).not.toHaveProperty("directory");
      const backend = opts.backend as Record<string, unknown>;
      expect(backend).not.toHaveProperty("path");
      expect(backend).not.toHaveProperty("argv");
    });

    test("invalid deadline option throws TypeError", async () => {
      const WebViewSubmitter = await importSubmitter();
      expect(() => new WebViewSubmitter({ deadlineMs: -1 })).toThrow(TypeError);
      expect(() => new WebViewSubmitter({ deadlineMs: 0 })).toThrow(TypeError);
      expect(() => new WebViewSubmitter({ deadlineMs: Number.NaN })).toThrow(TypeError);
    });

    test("invalid now seam throws TypeError", async () => {
      const WebViewSubmitter = await importSubmitter();
      expect(() => new WebViewSubmitter({ now: "not a function" as never })).toThrow(TypeError);
      expect(() => new WebViewSubmitter({ now: 42 as never })).toThrow(TypeError);
    });

    test("invalid wait seam throws TypeError", async () => {
      const WebViewSubmitter = await importSubmitter();
      expect(() => new WebViewSubmitter({ wait: "not a function" as never })).toThrow(TypeError);
      expect(() => new WebViewSubmitter({ wait: 42 as never })).toThrow(TypeError);
    });

    test("factory receives canonical query-free URL for target with query", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = successView();
      const { factory, calls } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory });
      await submitter.submit(makeInput({ targetUrl: "https://chatgpt.com/g/projects/aaa-bbb-ccc?x=1" }));
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe("https://chatgpt.com/g/projects/aaa-bbb-ccc");
    });
  });

  describe("selector priority and candidate inspection", () => {
    test("selects first editable visible textarea by priority order", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', []],
        ["#prompt-textarea", []],
        ["textarea", [10]],
        ['[contenteditable="true"]', [20]],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "TEXTAREA", attributes: [] }],
      ]);
      const boxModels = new Map([[10, { width: 100, height: 50 }]]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      const focusCall = view.cdpCalls.find(c => c.method === "DOM.focus");
      expect(focusCall?.params?.nodeId).toBe(10);
    });

    test("refuses an ambiguous trusted selector without mutating the page", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10, 11]],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "TEXTAREA", attributes: [] }],
        [11, { nodeName: "TEXTAREA", attributes: [] }],
      ]);
      const boxModels = new Map([
        [10, { width: 100, height: 50 }],
        [11, { width: 100, height: 50 }],
      ]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const clock = makeClock();
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: clock.now,
        wait: async (ms) => { clock.advance(ms); },
        deadlineMs: 500,
      });

      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(view.cdpCalls.some((call) => call.method === "DOM.focus")).toBeFalse();
      expect(view.cdpCalls.some((call) => call.method === "Input.insertText")).toBeFalse();
    });

    test("skips disabled textarea and finds trusted contenteditable", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10]],
        ["#prompt-textarea", [20]],
        ["textarea", []],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "TEXTAREA", attributes: ["disabled", "true"] }],
        [20, { nodeName: "DIV", attributes: ["contenteditable", "true"] }],
      ]);
      const boxModels = new Map([
        [10, { width: 100, height: 50 }],
        [20, { width: 200, height: 80 }],
      ]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      const focusCall = view.cdpCalls.find(c => c.method === "DOM.focus");
      expect(focusCall?.params?.nodeId).toBe(20);
    });

    test("caps at 8 node IDs: nodes 1-8 non-editable, node 9 valid but never described", async () => {
      const WebViewSubmitter = await importSubmitter();
      const allNodes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', allNodes],
        ["#prompt-textarea", []],
        ["textarea", []],
        ['[contenteditable="true"]', []],
      ]);
      const describeResults = new Map<number, { nodeName: string; attributes?: string[] }>();
      const boxModels = new Map<number, { width: number; height: number }>();
      for (let id = 1; id <= 8; id++) {
        describeResults.set(id, { nodeName: "TEXTAREA", attributes: ["disabled", "true"] });
      }
      describeResults.set(9, { nodeName: "TEXTAREA", attributes: [] });
      boxModels.set(9, { width: 100, height: 50 });
      describeResults.set(10, { nodeName: "TEXTAREA", attributes: [] });
      boxModels.set(10, { width: 100, height: 50 });
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const clock = makeClock();
      const wait = async (ms: number) => { clock.advance(ms); };
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs: 10_000,
      });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      const describeCalls = view.cdpCalls.filter(c => c.method === "DOM.describeNode");
      const describedIds = describeCalls.map(c => (c.params as Record<string, unknown>).nodeId as number);
      for (const id of describedIds) {
        expect(id).toBeLessThanOrEqual(8);
      }
      expect(describedIds).not.toContain(9);
      expect(describedIds).not.toContain(10);
      const focusCalls = view.cdpCalls.filter(c => c.method === "DOM.focus");
      expect(focusCalls.length).toBe(0);
    });

    test("stale-node describeNode error continues to next candidate", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10, 11]],
        ["#prompt-textarea", []],
        ["textarea", []],
        ['[contenteditable="true"]', []],
      ]);
      const describeResults = new Map([
        [11, { nodeName: "TEXTAREA", attributes: [] }],
      ]);
      const boxModels = new Map([[11, { width: 100, height: 50 }]]);
      const describeThrows = new Set([10]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels, describeThrows });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      const focusCall = view.cdpCalls.find(c => c.method === "DOM.focus");
      expect(focusCall?.params?.nodeId).toBe(11);
    });

    test("hidden candidate (no box model) continues to next", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10, 11]],
        ["#prompt-textarea", []],
        ["textarea", []],
        ['[contenteditable="true"]', []],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "TEXTAREA", attributes: [] }],
        [11, { nodeName: "TEXTAREA", attributes: [] }],
      ]);
      const boxModels = new Map([
        [10, null],
        [11, { width: 100, height: 50 }],
      ]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      const focusCall = view.cdpCalls.find(c => c.method === "DOM.focus");
      expect(focusCall?.params?.nodeId).toBe(11);
    });

    test("readonly textarea is skipped", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10]],
        ["#prompt-textarea", []],
        ["textarea", [11]],
        ['[contenteditable="true"]', []],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "TEXTAREA", attributes: ["readonly", "true"] }],
        [11, { nodeName: "TEXTAREA", attributes: [] }],
      ]);
      const boxModels = new Map([
        [10, { width: 100, height: 50 }],
        [11, { width: 100, height: 50 }],
      ]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      const focusCall = view.cdpCalls.find(c => c.method === "DOM.focus");
      expect(focusCall?.params?.nodeId).toBe(11);
    });

    test("aria-disabled=true textarea is skipped", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10]],
        ["#prompt-textarea", []],
        ["textarea", [11]],
        ['[contenteditable="true"]', []],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "TEXTAREA", attributes: ["aria-disabled", "true"] }],
        [11, { nodeName: "TEXTAREA", attributes: [] }],
      ]);
      const boxModels = new Map([
        [10, { width: 100, height: 50 }],
        [11, { width: 100, height: 50 }],
      ]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      const focusCall = view.cdpCalls.find(c => c.method === "DOM.focus");
      expect(focusCall?.params?.nodeId).toBe(11);
    });

    test("contenteditable=plaintext-only is accepted", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10]],
        ["#prompt-textarea", []],
        ["textarea", []],
        ['[contenteditable="true"]', []],
      ]);
      const describeResults = new Map([
        [10, { nodeName: "DIV", attributes: ["contenteditable", "plaintext-only"] }],
      ]);
      const boxModels = new Map([[10, { width: 100, height: 50 }]]);
      const view = createFakeView({ selectorNodes, describeResults, boxModels });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
    });
  });

  describe("CDP allowlist", () => {
    test("no Runtime.evaluate, DOM.getOuterHTML, or read APIs are called", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = successView();
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      await submitter.submit(makeInput());
      const methods = view.cdpCalls.map(c => c.method);
      expect(methods).not.toContain("Runtime.evaluate");
      expect(methods).not.toContain("DOM.getOuterHTML");
      expect(methods).not.toContain("DOM.getAttributes");
      expect(methods).not.toContain("Page.captureScreenshot");
      expect(methods).not.toContain("Network.enable");
      const allowed = new Set([
        "DOM.enable", "Page.enable", "DOM.getDocument", "DOM.querySelectorAll",
        "DOM.describeNode", "DOM.getBoxModel", "DOM.focus",
        "Input.insertText", "Input.dispatchKeyEvent", "Page.getFrameTree",
      ]);
      for (const m of methods) {
        expect(allowed.has(m)).toBe(true);
      }
    });
  });

  describe("handoff insertion and Enter dispatch", () => {
    test("exact unchanged handoff is inserted exactly once", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = successView();
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      await submitter.submit(makeInput());
      const insertCalls = view.cdpCalls.filter(c => c.method === "Input.insertText");
      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0]!.params?.text).toBe(HANDOFF);
    });

    test("Enter keyDown and keyUp dispatched exactly once each", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = successView();
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      await submitter.submit(makeInput());
      const keyCalls = view.cdpCalls.filter(c => c.method === "Input.dispatchKeyEvent");
      expect(keyCalls.length).toBe(2);
      expect(keyCalls[0]!.params?.type).toBe("keyDown");
      expect(keyCalls[0]!.params?.key).toBe("Enter");
      expect(keyCalls[0]!.params?.code).toBe("Enter");
      expect(keyCalls[0]!.params?.windowsVirtualKeyCode).toBe(13);
      expect(keyCalls[1]!.params?.type).toBe("keyUp");
      expect(keyCalls[1]!.params?.key).toBe("Enter");
      expect(keyCalls[1]!.params?.code).toBe("Enter");
      expect(keyCalls[1]!.params?.windowsVirtualKeyCode).toBe(13);
    });
  });

  describe("conversation URL handling", () => {
    test("valid final conversation URL strips query and fragment", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        selectorNodes: new Map([['[data-testid="prompt-textarea"]', [10]]]),
        describeResults: new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]),
        boxModels: new Map([[10, { width: 100, height: 50 }]]),
        frameUrls: [PROJECT_URL, PROJECT_URL, "https://chatgpt.com/c/new-conv?claim=secret#frag"],
        userMessageCounts: [0, 1],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("submitted");
      if (result.kind === "submitted") {
        expect(result.conversationUrl).toBe("https://chatgpt.com/c/new-conv");
      }
    });

    test("configured project URL unchanged is not emitted as conversation", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        selectorNodes: new Map([['[data-testid="prompt-textarea"]', [10]]]),
        describeResults: new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]),
        boxModels: new Map([[10, { width: 100, height: 50 }]]),
        frameUrl: PROJECT_URL,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("submitted");
      if (result.kind === "submitted") {
        expect(result.conversationUrl).toBeUndefined();
      }
    });

    test("known conversation target may return same URL", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        selectorNodes: new Map([['[data-testid="prompt-textarea"]', [10]]]),
        describeResults: new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]),
        boxModels: new Map([[10, { width: 100, height: 50 }]]),
        frameUrl: CONVERSATION_URL,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput({
        targetUrl: CONVERSATION_URL,
        targetKind: "conversation",
      }));
      expect(result.kind).toBe("submitted");
      if (result.kind === "submitted") {
        expect(result.conversationUrl).toBe(CONVERSATION_URL);
      }
    });

    test("malformed frame tree prevents mutation and returns unavailable", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        selectorNodes: new Map([['[data-testid="prompt-textarea"]', [10]]]),
        describeResults: new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]),
        boxModels: new Map([[10, { width: 100, height: 50 }]]),
        frameUrl: null,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      const insertCalls = view.cdpCalls.filter(c => c.method === "Input.insertText");
      expect(insertCalls.length).toBe(0);
    });
  });

  describe("deadline and timeout", () => {
    test("never-settling CDP is bounded by real timeout and closes view once", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({ hangMethod: "DOM.getDocument" });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, deadlineMs: 200 });
      const start = performance.now();
      const result = await submitter.submit(makeInput());
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000);
      expect(result.kind).not.toBe("submitted");
      expect(view.closeCount()).toBe(1);
    });

    test("CDP advancing clock to exact deadline is rejected, closes once, no subsequent command", async () => {
      const WebViewSubmitter = await importSubmitter();
      const deadlineMs = 1000;
      const clock = makeClock();
      const deadline = clock.get() + deadlineMs;
      const cdpCalls: CdpCall[] = [];
      let closeCalls = 0;
      const view = {
        async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
          cdpCalls.push({ method, params });
          if (method === "DOM.enable") {
            clock.set(deadline);
            return {};
          }
          return {};
        },
        close() { closeCalls++; },
      };
      const factory = () => view;
      const submitter = new WebViewSubmitter({
        webViewFactory: factory as never,
        now: () => clock.get(),
        wait: immediateWait(),
        deadlineMs,
      });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(closeCalls).toBe(1);
      const methods = cdpCalls.map(c => c.method);
      expect(methods).toContain("DOM.enable");
      expect(methods).not.toContain("Page.enable");
      expect(methods).not.toContain("DOM.focus");
      expect(methods).not.toContain("Input.insertText");
    });

    test("deadline exhausted before mutation means mutation absent from CDP calls", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      const deadlineMs = 50;
      clock.set(1_000_000);
      const deadline = clock.get() + deadlineMs;
      const cdpCalls: CdpCall[] = [];
      let closeCalls = 0;
      const view = {
        async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
          cdpCalls.push({ method, params });
          if (method === "DOM.getDocument") {
            clock.set(deadline + 1);
          }
          if (method === "DOM.querySelectorAll") {
            return { nodeIds: [10] };
          }
          if (method === "DOM.describeNode") {
            return { node: { nodeId: 10, nodeName: "TEXTAREA", attributes: [] } };
          }
          if (method === "DOM.getBoxModel") {
            return { model: { width: 100, height: 50 } };
          }
          return {};
        },
        close() { closeCalls++; },
      };
      const factory = () => view;
      const submitter = new WebViewSubmitter({
        webViewFactory: factory as never,
        now: () => clock.get(),
        wait: immediateWait(),
        deadlineMs,
      });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(closeCalls).toBe(1);
      const methods = cdpCalls.map(c => c.method);
      expect(methods).not.toContain("DOM.focus");
      expect(methods).not.toContain("Input.insertText");
      expect(methods).not.toContain("Input.dispatchKeyEvent");
    });

    test("no post-deadline polling command starts after injected wait reaches deadline", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      const deadlineMs = 150;
      const cdpCalls: CdpCall[] = [];
      let closeCalls = 0;
      let waitCalls = 0;
      const wait = async (_ms: number) => {
        waitCalls++;
        clock.set(clock.get() + deadlineMs + 1);
      };
      const view = {
        async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
          cdpCalls.push({ method, params });
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { url: "https://chatgpt.com/c/conv" } } };
          }
          if (method === "DOM.querySelectorAll") return { nodeIds: [] };
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
          return {};
        },
        close() { closeCalls++; },
      };
      const factory = () => view;
      const submitter = new WebViewSubmitter({
        webViewFactory: factory as never,
        now: () => clock.get(),
        wait,
        deadlineMs,
      });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(closeCalls).toBe(1);
      expect(waitCalls).toBeGreaterThanOrEqual(1);
    });
  });

  describe("error phases and close semantics", () => {
    test("no editable candidate returns unavailable with compact message", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', []],
        ["#prompt-textarea", []],
        ["textarea", []],
        ['[contenteditable="true"]', []],
      ]);
      const view = createFakeView({ selectorNodes });
      const { factory } = makeFactory(view);
      const clock = makeClock();
      const deadlineMs = 300;
      const wait = async (ms: number) => { clock.advance(ms); };
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        deadlineMs,
        now: () => clock.get(),
        wait,
      });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      if (result.kind === "unavailable") {
        expect(result.message).toBeDefined();
        expect(result.message!.length).toBeLessThanOrEqual(240);
      }
      expect(view.closeCount()).toBe(1);
    });

    test("close throwing does not alter safe result", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        selectorNodes: new Map([['[data-testid="prompt-textarea"]', [10]]]),
        describeResults: new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]),
        boxModels: new Map([[10, { width: 100, height: 50 }]]),
        closeThrows: true,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("submitted");
      expect(view.closeCount()).toBe(1);
    });

    test("insertText failure returns unavailable and closes once", async () => {
      const WebViewSubmitter = await importSubmitter();
      const selectorNodes = new Map<string, number[]>([
        ['[data-testid="prompt-textarea"]', [10]],
      ]);
      const describeResults = new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]);
      const boxModels = new Map([[10, { width: 100, height: 50 }]]);
      let closeCalls = 0;
      const cdpCalls: CdpCall[] = [];
      const view = {
        async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
          cdpCalls.push({ method, params });
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { url: "https://chatgpt.com/c/conv" } } };
          }
          if (method === "Input.insertText") throw new Error("insert failed");
          if (method === "DOM.querySelectorAll") {
            const selector = params?.selector as string;
            const nodes = selectorNodes.get(selector) ?? [];
            return { nodeIds: nodes };
          }
          if (method === "DOM.describeNode") {
            const nodeId = params?.nodeId as number;
            const info = describeResults.get(nodeId);
            return { node: { nodeId, nodeName: info?.nodeName ?? "DIV", attributes: info?.attributes ?? [] } };
          }
          if (method === "DOM.getBoxModel") {
            const nodeId = params?.nodeId as number;
            const model = boxModels.get(nodeId);
            if (!model) throw new Error("no box");
            return { model: { width: model.width, height: model.height } };
          }
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
          return {};
        },
        close() { closeCalls++; },
      };
      const factory = () => view;
      const submitter = new WebViewSubmitter({ webViewFactory: factory as never, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(closeCalls).toBe(1);
      const insertCalls = cdpCalls.filter(c => c.method === "Input.insertText");
      expect(insertCalls.length).toBe(1);
    });

    test("messages never contain raw error text, URLs, claims, or DOM attributes", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({ hangMethod: "DOM.getDocument" });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, deadlineMs: 200 });
      const result = await submitter.submit(makeInput());
      const msg = (result as { message?: string }).message ?? "";
      expect(msg).not.toContain("ws://");
      expect(msg).not.toContain("claim");
      expect(msg).not.toContain("chatgpt.com");
      expect(msg).not.toContain("textarea");
      expect(msg).not.toContain("Error");
    });
  });

  describe("authoritative redirect/confirmation regressions", () => {
    const stdViewOpts = {
      selectorNodes: new Map([['[data-testid="prompt-textarea"]', [10]]]),
      describeResults: new Map([[10, { nodeName: "TEXTAREA", attributes: [] }]]),
      boxModels: new Map([[10, { width: 100, height: 50 }]]),
    };

    test("foreign redirect on first live top-frame check: unavailable, one close, zero insert/dispatch", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({ ...stdViewOpts, frameUrls: ["https://evil.com/phish"] });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(view.closeCount()).toBe(1);
      expect(view.cdpCalls.filter(c => c.method === "Input.insertText")).toHaveLength(0);
      expect(view.cdpCalls.filter(c => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
    });

    test("login redirect on second check: unavailable, one close, zero insert/dispatch", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, "https://chatgpt.com/auth/login"],
        userMessageCounts: [0],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(view.closeCount()).toBe(1);
      expect(view.cdpCalls.filter(c => c.method === "Input.insertText")).toHaveLength(0);
      expect(view.cdpCalls.filter(c => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
      const frameCalls = view.cdpCalls.filter(c => c.method === "Page.getFrameTree");
      expect(frameCalls.length).toBe(2);
      const insertIdx = view.cdpCalls.findIndex(c => c.method === "Input.insertText");
      expect(insertIdx).toBe(-1);
    });

    test("safe target change before mutation is unavailable with zero insert or dispatch", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, CONVERSATION_URL],
        userMessageCounts: [0],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });

      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(view.closeCount()).toBe(1);
      expect(view.cdpCalls.filter((call) => call.method === "DOM.focus")).toHaveLength(0);
      expect(view.cdpCalls.filter((call) => call.method === "Input.insertText")).toHaveLength(0);
      expect(view.cdpCalls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(0);
    });

    test("safe Project-to-conversation transition: submitted with canonical conversation URL, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const convUrl = "https://chatgpt.com/c/new-conv-123";
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, PROJECT_URL, convUrl],
        userMessageCounts: [0, 1],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("submitted");
      if (result.kind === "submitted") {
        expect(result.conversationUrl).toBe(convUrl);
      }
      expect(view.closeCount()).toBe(1);
      const focusIdx = view.cdpCalls.findIndex(c => c.method === "DOM.focus");
      const insertIdx = view.cdpCalls.findIndex(c => c.method === "Input.insertText");
      expect(focusIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(0);
      expect(view.cdpCalls[focusIdx - 1]!.method).toBe("Page.getFrameTree");
      expect(insertIdx).toBe(focusIdx + 1);
      expect(view.cdpCalls.filter(c => c.method === "Input.insertText")).toHaveLength(1);
    });

    test("delayed non-content confirmation: count increases after wait, returns submitted", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      let waitCalls = 0;
      const wait = async (_ms: number) => { waitCalls++; clock.advance(50); };
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, PROJECT_URL, PROJECT_URL],
        userMessageCounts: [2, 2, 3],
        repeatLast: true,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs: 10_000,
      });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("submitted");
      expect(waitCalls).toBeGreaterThanOrEqual(1);
      const insertCalls = view.cdpCalls.filter(c => c.method === "Input.insertText");
      expect(insertCalls.length).toBe(1);
    });

    test("existing conversation same-URL confirmation: submitted with same canonical URL", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [CONVERSATION_URL, CONVERSATION_URL, CONVERSATION_URL],
        userMessageCounts: [3, 4],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput({
        targetUrl: CONVERSATION_URL,
        targetKind: "conversation",
      }));
      expect(result.kind).toBe("submitted");
      if (result.kind === "submitted") {
        expect(result.conversationUrl).toBe(CONVERSATION_URL);
      }
    });

    test("foreign navigation during confirmation: unavailable, no DOM count on foreign page, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, PROJECT_URL, "https://evil.com/phish"],
        userMessageCounts: [0],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(result.kind).not.toBe("opened_manual");
      const userMsgQueries = view.cdpCalls.filter(
        c => c.method === "DOM.querySelectorAll"
          && (c.params as Record<string, unknown>)?.selector === '[data-message-author-role="user"]',
      );
      expect(userMsgQueries.length).toBe(1);
      expect(view.closeCount()).toBe(1);
    });

    test("malformed baseline count: unavailable, zero insert/dispatch, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, PROJECT_URL],
        malformedBaseline: true,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait() });
      const result = await submitter.submit(makeInput());
      expect(result.kind).toBe("unavailable");
      expect(view.cdpCalls.filter(c => c.method === "Input.insertText")).toHaveLength(0);
      expect(view.cdpCalls.filter(c => c.method === "Input.dispatchKeyEvent")).toHaveLength(0);
      expect(view.closeCount()).toBe(1);
    });

    test("no signal until injected monotonic deadline: unavailable, one close, no CDP at or after deadline", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      let waitCalls = 0;
      const wait = async (_ms: number) => { waitCalls++; clock.advance(50); };
      const deadlineMs = 120;
      const deadline = clock.get() + deadlineMs;
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [CONVERSATION_URL],
        userMessageCounts: [2],
        repeatLast: true,
        now: () => clock.get(),
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs,
      });
      const result = await submitter.submit(makeInput({
        targetUrl: CONVERSATION_URL,
        targetKind: "conversation",
      }));
      expect(result.kind).toBe("unavailable");
      expect(view.closeCount()).toBe(1);
      expect(waitCalls).toBeGreaterThanOrEqual(1);
      expect(view.cdpCallTimes.length).toBeGreaterThan(0);
      for (const t of view.cdpCallTimes) {
        expect(t).toBeLessThan(deadline);
      }
    });

    test("configured static URL with non-increasing count reaches deadline: unavailable, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      let waitCalls = 0;
      const wait = async (_ms: number) => { waitCalls++; clock.advance(50); };
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL],
        userMessageCounts: [2],
        repeatLast: true,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs: 120,
      });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("unavailable");
      expect(result.kind).not.toBe("submitted");
      expect(result.kind).not.toBe("opened_manual");
      expect(view.closeCount()).toBe(1);
      expect(waitCalls).toBeGreaterThanOrEqual(1);
    });

    test("configured target with safe pre-existing redirect, unchanged after Enter, no count increase reaches deadline: unavailable, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      let waitCalls = 0;
      const wait = async (_ms: number) => { waitCalls++; clock.advance(50); };
      const redirectedUrl = "https://chatgpt.com/g/projects/aaa-bbb-ccc/discussions";
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [redirectedUrl],
        userMessageCounts: [2],
        repeatLast: true,
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs: 120,
      });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("unavailable");
      expect(result.kind).not.toBe("submitted");
      expect(view.closeCount()).toBe(1);
      expect(waitCalls).toBeGreaterThanOrEqual(1);
    });

    test("exhausted non-repeating scripted URLs fail closed: unexpected extra read yields unavailable, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      const wait = async (_ms: number) => { clock.advance(50); };
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, PROJECT_URL, PROJECT_URL],
        userMessageCounts: [0, 0],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs: 10_000,
      });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("unavailable");
      expect(view.closeCount()).toBe(1);
    });

    test("exhausted non-repeating scripted user-message counts fail closed: enough URLs but count read returns malformed, unavailable, one close", async () => {
      const WebViewSubmitter = await importSubmitter();
      const clock = makeClock();
      const wait = async (_ms: number) => { clock.advance(50); };
      const view = createFakeView({
        ...stdViewOpts,
        frameUrls: [PROJECT_URL, PROJECT_URL, PROJECT_URL, PROJECT_URL, PROJECT_URL],
        userMessageCounts: [0, 0],
      });
      const { factory } = makeFactory(view);
      const submitter = new WebViewSubmitter({
        webViewFactory: factory,
        now: () => clock.get(),
        wait,
        deadlineMs: 10_000,
      });
      const result = await submitter.submit(makeInput({ targetKind: "configured" }));
      expect(result.kind).toBe("unavailable");
      expect(view.closeCount()).toBe(1);
    });

    test("WebView never returns opened_manual across all scenarios", async () => {
      const WebViewSubmitter = await importSubmitter();
      const scenarios: Array<{ name: string; opts: FakeViewOptions; inputOverrides?: Partial<BrowserSubmitInput> }> = [
        { name: "foreign first URL", opts: { ...stdViewOpts, frameUrls: ["https://evil.com"] } },
        { name: "login redirect", opts: { ...stdViewOpts, frameUrls: [PROJECT_URL, "https://chatgpt.com/login"], userMessageCounts: [0] } },
        { name: "foreign during confirmation", opts: { ...stdViewOpts, frameUrls: [PROJECT_URL, PROJECT_URL, "https://evil.com"], userMessageCounts: [0] } },
        { name: "malformed baseline", opts: { ...stdViewOpts, frameUrls: [PROJECT_URL, PROJECT_URL], malformedBaseline: true } },
        { name: "no editable candidate", opts: { selectorNodes: new Map() } },
      ];
      for (const scenario of scenarios) {
        const view = createFakeView(scenario.opts);
        const { factory } = makeFactory(view);
        const submitter = new WebViewSubmitter({ webViewFactory: factory, wait: immediateWait(), deadlineMs: 300 });
        const result = await submitter.submit(makeInput(scenario.inputOverrides));
        expect(result.kind).not.toBe("opened_manual");
      }
    });
  });
});
