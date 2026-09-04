import { describe, expect, test } from "bun:test";
import {
  ChatgptBrowserLauncher,
  classifyObservedChatgptUrl,
  formatChatgptHandoff,
  sanitizeChatgptUrl,
  type BrowserSubmitter,
  type BrowserSubmitInput,
  type BrowserSubmitResult,
  type LauncherResult,
} from "../src/browser/handoff";
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

const REQUEST_ID = "req_01";
const CLAIM = "claim_abc";
const PROJECT_URL = "https://chatgpt.com/g/projects/aaa-bbb-ccc";

function makeSubmitter(result: BrowserSubmitResult): BrowserSubmitter & { calls: BrowserSubmitInput[] } {
  const calls: BrowserSubmitInput[] = [];
  return {
    calls,
    async submit(input) {
      calls.push(input);
      return result;
    },
  };
}

function assertKind<K extends LauncherResult["kind"]>(
  result: LauncherResult,
  kind: K,
): Extract<LauncherResult, { kind: K }> {
  expect(result.kind).toBe(kind);
  return result as Extract<LauncherResult, { kind: K }>;
}

describe("formatChatgptHandoff", () => {
  test("contains request_get with id and claim, then request_complete", () => {
    const text = formatChatgptHandoff(REQUEST_ID, CLAIM);
    expect(text).toContain(`request_get`);
    expect(text).toContain(REQUEST_ID);
    expect(text).toContain(CLAIM);
    expect(text).toContain("selectively inspect context");
    expect(text).toContain("request_complete");
  });

  test("contains no project paths or request content", () => {
    const text = formatChatgptHandoff(REQUEST_ID, CLAIM);
    expect(text).not.toContain("/");
    expect(text).not.toContain("goal");
    expect(text).not.toContain("profile");
  });
});

describe("sanitizeChatgptUrl", () => {
  describe("configured navigation target", () => {
    const purpose = "configured" as const;

    test("accepts canonical https chatgpt.com path", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/g/projects/aaa", purpose)).toBe(
        "https://chatgpt.com/g/projects/aaa",
      );
    });

    test("strips query parameters", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/g/projects/aaa?x=1", purpose)).toBe(
        "https://chatgpt.com/g/projects/aaa",
      );
    });

    test("rejects http scheme", () => {
      expect(sanitizeChatgptUrl("http://chatgpt.com/g/projects/aaa", purpose)).toBeNull();
    });

    test("rejects credentials", () => {
      expect(sanitizeChatgptUrl("https://user:pass@chatgpt.com/g/projects/aaa", purpose)).toBeNull();
    });

    test("rejects explicit port 443", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com:443/g/projects/aaa", purpose)).toBeNull();
    });

    test("rejects non-default port", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com:8080/g/projects/aaa", purpose)).toBeNull();
    });

    test("rejects fragment", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/g/projects/aaa#x", purpose)).toBeNull();
    });

    test("rejects query with fragment", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/g/projects/aaa?x=1#y", purpose)).toBeNull();
    });

    test("rejects javascript scheme", () => {
      expect(sanitizeChatgptUrl("javascript:alert(1)", purpose)).toBeNull();
    });

    test("rejects data scheme", () => {
      expect(sanitizeChatgptUrl("data:text/html,<h1>", purpose)).toBeNull();
    });

    test("rejects file scheme", () => {
      expect(sanitizeChatgptUrl("file:///etc/passwd", purpose)).toBeNull();
    });

    test("rejects lookalike subdomain evil.chatgpt.com", () => {
      expect(sanitizeChatgptUrl("https://evil.chatgpt.com/g/projects/aaa", purpose)).toBeNull();
    });

    test("rejects lookalike suffix chatgpt.com.evil.test", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com.evil.test/g/projects/aaa", purpose)).toBeNull();
    });

    test("rejects empty string", () => {
      expect(sanitizeChatgptUrl("", purpose)).toBeNull();
    });

    test("rejects malformed text", () => {
      expect(sanitizeChatgptUrl("not a url at all", purpose)).toBeNull();
    });

    test("rejects openai.com host", () => {
      expect(sanitizeChatgptUrl("https://openai.com/api/login", purpose)).toBeNull();
    });

    test("rejects auth/login configured URL", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/auth/login", purpose)).toBeNull();
    });

    test("rejects auth callback configured URL", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/auth/callback", purpose)).toBeNull();
    });

    test("rejects /login configured URL", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/login", purpose)).toBeNull();
    });

    test("rejects /login/subpath configured URL", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/login/callback", purpose)).toBeNull();
    });

    test("accepts /author path (not an auth/login family)", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/author/profile", purpose)).toBe(
        "https://chatgpt.com/author/profile",
      );
    });
  });

  describe("observed conversation URL", () => {
    const purpose = "conversation" as const;

    test("accepts chatgpt.com with non-root path", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/c/abc-123", purpose)).toBe(
        "https://chatgpt.com/c/abc-123",
      );
    });

    test("strips query and fragment", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/c/abc-123?claim=secret#frag", purpose)).toBe(
        "https://chatgpt.com/c/abc-123",
      );
    });

    test("rejects root-only path", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/", purpose)).toBeNull();
      expect(sanitizeChatgptUrl("https://chatgpt.com", purpose)).toBeNull();
    });

    test("rejects login URL", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/auth/login", purpose)).toBeNull();
    });

    test("rejects /login path", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com/login", purpose)).toBeNull();
    });

    test("rejects subdomain lookalike", () => {
      expect(sanitizeChatgptUrl("https://evil.chatgpt.com/c/abc", purpose)).toBeNull();
    });

    test("rejects http scheme", () => {
      expect(sanitizeChatgptUrl("http://chatgpt.com/c/abc", purpose)).toBeNull();
    });

    test("rejects credentials", () => {
      expect(sanitizeChatgptUrl("https://u:p@chatgpt.com/c/abc", purpose)).toBeNull();
    });

    test("rejects explicit port", () => {
      expect(sanitizeChatgptUrl("https://chatgpt.com:443/c/abc", purpose)).toBeNull();
    });
  });
});

describe("classifyObservedChatgptUrl", () => {
  test("classifies login paths without accepting them as a conversation", () => {
    expect(classifyObservedChatgptUrl("https://chatgpt.com/auth/login?next=%2Fg%2Fprojects%2Faaa"))
      .toEqual({ kind: "login" });
    expect(classifyObservedChatgptUrl("https://chatgpt.com/login#challenge"))
      .toEqual({ kind: "login" });
  });

  test("returns a canonical safe page without query or fragment", () => {
    expect(classifyObservedChatgptUrl("https://chatgpt.com/c/abc-123?model=auto#latest"))
      .toEqual({ kind: "page", url: "https://chatgpt.com/c/abc-123" });
  });

  test.each([
    "http://chatgpt.com/c/abc",
    "https://evil.chatgpt.com/c/abc",
    "https://chatgpt.com:443/c/abc",
    "https://user:pass@chatgpt.com/c/abc",
    "not a url",
  ])("rejects unsafe observed page %s", (value) => {
    expect(classifyObservedChatgptUrl(value)).toEqual({ kind: "invalid" });
  });

  test("keeps the safe root distinct from a valid conversation page", () => {
    expect(classifyObservedChatgptUrl("https://chatgpt.com/?next=login"))
      .toEqual({ kind: "root" });
  });
});

describe("ChatgptBrowserLauncher", () => {
  const controller = {
    calls: 0,
    async ensureRunning() {
      controller.calls++;
      return SESSION;
    },
  };

  function resetController() {
    controller.calls = 0;
  }

  describe("orchestration", () => {
    test("no valid target invokes nothing and returns manual_required with handoff", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "submitted" });
      const fallback = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "manual_required");
      expect(r.requestId).toBe(REQUEST_ID);
      expect(r.opened).toBe(false);
      expect(r.manual).toBe(true);
      expect(r.handoff).toContain(REQUEST_ID);
      expect(r.handoff).toContain(CLAIM);
      expect(controller.calls).toBe(0);
      expect(primary.calls.length).toBe(0);
      expect(fallback.calls.length).toBe(0);
    });

    test("primary submitted skips fallback", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "submitted" });
      const fallback = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "submitted");
      expect(r.requestId).toBe(REQUEST_ID);
      expect(r.opened).toBe(true);
      expect(r.manual).toBe(false);
      expect(controller.calls).toBe(1);
      expect(primary.calls.length).toBe(1);
      expect(fallback.calls.length).toBe(0);
    });

    test("primary unavailable then fallback submitted", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "unavailable", message: "no webview" });
      const fallback = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "submitted");
      expect(r.opened).toBe(true);
      expect(controller.calls).toBe(1);
      expect(primary.calls.length).toBe(1);
      expect(fallback.calls.length).toBe(1);
    });

    test("both unavailable returns manual_required with complete handoff", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "unavailable", message: "no webview" });
      const fallback = makeSubmitter({ kind: "unavailable", message: "no cdp" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "manual_required");
      expect(r.requestId).toBe(REQUEST_ID);
      expect(r.opened).toBe(false);
      expect(r.manual).toBe(true);
      expect(r.handoff).toContain(REQUEST_ID);
      expect(r.handoff).toContain(CLAIM);
      expect(controller.calls).toBe(1);
      expect(primary.calls.length).toBe(1);
      expect(fallback.calls.length).toBe(1);
    });

    test("opened-but-not-submitted yields opened_manual if fallback fails", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "opened_manual", message: "prompt area not found" });
      const fallback = makeSubmitter({ kind: "unavailable", message: "cdp failed" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "opened_manual");
      expect(r.opened).toBe(true);
      expect(r.manual).toBe(true);
      expect(r.handoff).toContain(REQUEST_ID);
      expect(r.handoff).toContain(CLAIM);
      expect(controller.calls).toBe(1);
      expect(primary.calls.length).toBe(1);
      expect(fallback.calls.length).toBe(1);
    });

    test("thrown controller error returns compact manual outcome without raw error", async () => {
      resetController();
      const throwingController = {
        calls: 0,
        async ensureRunning(): Promise<ChromeSession> {
          throwingController.calls++;
          throw new Error("Chrome failed with secret claim xyz");
        },
      };
      const primary = makeSubmitter({ kind: "submitted" });
      const fallback = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller: throwingController,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "manual_required");
      expect(r.handoff).toContain(REQUEST_ID);
      expect(r.handoff).toContain(CLAIM);
      expect(r.handoff).not.toContain("secret claim xyz");
      expect(r.message).not.toContain("secret claim xyz");
      expect(primary.calls.length).toBe(0);
      expect(fallback.calls.length).toBe(0);
    });

    test("thrown primary error continues to fallback", async () => {
      resetController();
      const throwingPrimary: BrowserSubmitter = {
        async submit(): Promise<BrowserSubmitResult> {
          throw new Error("WebView exploded with claim secret");
        },
      };
      const fallback = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary: throwingPrimary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      assertKind(result, "submitted");
      expect(fallback.calls.length).toBe(1);
    });

    test("submitter inputs use exactly one validated session and bounded values", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback: makeSubmitter({ kind: "unavailable", message: "skip" }),
        projectUrl: PROJECT_URL,
      });
      await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const input = primary.calls[0]!;
      expect(input.session).toBe(SESSION);
      expect(input.targetUrl).toBe(PROJECT_URL);
      expect(input.targetKind).toBe("configured");
      expect(input.handoff).toBe(formatChatgptHandoff(REQUEST_ID, CLAIM));
      expect(input.requestId).toBe(REQUEST_ID);
      expect(controller.calls).toBe(1);
    });
  });

  describe("conversation URL handling", () => {
    test("valid conversation URL preferred over project URL", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback: makeSubmitter({ kind: "unavailable", message: "skip" }),
        projectUrl: PROJECT_URL,
      });
      const conversationUrl = "https://chatgpt.com/c/abc-123?claim=secret#frag";
      const result = await launcher.open({
        requestId: REQUEST_ID,
        claimToken: CLAIM,
        conversationUrl,
      });
      const r = assertKind(result, "submitted");
      expect(r.conversationUrl).toBe("https://chatgpt.com/c/abc-123");
      expect(primary.calls[0]!.targetUrl).toBe("https://chatgpt.com/c/abc-123");
      expect(primary.calls[0]!.targetKind).toBe("conversation");
    });

    test("invalid conversation URL falls back to project URL", async () => {
      resetController();
      const primary = makeSubmitter({ kind: "submitted" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback: makeSubmitter({ kind: "unavailable", message: "skip" }),
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({
        requestId: REQUEST_ID,
        claimToken: CLAIM,
        conversationUrl: "https://evil.chatgpt.com/c/abc",
      });
      const r = assertKind(result, "submitted");
      expect(r.conversationUrl).toBeUndefined();
      expect(primary.calls[0]!.targetUrl).toBe(PROJECT_URL);
    });

    test("submitter-supplied conversation URL is sanitized", async () => {
      resetController();
      const primary = makeSubmitter({
        kind: "submitted",
        conversationUrl: "https://chatgpt.com/c/xyz?claim=leaked#frag",
      });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback: makeSubmitter({ kind: "unavailable", message: "skip" }),
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "submitted");
      expect(r.conversationUrl).toBe("https://chatgpt.com/c/xyz");
    });

    test("invalid submitter-supplied conversation URL is omitted", async () => {
      resetController();
      const primary = makeSubmitter({
        kind: "submitted",
        conversationUrl: "https://evil.chatgpt.com/c/abc",
      });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback: makeSubmitter({ kind: "unavailable", message: "skip" }),
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "submitted");
      expect(r.conversationUrl).toBeUndefined();
    });
  });

  describe("message sanitization", () => {
    test("submitted result redacts claim, normalizes controls, caps at 240 chars", async () => {
      resetController();
      const padding = "y".repeat(200);
      const truncatedTail = "TRUNCATED_TAIL_MARKER_" + "x".repeat(50);
      const rawMessage = `Error\nat\t${CLAIM}\r\n/tmp/secret/path ${padding}${truncatedTail}`;
      const primary = makeSubmitter({ kind: "submitted", message: rawMessage });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback: makeSubmitter({ kind: "unavailable", message: "skip" }),
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "submitted");
      expect(r.message).toBeDefined();
      expect(r.message!.length).toBeLessThanOrEqual(240);
      expect(r.message).not.toContain(CLAIM);
      expect(r.message).not.toContain("\n");
      expect(r.message).not.toContain("\t");
      expect(r.message).not.toContain("\r");
      expect(r.message).not.toContain("TRUNCATED_TAIL_MARKER_");
    });
  });

  describe("opened_manual conversation URL", () => {
    test("valid observed URL from primary is stripped of query and fragment", async () => {
      resetController();
      const primary = makeSubmitter({
        kind: "opened_manual",
        conversationUrl: "https://chatgpt.com/c/conv-1?claim=leaked#frag",
        message: "page opened",
      });
      const fallback = makeSubmitter({ kind: "unavailable", message: "skip" });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "opened_manual");
      expect(r.conversationUrl).toBe("https://chatgpt.com/c/conv-1");
    });

    test("invalid fallback manual URL cannot override valid primary manual URL", async () => {
      resetController();
      const primary = makeSubmitter({
        kind: "opened_manual",
        conversationUrl: "https://chatgpt.com/c/primary-conv",
        message: "page opened",
      });
      const fallback = makeSubmitter({
        kind: "opened_manual",
        conversationUrl: "https://evil.chatgpt.com/c/bad",
        message: "also opened",
      });
      const launcher = new ChatgptBrowserLauncher({
        controller,
        primary,
        fallback,
        projectUrl: PROJECT_URL,
      });
      const result = await launcher.open({ requestId: REQUEST_ID, claimToken: CLAIM });
      const r = assertKind(result, "opened_manual");
      expect(r.conversationUrl).toBe("https://chatgpt.com/c/primary-conv");
    });
  });
});
