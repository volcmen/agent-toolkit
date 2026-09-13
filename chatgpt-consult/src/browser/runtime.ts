import { randomBytes as systemRandomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { AgentBrowserAutomation } from "./agent-browser.js";
import { CdpPageClient } from "./cdp-page.js";
import { configuredRoot } from "./cdp.js";
import { BrowserRateLimitGate } from "./rate-limit.js";
import { BrowserSessionManager } from "./session.js";
import { BrowserJob } from "./worker.js";
import { ContextService } from "../context/selection.js";
import { ConsultError } from "../core/errors.js";
import type { LocalConfig } from "../core/schema.js";
import { RequestStore } from "../core/store.js";
import type { ResolvedProject } from "../security/project.js";

const REQUEST_ID = /^[a-f0-9]{32}$/;
const OWNER_ID = /^[a-f0-9]{32}$/;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const HANDSHAKE_POLL_MS = 25;
const STDERR_LIMIT_BYTES = 8_192;
const CLEANUP_TIMEOUT_MS = 250;
const CURRENT_BIN = fileURLToPath(new URL("../../bin/chatgpt-consult.ts", import.meta.url));

export interface WorkerSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: "ignore";
  readonly stdout: "ignore";
  readonly stderr: "pipe";
  readonly shell: false;
}

export interface WorkerChild {
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  unref(): void;
}

export type WorkerSpawn = (
  argv: readonly string[],
  options: WorkerSpawnOptions,
) => WorkerChild;

export interface BrowserWorkerLauncherOptions {
  readonly project: ResolvedProject;
  readonly store: RequestStore;
  readonly currentBin?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly spawn?: WorkerSpawn;
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly deadlineWait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly handshakeTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}

const defaultSpawn: WorkerSpawn = (argv, options) => {
  const child = Bun.spawn(argv as string[], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  });
  return {
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal) => { child.kill(signal); },
    unref: () => { child.unref(); },
  };
};

const positiveBound = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
};

export const buildWorkerEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {
    PATH: source.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
  for (const key of [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "CHATGPT_CONSULT_CONFIG_HOME",
    "BUN_CHROME_PATH",
  ] as const) {
    const value = source[key];
    if (value !== undefined && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  return env;
};

const unavailable = (): ConsultError => new ConsultError(
  "UNAVAILABLE",
  "Browser worker unavailable",
  { reason: "browser_unavailable" },
);

const waitForDeadline = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
  });

const observeStderr = async (
  stream: ReadableStream<Uint8Array> | null,
  onOverflow: () => void,
  signal: AbortSignal,
): Promise<void> => {
  if (stream === null) return;
  const reader = stream.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        try { await reader.cancel(); } catch { /* bounded diagnostic cleanup */ }
        return;
      }
      const next = await reader.read();
      if (next.done) return;
      bytes += next.value.byteLength;
      if (bytes > STDERR_LIMIT_BYTES) {
        onOverflow();
        try { await reader.cancel(); } catch { /* bounded diagnostic cleanup */ }
        return;
      }
    }
  } catch {
    // Child diagnostics are optional and never become public error material.
  } finally {
    signal.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
};

export class BrowserWorkerLauncher {
  private readonly project: ResolvedProject;
  private readonly store: RequestStore;
  private readonly currentBin: string;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly spawn: WorkerSpawn;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly deadlineWait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly handshakeTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;

  constructor(options: BrowserWorkerLauncherOptions) {
    if (!isAbsolute(options.currentBin ?? CURRENT_BIN)
      || (options.currentBin ?? CURRENT_BIN).includes("\0")) {
      throw new TypeError("Current executable path must be absolute");
    }
    this.project = options.project;
    this.store = options.store;
    this.currentBin = options.currentBin ?? CURRENT_BIN;
    this.environment = options.environment ?? process.env;
    this.randomBytes = options.randomBytes ?? systemRandomBytes;
    this.spawn = options.spawn ?? defaultSpawn;
    this.now = options.now ?? performance.now.bind(performance);
    this.wallNow = options.wallNow ?? Date.now;
    this.wait = options.wait ?? (async (milliseconds) => { await Bun.sleep(milliseconds); });
    this.deadlineWait = options.deadlineWait ?? waitForDeadline;
    this.handshakeTimeoutMs = positiveBound(
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      "Handshake timeout",
    );
    this.cleanupTimeoutMs = positiveBound(
      options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
      "Cleanup timeout",
    );
  }

  async start(requestId: string): Promise<void> {
    if (!REQUEST_ID.test(requestId)) {
      throw new ConsultError("INVALID_INPUT", "Request identifier is invalid");
    }
    const entropy = this.randomBytes(16);
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) throw unavailable();
    const ownerId = Buffer.from(entropy).toString("hex");
    if (!OWNER_ID.test(ownerId)) throw unavailable();

    let child: WorkerChild;
    try {
      child = this.spawn([
        process.execPath,
        "run",
        this.currentBin,
        "worker",
        requestId,
        ownerId,
      ], {
        cwd: this.project.root,
        env: buildWorkerEnvironment(this.environment),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        shell: false,
      });
    } catch {
      throw unavailable();
    }

    let exited = false;
    let stderrOverflow = false;
    const stderrController = new AbortController();
    const childExit = child.exited.then(
      () => { exited = true; return { kind: "child_exit" as const }; },
      () => { exited = true; return { kind: "child_exit" as const }; },
    );
    void observeStderr(child.stderr, () => {
      stderrOverflow = true;
      try { child.kill("SIGTERM"); } catch { /* child already exited */ }
    }, stderrController.signal);
    const deadline = this.now() + this.handshakeTimeoutMs;
    const deadlineController = new AbortController();
    const deadlineReached = Promise.resolve()
      .then(() => {
        const remaining = deadline - this.now();
        if (remaining <= 0) return;
        return this.deadlineWait(remaining, deadlineController.signal);
      })
      .then(
        () => ({ kind: "deadline" as const }),
        () => ({ kind: "deadline" as const }),
      );
    try {
      for (;;) {
        if (exited || stderrOverflow || this.now() >= deadline) throw unavailable();
        const stateRead = Promise.resolve()
          .then(() => this.store.get(requestId))
          .then(
            (request) => ({ kind: "request" as const, request }),
            () => ({ kind: "state_failure" as const }),
          );
        const observed = await Promise.race([stateRead, childExit, deadlineReached]);
        if (observed.kind !== "request") throw unavailable();
        if (exited || stderrOverflow || this.now() >= deadline) throw unavailable();
        const request = observed.request;
        const lease = request.browserExecution?.lease;
        if (lease?.ownerId === ownerId
          && new Date(lease.expiresAt).getTime() > this.wallNow()) {
          if (exited || stderrOverflow || this.now() >= deadline) throw unavailable();
          deadlineController.abort();
          try {
            child.unref();
          } catch {
            throw unavailable();
          }
          stderrController.abort();
          return;
        }
        if (request.state === "cancelled" || request.state === "completed"
          || request.state === "expired") {
          throw unavailable();
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) throw unavailable();
        const poll = Promise.resolve()
          .then(() => this.wait(Math.min(HANDSHAKE_POLL_MS, remaining)))
          .then(
            () => ({ kind: "poll" as const }),
            () => ({ kind: "poll_failure" as const }),
          );
        const paused = await Promise.race([poll, childExit, deadlineReached]);
        if (paused.kind !== "poll") throw unavailable();
      }
    } catch {
      deadlineController.abort();
      await this.stopChild(child);
      stderrController.abort();
      throw unavailable();
    }
  }

  private async stopChild(child: WorkerChild): Promise<void> {
    try { child.kill("SIGTERM"); } catch { /* child already exited */ }
    let settled = false;
    void child.exited.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.race([
      child.exited.then(() => undefined, () => undefined),
      this.wait(this.cleanupTimeoutMs),
    ]);
    if (settled) return;
    try { child.kill("SIGKILL"); } catch { /* child already exited */ }
    await Promise.race([
      child.exited.then(() => undefined, () => undefined),
      this.wait(this.cleanupTimeoutMs),
    ]);
  }
}

export interface BrowserRuntimeOptions {
  readonly store?: RequestStore;
  readonly context?: ContextService;
  readonly sessionManager?: BrowserSessionManager;
  readonly automation?: AgentBrowserAutomation;
}

export interface BrowserRuntime {
  readonly store: RequestStore;
  readonly context: ContextService;
  readonly sessionManager: BrowserSessionManager;
  readonly automation: AgentBrowserAutomation;
  readonly job: BrowserJob;
}

export const createBrowserRuntime = async (
  project: ResolvedProject,
  config: LocalConfig,
  options: BrowserRuntimeOptions = {},
): Promise<BrowserRuntime> => {
  if (config.chatgptProjectUrl === undefined) {
    throw new ConsultError("UNAVAILABLE", "A ChatGPT Project URL is required");
  }
  const store = options.store ?? await RequestStore.init(project);
  const context = options.context ?? new ContextService(project, store);
  const sessionManager = options.sessionManager ?? new BrowserSessionManager({
    ...(config.browserCdpPort === undefined ? {} : { browserCdpPort: config.browserCdpPort }),
  });
  const automation = options.automation ?? new AgentBrowserAutomation({
    cdpPageClientFactory: (input) => new CdpPageClient(input),
    rateLimitGate: new BrowserRateLimitGate(configuredRoot(process.env)),
  });
  const job = new BrowserJob({
    project,
    store,
    projectUrl: config.chatgptProjectUrl,
    sessionManager,
    automation,
  });
  return { store, context, sessionManager, automation, job };
};

export interface BrowserSetupResult {
  readonly kind: "browser";
  readonly mode: "managed" | "external";
  readonly opened: boolean;
  readonly authentication: "authenticated" | "pending" | "manual";
}

export interface BrowserSetupOptions {
  readonly sessionManager?: BrowserSessionManager;
  readonly automation?: Pick<AgentBrowserAutomation, "waitForAuthenticatedProject">;
  readonly deadlineMs?: number;
}

export const setupBrowserSession = async (
  config: LocalConfig,
  options: BrowserSetupOptions = {},
): Promise<BrowserSetupResult> => {
  if (config.chatgptProjectUrl === undefined) {
    throw new ConsultError("INVALID_INPUT", "Configure a ChatGPT Project URL before browser setup");
  }
  const sessionManager = options.sessionManager ?? new BrowserSessionManager({
    ...(config.browserCdpPort === undefined ? {} : { browserCdpPort: config.browserCdpPort }),
  });
  const automation = options.automation ?? new AgentBrowserAutomation();
  try {
    const session = await sessionManager.ensureRunning("headed");
    let navigationConfirmed = false;
    const authentication = await automation.waitForAuthenticatedProject({
      session,
      projectUrl: config.chatgptProjectUrl,
      deadlineMs: options.deadlineMs ?? 1_000,
    }, {
      beforeSubmission: async () => {},
      submissionConfirmed: async () => {},
      heartbeat: async () => {},
      isCancelled: async () => false,
      navigationConfirmed: async () => { navigationConfirmed = true; },
    });
    return {
      kind: "browser",
      mode: config.browserCdpPort === undefined ? "managed" : "external",
      opened: authentication === "authenticated" || navigationConfirmed,
      authentication: authentication === "timed_out" ? "pending" : authentication,
    };
  } catch {
    throw unavailable();
  }
};
