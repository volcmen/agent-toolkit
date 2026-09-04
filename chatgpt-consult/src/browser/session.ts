import {
  ChromeController,
  ChromeControllerError,
  fetchExternalCdpVersion,
  type FetchLike,
  type ChromeSession,
} from "./chrome.js";
import type { ManagedBrowserVisibility } from "./cdp.js";

export type { BrowserVisibility } from "./cdp.js";

const EXTERNAL_CDP_TIMEOUT_MS = 1_000;

export interface ExternalCdpOptions {
  fetchImpl?: FetchLike;
}

const validPort = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= 65_535;

export async function attachExternalCdp(
  port: number,
  options: ExternalCdpOptions = {},
): Promise<ChromeSession> {
  if (!validPort(port)) throw new RangeError("External Chrome CDP port is invalid");
  const observation = await fetchExternalCdpVersion(
    port,
    EXTERNAL_CDP_TIMEOUT_MS,
    options.fetchImpl ?? fetch,
  );
  if (observation.kind !== "valid") throw new ChromeControllerError("UNSAFE_ENDPOINT");
  return {
    pid: 0,
    port,
    webSocketUrl: observation.webSocketUrl,
    profileDir: null,
    ownership: "external",
    visibility: "external",
    reused: true,
  };
}

interface ManagedController {
  ensureRunning(visibility?: ManagedBrowserVisibility): Promise<ChromeSession>;
  switchOwnedToHeaded(): Promise<ChromeSession>;
  closeOwned(): Promise<void>;
}

export interface BrowserSessionManagerOptions {
  controller?: ManagedController;
  browserCdpPort?: number;
  attachExternal?: (port: number) => Promise<ChromeSession>;
}

export class BrowserSessionManager {
  private readonly controller: ManagedController;
  private readonly browserCdpPort: number | undefined;
  private readonly attachExternal: (port: number) => Promise<ChromeSession>;

  constructor(options: BrowserSessionManagerOptions = {}) {
    if (options.browserCdpPort !== undefined && !validPort(options.browserCdpPort)) {
      throw new RangeError("External Chrome CDP port is invalid");
    }
    this.controller = options.controller ?? new ChromeController();
    this.browserCdpPort = options.browserCdpPort;
    this.attachExternal = options.attachExternal ?? attachExternalCdp;
  }

  async ensureRunning(visibility: ManagedBrowserVisibility = "headless"): Promise<ChromeSession> {
    if (this.browserCdpPort !== undefined) {
      const external = await this.attachExternal(this.browserCdpPort);
      if (external.ownership !== "external" || external.visibility !== "external") {
        throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
      }
      return external;
    }
    let managed = await this.controller.ensureRunning(visibility);
    if (visibility === "headed" && managed.ownership === "owned"
      && managed.visibility === "headless") {
      managed = await this.controller.switchOwnedToHeaded();
    }
    if (managed.ownership !== "owned"
      || (visibility === "headed" && managed.visibility !== "headed")) {
      throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
    }
    return managed;
  }

  async switchOwnedToHeaded(): Promise<ChromeSession> {
    if (this.browserCdpPort !== undefined) {
      throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
    }
    const session = await this.controller.switchOwnedToHeaded();
    if (session.ownership !== "owned" || session.visibility !== "headed") {
      throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
    }
    return session;
  }

  async closeOwned(): Promise<void> {
    if (this.browserCdpPort === undefined) await this.controller.closeOwned();
  }
}
