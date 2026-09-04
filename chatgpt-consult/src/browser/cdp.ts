import { isAbsolute, join, resolve } from "node:path";

export const DEVTOOLS_ACTIVE_PORT_MAX_BYTES = 1_024;
export const VERSION_RESPONSE_MAX_BYTES = 64 * 1_024;

export interface ChromePaths {
  configRoot: string;
  profileDir: string;
  ownershipPath: string;
  lockPath: string;
  activePortPath: string;
}

export type BrowserVisibility = "headless" | "headed" | "external";
export type ManagedBrowserVisibility = Exclude<BrowserVisibility, "external">;

export type PathObservation =
  | { kind: "absent" }
  | { kind: "symlink" | "file" | "other" }
  | { kind: "directory"; owned: boolean; mode: number };

export interface OwnershipRecord {
  schemaVersion: 1;
  pid: number;
  executable: string;
  profileDir: string;
  launchNonce: string;
  startedAt: string;
  port: number;
  webSocketUrl: string;
  processBirth: ProcessBirthIdentity;
  visibility?: ManagedBrowserVisibility;
}

export interface ProcessBirthIdentity {
  kind: "linux-proc-start-ticks" | "darwin-ps-start";
  value: string;
}

export type RecordObservation =
  | { kind: "absent" | "symlink" | "wrong-owner" | "malformed" | "oversized" }
  | { kind: "valid"; value: OwnershipRecord };

export interface ProcessObservation {
  live: boolean;
  pid: number;
  executable: string;
  argv: string[];
  processBirth: ProcessBirthIdentity | null;
}

export interface ListenerObservation {
  host: string;
  port: number;
  pid: number;
}

export type ActivePortObservation =
  | { kind: "valid"; port: number; path: string }
  | { kind: "malformed" };

export type VersionObservation =
  | { kind: "valid"; webSocketUrl: string }
  | { kind: "malformed" };

export interface ChromeObservation {
  config: PathObservation;
  profile: PathObservation;
  profilePath: string | null;
  record: RecordObservation;
  process: ProcessObservation | null;
  listener: ListenerObservation | null;
  activePort: ActivePortObservation | null;
  version: VersionObservation | null;
}

export type ChromeRefusalCode =
  | "UNSAFE_CONFIG"
  | "PROFILE_CONFLICT"
  | "FOREIGN_LISTENER"
  | "UNSAFE_ENDPOINT"
  | "AMBIGUOUS_OWNERSHIP";

export type ChromeClassification =
  | { kind: "launch" }
  | { kind: "refuse"; code: ChromeRefusalCode }
  | {
      kind: "reuse";
      pid: number;
      port: number;
      webSocketUrl: string;
      profileDir: string;
      visibility: ManagedBrowserVisibility;
    };

export const configuredRoot = (environment: Readonly<Record<string, string | undefined>>): string => {
  const direct = environment.CHATGPT_CONSULT_CONFIG_HOME;
  const xdg = environment.XDG_CONFIG_HOME;
  const home = environment.HOME;
  const value = direct !== undefined
    ? direct
    : xdg !== undefined
      ? join(xdg, "chatgpt-consult")
      : home !== undefined
        ? join(home, ".config", "chatgpt-consult")
        : "";
  if (value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError("A safe absolute ChatGPT Consult configuration root is required");
  }
  return resolve(value);
};

export const resolveChromePaths = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChromePaths => {
  const configRoot = configuredRoot(environment);
  const profileDir = join(configRoot, "chrome-profile");
  return {
    configRoot,
    profileDir,
    ownershipPath: join(configRoot, "chrome-ownership.json"),
    lockPath: join(configRoot, "chrome-launch.lock"),
    activePortPath: join(profileDir, "DevToolsActivePort"),
  };
};

export const parseDevToolsActivePort = (text: string): ActivePortObservation => {
  if (Buffer.byteLength(text) > DEVTOOLS_ACTIVE_PORT_MAX_BYTES || text.includes("\0")) {
    return { kind: "malformed" };
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== 2 || !/^[1-9][0-9]{0,4}$/.test(lines[0] ?? "")) {
    return { kind: "malformed" };
  }
  const port = Number(lines[0]);
  const path = lines[1] ?? "";
  if (port < 1 || port > 65_535 || !/^\/devtools\/browser\/[^/?#\s]+$/.test(path)) {
    return { kind: "malformed" };
  }
  return { kind: "valid", port, path };
};

const safeWebSocket = (value: string, port: number, path: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "ws:"
    && url.hostname === "127.0.0.1"
    && (url.port || "80") === String(port)
    && url.username === ""
    && url.password === ""
    && url.hash === ""
    && url.search === ""
    && url.pathname === path
    && /^\/devtools\/browser\/[^/?#\s]+$/.test(url.pathname);
};

export const parseVersionResponse = (
  text: string,
  port: number,
  activePath?: string,
): VersionObservation => {
  if (Buffer.byteLength(text) > VERSION_RESPONSE_MAX_BYTES || text.includes("\0")) {
    return { kind: "malformed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return { kind: "malformed" };
  }
  const webSocketDebuggerUrl = (value as Record<string, unknown>).webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== "string") {
    return { kind: "malformed" };
  }
  let expectedPath = activePath;
  if (expectedPath === undefined) {
    try {
      expectedPath = new URL(webSocketDebuggerUrl).pathname;
    } catch {
      return { kind: "malformed" };
    }
  }
  if (!safeWebSocket(webSocketDebuggerUrl, port, expectedPath)) return { kind: "malformed" };
  return { kind: "valid", webSocketUrl: webSocketDebuggerUrl };
};

const configUnsafe = (path: PathObservation): boolean =>
  path.kind !== "directory" || !path.owned
  || (path.mode & 0o700) !== 0o700 || (path.mode & 0o077) !== 0;

const profileUnsafe = (path: PathObservation): boolean =>
  path.kind !== "directory" || !path.owned
  || ((path.mode & 0o700) !== 0o700 && (path.mode & 0o077) === 0);

const ambiguousEvidence = (observation: ChromeObservation): boolean =>
  observation.process?.live === true || observation.listener !== null;

export const classifyChrome = (observation: ChromeObservation): ChromeClassification => {
  if (configUnsafe(observation.config)) return { kind: "refuse", code: "UNSAFE_CONFIG" };
  if (profileUnsafe(observation.profile)) return { kind: "refuse", code: "PROFILE_CONFLICT" };

  if (observation.record.kind !== "valid") {
    if (observation.version?.kind === "valid") {
      return { kind: "refuse", code: "UNSAFE_ENDPOINT" };
    }
    if (observation.record.kind !== "absent" && ambiguousEvidence(observation)) {
      return { kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" };
    }
    if (observation.listener !== null) return { kind: "refuse", code: "FOREIGN_LISTENER" };
    if (observation.process?.live) return { kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" };
    return { kind: "launch" };
  }

  const owned = observation.record.value;
  if (!observation.process?.live) {
    if (observation.version?.kind === "valid") {
      return { kind: "refuse", code: "UNSAFE_ENDPOINT" };
    }
    return observation.listener === null
      ? { kind: "launch" }
      : { kind: "refuse", code: "FOREIGN_LISTENER" };
  }
  if (observation.process.pid !== owned.pid
    || observation.process.executable !== owned.executable
    || observation.process.processBirth === null
    || observation.process.processBirth.kind !== owned.processBirth.kind
    || observation.process.processBirth.value !== owned.processBirth.value) {
    return { kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" };
  }
  if (observation.profilePath === null || observation.profilePath !== owned.profileDir
    || observation.process.argv.filter((argument) => argument.startsWith("--user-data-dir="))
      .length !== 1
    || !observation.process.argv.includes(`--user-data-dir=${owned.profileDir}`)) {
    return { kind: "refuse", code: "PROFILE_CONFLICT" };
  }
  const visibility = owned.visibility ?? "headed";
  const headlessArgs = observation.process.argv.filter((argument) => argument.startsWith("--headless"));
  if ((visibility === "headless"
      && (headlessArgs.length !== 1 || headlessArgs[0] !== "--headless=new"))
    || (visibility === "headed" && headlessArgs.length !== 0)) {
    return { kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" };
  }
  if (observation.listener === null) {
    return { kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" };
  }
  if (observation.listener.host !== "127.0.0.1"
    || observation.listener.port !== owned.port
    || observation.listener.pid !== owned.pid) {
    return { kind: "refuse", code: "FOREIGN_LISTENER" };
  }
  if (observation.activePort?.kind !== "valid" || observation.version?.kind !== "valid") {
    return { kind: "refuse", code: "UNSAFE_ENDPOINT" };
  }
  let recordedPath: string;
  try {
    recordedPath = new URL(owned.webSocketUrl).pathname;
  } catch {
    return { kind: "refuse", code: "UNSAFE_ENDPOINT" };
  }
  if (observation.activePort.port !== owned.port
    || observation.activePort.path !== recordedPath
    || observation.version.webSocketUrl !== owned.webSocketUrl
    || !safeWebSocket(owned.webSocketUrl, owned.port, observation.activePort.path)) {
    return { kind: "refuse", code: "UNSAFE_ENDPOINT" };
  }
  return {
    kind: "reuse",
    pid: owned.pid,
    port: owned.port,
    webSocketUrl: owned.webSocketUrl,
    profileDir: owned.profileDir,
    visibility,
  };
};
