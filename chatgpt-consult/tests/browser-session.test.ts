import { describe, expect, test } from "bun:test";
import {
  BrowserSessionManager,
  attachExternalCdp,
  type BrowserVisibility,
} from "../src/browser/session";
import type { ChromeSession } from "../src/browser/chrome";
import { ChromeControllerError } from "../src/browser/chrome";

const ownedSession = (visibility: Exclude<BrowserVisibility, "external">): ChromeSession => ({
  pid: 321,
  port: 43210,
  webSocketUrl: "ws://127.0.0.1:43210/devtools/browser/owned-browser",
  profileDir: "/Users/test/.config/chatgpt-consult/chrome-profile",
  ownership: "owned",
  visibility,
  reused: true,
});

class FakeController {
  readonly requested: Array<"headless" | "headed" | undefined> = [];
  closeCount = 0;
  sessions: ChromeSession[] = [ownedSession("headless")];
  closeError: Error | undefined;
  switchCount = 0;
  switchError: Error | undefined;

  async ensureRunning(visibility?: "headless" | "headed"): Promise<ChromeSession> {
    this.requested.push(visibility);
    return this.sessions[Math.min(this.requested.length - 1, this.sessions.length - 1)]!;
  }

  async closeOwned(): Promise<void> {
    this.closeCount++;
    if (this.closeError) throw this.closeError;
  }

  async switchOwnedToHeaded(): Promise<ChromeSession> {
    this.switchCount++;
    if (this.switchError) throw this.switchError;
    return this.sessions[Math.min(this.switchCount, this.sessions.length - 1)]!;
  }
}

const versionResponse = (webSocketDebuggerUrl: string): Response => new Response(
  JSON.stringify({ Browser: "Chrome/140", webSocketDebuggerUrl }),
  { status: 200, headers: { "content-type": "application/json" } },
);

describe("browser session selection", () => {
  test("routine managed sessions request headless Chrome", async () => {
    const controller = new FakeController();
    const manager = new BrowserSessionManager({ controller });

    const session = await manager.ensureRunning("headless");

    expect(controller.requested).toEqual(["headless"]);
    expect(session.visibility).toBe("headless");
  });

  test("managed headed ensure atomically replaces an already owned headless session", async () => {
    const controller = new FakeController();
    controller.sessions = [ownedSession("headless"), {
      ...ownedSession("headed"),
      pid: 654,
      reused: false,
    }];
    const manager = new BrowserSessionManager({ controller });

    const session = await manager.ensureRunning("headed");

    expect(controller.requested).toEqual(["headed"]);
    expect(controller.switchCount).toBe(1);
    expect(controller.closeCount).toBe(0);
    expect(session).toMatchObject({ pid: 654, ownership: "owned", visibility: "headed" });
  });

  test("login closes an owned headless session before reopening the profile headed", async () => {
    const controller = new FakeController();
    controller.sessions = [ownedSession("headless"), { ...ownedSession("headed"), reused: false }];
    const manager = new BrowserSessionManager({ controller });

    const session = await manager.switchOwnedToHeaded();

    expect(controller.requested).toEqual([]);
    expect(controller.switchCount).toBe(1);
    expect(controller.closeCount).toBe(0);
    expect(session.visibility).toBe("headed");
  });

  test("a failed owned close never starts a conflicting headed profile", async () => {
    const controller = new FakeController();
    controller.switchError = new ChromeControllerError("CLOSE_TIMEOUT");
    const manager = new BrowserSessionManager({ controller });

    await expect(manager.switchOwnedToHeaded()).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });

    expect(controller.requested).toEqual([]);
    expect(controller.switchCount).toBe(1);
    expect(controller.closeCount).toBe(0);
  });

  test("an already headed owned session is reused without a close", async () => {
    const controller = new FakeController();
    controller.sessions = [ownedSession("headed")];
    const manager = new BrowserSessionManager({ controller });

    const session = await manager.switchOwnedToHeaded();

    expect(session.visibility).toBe("headed");
    expect(controller.switchCount).toBe(1);
    expect(controller.closeCount).toBe(0);
  });

  test("explicit CDP is external and refuses owned-headed switching without closing", async () => {
    const controller = new FakeController();
    let attachments = 0;
    const manager = new BrowserSessionManager({
      controller,
      browserCdpPort: 45678,
      attachExternal: async (port) => {
        attachments++;
        return {
          pid: 0,
          port,
          webSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/external-browser`,
          profileDir: null,
          ownership: "external",
          visibility: "external",
          reused: true,
        };
      },
    });

    const routine = await manager.ensureRunning("headless");
    await expect(manager.switchOwnedToHeaded())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
    await manager.closeOwned();

    expect(routine).toMatchObject({ ownership: "external", visibility: "external", port: 45678 });
    expect(attachments).toBe(1);
    expect(controller.requested).toEqual([]);
    expect(controller.switchCount).toBe(0);
    expect(controller.closeCount).toBe(0);
  });

  test("external headed ensure attaches without switching, closing, or signalling managed Chrome", async () => {
    const controller = new FakeController();
    const manager = new BrowserSessionManager({
      controller,
      browserCdpPort: 45678,
      attachExternal: async (port) => ({
        pid: 0,
        port,
        webSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/external-browser`,
        profileDir: null,
        ownership: "external",
        visibility: "external",
        reused: true,
      }),
    });

    const session = await manager.ensureRunning("headed");

    expect(session).toMatchObject({ ownership: "external", visibility: "external" });
    expect(controller.requested).toEqual([]);
    expect(controller.switchCount).toBe(0);
    expect(controller.closeCount).toBe(0);
  });

  test("managed headed switching rejects a controller result that is still headless", async () => {
    const controller = new FakeController();
    controller.sessions = [ownedSession("headless")];
    const manager = new BrowserSessionManager({ controller });

    await expect(manager.switchOwnedToHeaded())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("explicit CDP accepts only integer ports in the TCP range", () => {
    for (const browserCdpPort of [0, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BrowserSessionManager({
        controller: new FakeController(),
        browserCdpPort,
      })).toThrow(RangeError);
    }
  });
});

describe("external CDP attachment", () => {
  test("accepts a bounded loopback browser WebSocket for the configured port", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const session = await attachExternalCdp(45678, {
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return versionResponse("ws://127.0.0.1:45678/devtools/browser/external-browser");
      },
    });

    expect(requestedUrl).toBe("http://127.0.0.1:45678/json/version");
    expect(requestedInit?.redirect).toBe("error");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(session).toEqual({
      pid: 0,
      port: 45678,
      webSocketUrl: "ws://127.0.0.1:45678/devtools/browser/external-browser",
      profileDir: null,
      ownership: "external",
      visibility: "external",
      reused: true,
    });
  });

  test("accepts the effective default ws port 80 without weakening same-port validation", async () => {
    const session = await attachExternalCdp(80, {
      fetchImpl: async () => versionResponse(
        "ws://127.0.0.1/devtools/browser/external-browser",
      ),
    });
    expect(session).toMatchObject({
      port: 80,
      webSocketUrl: "ws://127.0.0.1/devtools/browser/external-browser",
      ownership: "external",
    });
  });

  test("rejects malformed, non-loopback, credentialed, and wrong-port WebSockets", async () => {
    for (const value of [
      "not a URL",
      "ws://192.0.2.1:45678/devtools/browser/external-browser",
      "ws://user@127.0.0.1:45678/devtools/browser/external-browser",
      "ws://127.0.0.1:45679/devtools/browser/external-browser",
      "wss://127.0.0.1:45678/devtools/browser/external-browser",
    ]) {
      await expect(attachExternalCdp(45678, {
        fetchImpl: async () => versionResponse(value),
      })).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    }
  });

  test("rejects oversized version responses without returning endpoint content", async () => {
    const response = new Response("x".repeat(64 * 1024 + 1), { status: 200 });
    await expect(attachExternalCdp(45678, {
      fetchImpl: async () => response,
    })).rejects.toMatchObject({
      code: "UNSAFE_ENDPOINT",
      message: "The Chrome debugging endpoint is unsafe",
    });
  });
});
