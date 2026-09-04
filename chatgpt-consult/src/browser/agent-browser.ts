import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  classifyObservedChatgptUrl,
  sanitizeChatgptUrl,
  type AuthenticationProbeInput,
  type BrowserAutomationHooks,
  type BrowserAutomationInput,
  type BrowserAutomationResult,
  type BrowserSubmitInput,
  type BrowserSubmitResult,
  type BrowserSubmitter,
} from "./handoff.js";
import { runBoundedDiagnosticResult } from "./chrome.js";
import { HARD_BUDGET, type BrowserFailureReason, type SubmissionCertainty } from "../core/schema.js";
import {
  BROWSER_RESULT_BEGIN,
  BROWSER_RESULT_END,
  BrowserCompletionEnvelopeSchema,
} from "./protocol.js";
import {
  unthrottlePage,
  watchForTurnCompletion,
  type TurnWatchClient,
  type TurnWatchOutcome,
  type UnthrottleClient,
  type UnthrottleRestoreOutcome,
} from "./turn-watch.js";

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_DEADLINE_MS = 20_000;
const MAX_STDOUT_BYTES = 12_288;
const SNAPSHOT_STDOUT_BYTES = 131_072;
const COMPOSER_RETRY_INTERVAL_MS = 1_000;
const CLEANUP_BUDGET_MS = 1_000;
const TAB_CLEANUP_BUDGET_MS = 2_000;
const FINAL_ANSWER_STABLE_PAIRS = 3;
const MAX_REFS = 256;
const POST_COMPLETION_TEXT_MS = 180_000;
const IMMEDIATE_ANSWER_READ_BUDGET_MS = 5_000;
const HINT_READ_COOLDOWN_MS = IMMEDIATE_ANSWER_READ_BUDGET_MS;

const MSG_UNAVAILABLE_EXECUTABLE = "Agent-browser executable not found.";
const MSG_UNAVAILABLE_TARGET = "Target URL is not a valid ChatGPT endpoint.";
const MSG_UNAVAILABLE_START = "Browser automation could not start.";
const MSG_MANUAL_PROMPT = "Prompt area not found.";
const MSG_MANUAL_SUBMISSION = "Submission could not complete.";

const REF_KEY_RE = /^e[1-9][0-9]{0,3}$/;
const TARGET_ID_RE = /^[A-Fa-f0-9]{32}$/;
const COMPOSER_NAMES: ReadonlySet<string> = new Set([
  "message chatgpt",
  "ask chatgpt",
  "ask anything",
  "chat with chatgpt",
  "prompt",
]);
const isComposerAccessibleName = (name: string): boolean =>
  COMPOSER_NAMES.has(name) || (name.startsWith("new chat in ") && name.length > "new chat in ".length);

// ─── Policy ──────────────────────────────────────────────────────────

export const AGENT_BROWSER_POLICY = Object.freeze({
  default: "deny",
  allow: Object.freeze([
    "launch", "navigate", "open", "snapshot", "get", "count", "find", "nth", "click", "fill",
    "press", "wait", "interact", "upload", "url",
    "tab_close",
  ] as const),
  deny: Object.freeze([
    "eval", "evalhandle", "addscript", "addinitscript", "addstyle", "expose",
    "setcontent", "download", "waitfordownload", "network", "route", "unroute",
    "requests", "har", "state", "cookies", "storage",
  ] as const),
});

// ─── Types ───────────────────────────────────────────────────────────

export interface RunnerOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export type CommandRunner = (
  argv: readonly string[],
  options: RunnerOptions,
) => Promise<{ status: number; output: string }>;

export interface WorkspacePaths {
  readonly dir: string;
  readonly policyPath: string;
  readonly configPath: string;
}

export type WorkspaceFactory = () => Promise<WorkspacePaths>;
export type WorkspaceCleanup = (dir: string) => Promise<void>;

export interface AgentBrowserSubmitterOptions {
  readonly executablePath?: string | null;
  readonly commandRunner?: CommandRunner;
  readonly workspaceFactory?: WorkspaceFactory;
  readonly workspaceCleanup?: WorkspaceCleanup;
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseEnvelope(output: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.success !== true) return null;
    if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) return null;
    return obj.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findComposerRef(data: Record<string, unknown>): string | null {
  const refs = data.refs;
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) return null;
  const refsObj = refs as Record<string, unknown>;
  const keys = Object.keys(refsObj);
  if (keys.length > MAX_REFS) return null;

  const matches: string[] = [];
  for (const key of keys) {
    if (!REF_KEY_RE.test(key)) continue;
    const value = refsObj[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.role !== "textbox") continue;
    if (typeof entry.name !== "string") continue;
    const normalized = entry.name.trim().toLowerCase();
    if (isComposerAccessibleName(normalized)) {
      matches.push(key);
    }
  }

  if (matches.length !== 1) return null;
  return matches[0]!;
}

// ─── Default implementations ─────────────────────────────────────────

const defaultCommandRunner: CommandRunner = async (argv, options) => {
  const child = Bun.spawn(argv as string[], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "ignore",
  });
  return runBoundedDiagnosticResult(
    {
      stdout: child.stdout,
      exited: child.exited,
      kill: (signal) => { child.kill(signal); },
    },
    {
      timeoutMs: options.timeoutMs,
      maximumBytes: options.maxBytes,
      cleanupTimeoutMs: CLEANUP_BUDGET_MS,
    },
  );
};

const defaultWorkspaceFactory: WorkspaceFactory = async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ab-"));
  try {
    await fs.promises.chmod(dir, 0o700);

    const policyPath = path.join(dir, "action-policy.json");
    const configPath = path.join(dir, "agent-browser.json");

    const policyJson = JSON.stringify(AGENT_BROWSER_POLICY, null, 2) + "\n";
    await fs.promises.writeFile(policyPath, policyJson, { mode: 0o600 });
    await fs.promises.writeFile(configPath, "{}\n", { mode: 0o600 });

    return { dir, policyPath, configPath };
  } catch (setupError) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // swallow cleanup error; original setup failure must propagate
    }
    throw setupError;
  }
};

const defaultWorkspaceCleanup: WorkspaceCleanup = async (dir) => {
  await fs.promises.rm(dir, { recursive: true, force: true });
};

// ─── AgentBrowserSubmitter ───────────────────────────────────────────

export class AgentBrowserSubmitter implements BrowserSubmitter {
  private readonly executablePath: string | null | undefined;
  private readonly runner: CommandRunner;
  private readonly factory: WorkspaceFactory;
  private readonly cleanup: WorkspaceCleanup;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options?: AgentBrowserSubmitterOptions) {
    if (options?.executablePath !== undefined && options.executablePath !== null && typeof options.executablePath !== "string") {
      throw new TypeError("executablePath must be string | null");
    }
    if (options?.commandRunner !== undefined && typeof options.commandRunner !== "function") {
      throw new TypeError("commandRunner must be a function");
    }
    if (options?.workspaceFactory !== undefined && typeof options.workspaceFactory !== "function") {
      throw new TypeError("workspaceFactory must be a function");
    }
    if (options?.workspaceCleanup !== undefined && typeof options.workspaceCleanup !== "function") {
      throw new TypeError("workspaceCleanup must be a function");
    }
    if (options?.deadlineMs !== undefined) {
      if (typeof options.deadlineMs !== "number" || !Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
        throw new TypeError("deadlineMs must be a positive finite number");
      }
    }
    if (options?.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (options?.sleep !== undefined && typeof options.sleep !== "function") {
      throw new TypeError("sleep must be a function");
    }

    this.executablePath = options?.executablePath;
    this.runner = options?.commandRunner ?? defaultCommandRunner;
    this.factory = options?.workspaceFactory ?? defaultWorkspaceFactory;
    this.cleanup = options?.workspaceCleanup ?? defaultWorkspaceCleanup;
    this.deadlineMs = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.now = options?.now ?? performance.now.bind(performance);
    this.sleep = options?.sleep
      ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
  }

  async submit(input: BrowserSubmitInput): Promise<BrowserSubmitResult> {
    const executable = this.resolveExecutable();
    if (executable === null) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_EXECUTABLE };
    }

    const canonicalUrl = sanitizeChatgptUrl(input.targetUrl, input.targetKind);
    if (canonicalUrl === null) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_TARGET };
    }

    let workspace: WorkspacePaths;
    try {
      workspace = await this.factory();
    } catch {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_START };
    }

    try {
      return await this.executeSteps(input, executable, canonicalUrl, workspace);
    } finally {
      try {
        await this.cleanup(workspace.dir);
      } catch {
        // cleanup failure does not change the safe result
      }
    }
  }

  private resolveExecutable(): string | null {
    if (this.executablePath !== undefined) {
      return this.executablePath;
    }
    try {
      const BunGlobal = globalThis as Record<string, unknown>;
      const BunNS = BunGlobal.Bun as Record<string, unknown> | undefined;
      if (BunNS && typeof BunNS.which === "function") {
        const result = (BunNS.which as (name: string) => string | null)("agent-browser");
        return result ?? null;
      }
    } catch {
      // Bun.which unavailable
    }
    return null;
  }

  private async executeSteps(
    input: BrowserSubmitInput,
    executable: string,
    canonicalUrl: string,
    workspace: WorkspacePaths,
  ): Promise<BrowserSubmitResult> {
    const deadline = this.now() + this.deadlineMs;
    const env = this.buildEnv(workspace.dir);
    const globalArgs = this.buildGlobalArgs(executable, input.session.port, workspace);

    // Step 1: open <canonical URL>
    if (this.now() >= deadline) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_START };
    }
    const openOk = await this.runCommand([...globalArgs, "open", canonicalUrl], workspace, env, deadline);
    if (!openOk) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_START };
    }

    // Step 2: get url — revalidate actual page after open
    if (this.now() >= deadline) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_START };
    }
    const postOpenUrl = await this.readValidatedUrl(globalArgs, workspace, env, deadline);
    if (postOpenUrl === null) {
      return { kind: "unavailable", message: MSG_UNAVAILABLE_START };
    }

    // Step 3: snapshot -i
    if (this.now() >= deadline) {
      return { kind: "opened_manual", message: MSG_MANUAL_PROMPT };
    }
    let refKey: string | null = null;
    for (;;) {
      const snapshotData = await this.runCommandReturningData([...globalArgs, "snapshot", "-i"], workspace, env, deadline);
      if (snapshotData === null) {
        return { kind: "opened_manual", message: MSG_MANUAL_PROMPT };
      }
      refKey = findComposerRef(snapshotData);
      if (refKey !== null) break;
      if (this.now() + COMPOSER_RETRY_INTERVAL_MS >= deadline) {
        return { kind: "opened_manual", message: MSG_MANUAL_PROMPT };
      }
      await this.sleep(COMPOSER_RETRY_INTERVAL_MS);
    }

    // Step 4: get url — revalidate actual page before fill
    if (this.now() >= deadline) {
      return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
    }
    const preFillUrl = await this.readValidatedUrl(globalArgs, workspace, env, deadline);
    if (preFillUrl === null || preFillUrl !== postOpenUrl) {
      return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
    }

    // Step 5: fill @<ref> <handoff>
    if (this.now() >= deadline) {
      return { kind: "opened_manual", message: MSG_MANUAL_SUBMISSION };
    }
    const fillOk = await this.runCommand([...globalArgs, "fill", `@${refKey}`, input.handoff], workspace, env, deadline);
    if (!fillOk) {
      return { kind: "opened_manual", message: MSG_MANUAL_SUBMISSION };
    }

    // Step 6: press Enter
    if (this.now() >= deadline) {
      return { kind: "opened_manual", message: MSG_MANUAL_SUBMISSION };
    }
    const pressOk = await this.runCommand([...globalArgs, "press", "Enter"], workspace, env, deadline);
    if (!pressOk) {
      return { kind: "opened_manual", message: MSG_MANUAL_SUBMISSION };
    }

    // Step 7: get url — final URL check
    if (this.now() < deadline) {
      const finalUrl = await this.readValidatedUrl(globalArgs, workspace, env, deadline);
      if (finalUrl !== null) {
        const conversationUrl = finalUrl !== canonicalUrl ? finalUrl : undefined;
        if (conversationUrl !== undefined) {
          return { kind: "submitted", conversationUrl };
        }
        return { kind: "submitted" };
      }
    }
    return { kind: "unavailable", message: MSG_MANUAL_SUBMISSION };
  }

  private async readValidatedUrl(
    globalArgs: readonly string[],
    workspace: WorkspacePaths,
    env: Record<string, string>,
    deadline: number,
  ): Promise<string | null> {
    const urlData = await this.runCommandReturningData([...globalArgs, "get", "url"], workspace, env, deadline);
    if (urlData === null) return null;
    const rawUrl = urlData.url;
    if (typeof rawUrl !== "string") return null;
    return sanitizeChatgptUrl(rawUrl, "conversation");
  }

  private buildGlobalArgs(
    executable: string,
    port: number,
    workspace: WorkspacePaths,
  ): readonly string[] {
    return [
      executable,
      "--session", "chatgpt-consult",
      "--cdp", String(port),
      "--pin-tab",
      "--content-boundaries",
      "--max-output", "12000",
      "--action-policy", workspace.policyPath,
      "--config", workspace.configPath,
      "--idle-timeout", "10s",
      "--json",
    ];
  }

  private buildEnv(workspaceDir: string): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      HOME: workspaceDir,
      XDG_CONFIG_HOME: workspaceDir,
    };
    const tmpdir = process.env.TMPDIR;
    if (tmpdir !== undefined && tmpdir.length > 0) {
      env.TMPDIR = tmpdir;
    }
    return env;
  }

  private async runCommand(
    argv: string[],
    workspace: WorkspacePaths,
    env: Record<string, string>,
    deadline: number,
  ): Promise<boolean> {
    const data = await this.runCommandReturningData(argv, workspace, env, deadline);
    return data !== null;
  }

  private async runCommandReturningData(
    argv: string[],
    workspace: WorkspacePaths,
    env: Record<string, string>,
    deadline: number,
  ): Promise<Record<string, unknown> | null> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      return null;
    }

    try {
      const result = await this.runner(argv, {
        cwd: workspace.dir,
        env,
        timeoutMs: remaining,
        maxBytes: MAX_STDOUT_BYTES,
      });

      if (this.now() >= deadline) {
        return null;
      }

      if (result.status !== 0) {
        return null;
      }

      return parseEnvelope(result.output);
    } catch {
      return null;
    }
  }
}

// ─── Full browser automation ────────────────────────────────────────

const AUTOMATION_DEADLINE_MS = 10 * 60_000;
const AUTHENTICATION_DEADLINE_MAX_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const INTERACTIVE_LOAD_SETTLE_MS = 10_000;
const POST_SUBMISSION_NAVIGATION_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PROMPT_MAX_BYTES = 65_536;
const RESPONSE_OVERHEAD_BYTES = 16_384;
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const UPLOAD_SELECTOR = "input[type=file]";
const SAFE_REQUEST_ID = /^[a-f0-9]{32}$/;
const CONVERSATION_PATH_RE = /\/c\/([^/?#]+)$/;

export interface CdpPageClientLike extends TurnWatchClient, UnthrottleClient {
  connect(): Promise<void>;
  close(): void;
  resetBufferedFrames(): void;
}

export interface CdpPageClientFactoryInput {
  readonly port: number;
  readonly targetId: string;
}

export type CdpPageClientFactory = (input: CdpPageClientFactoryInput) => CdpPageClientLike;

export interface AgentBrowserAutomationOptions {
  readonly executablePath?: string | null;
  readonly commandRunner?: CommandRunner;
  readonly workspaceFactory?: WorkspaceFactory;
  readonly workspaceCleanup?: WorkspaceCleanup;
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly commandWait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly ownedTabCleanup?: OwnedTabCleanup;
  readonly cdpPageClientFactory?: CdpPageClientFactory;
}

export interface OwnedTabCleanupInput {
  readonly executable: string;
  readonly targetId: string;
  readonly sessionPort: number;
  readonly workspace: WorkspacePaths;
  readonly env: Record<string, string>;
}

export type OwnedTabCleanup = (input: OwnedTabCleanupInput) => Promise<void>;

interface AutomationContext {
  readonly executable: string;
  readonly sessionPort: number;
  readonly workspace: WorkspacePaths;
  readonly env: Record<string, string>;
  readonly hooks: BrowserAutomationHooks;
  readonly deadline: number;
  lastHeartbeat: number;
  ownedTargetId?: string;
  eventClient?: CdpPageClientLike | undefined;
  eventRestore?: (() => Promise<UnthrottleRestoreOutcome>) | undefined;
}

const defaultOwnedTabCleanup: OwnedTabCleanup = async (input) => {
  await defaultCommandRunner([
    input.executable,
    "--session", "chatgpt-consult",
    "--cdp", String(input.sessionPort),
    "--pin-tab",
    "--content-boundaries",
    "--max-output", "12000",
    "--action-policy", input.workspace.policyPath,
    "--config", input.workspace.configPath,
    "--idle-timeout", "10s",
    "--json",
    "tab", "close", input.targetId,
  ], {
    cwd: input.workspace.dir,
    env: input.env,
    timeoutMs: TAB_CLEANUP_BUDGET_MS,
    maxBytes: MAX_STDOUT_BYTES,
  });
};

type StepFailure = "cancelled" | "timed_out" | "command_failed";
type StepResult<T> = { kind: "ok"; value: T } | { kind: "failed"; failure: StepFailure };

type HeartbeatWatchOutcome = TurnWatchOutcome | { kind: "hint_recovered"; responseText: string };
type HeartbeatRaceResult =
  | { kind: "watch"; value: TurnWatchOutcome }
  | { kind: "elapsed" }
  | { kind: "wait_failed" }
  | { kind: "hint_read"; text: string | null };

interface InteractiveState {
  readonly composerRefs: readonly string[];
  readonly projectNewChatRefs: readonly string[];
  readonly hasStopControl: boolean;
  readonly hasSignInControl: boolean;
  readonly hasHumanChallenge: boolean;
  readonly hasAmbiguousDialog: boolean;
}

const normalizeAccessibleName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
};

const analyzeInteractiveState = (data: Record<string, unknown>): InteractiveState | null => {
  const refs = data.refs;
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) return null;
  const entries = Object.entries(refs as Record<string, unknown>);
  if (entries.length > MAX_REFS) return null;

  const composerRefs: string[] = [];
  const projectNewChatRefs: string[] = [];
  let hasStopControl = false;
  let hasSignInControl = false;
  let hasHumanChallenge = false;
  let hasAmbiguousDialog = false;

  for (const [key, raw] of entries) {
    if (!REF_KEY_RE.test(key) || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
    if (role === "dialog") hasAmbiguousDialog = true;
    const name = normalizeAccessibleName(entry.name);
    if (name === null) continue;

    if (role === "textbox" && isComposerAccessibleName(name)) composerRefs.push(key);
    if ((role === "button" || role === "link")
      && name.includes("new chat") && name.includes("project")) {
      projectNewChatRefs.push(key);
    }
    if ((role === "button" || role === "link") && (name === "stop" || name.startsWith("stop "))) {
      hasStopControl = true;
    }
    if ((role === "button" || role === "link")
      && (name === "log in" || name === "sign in" || name === "sign up")) {
      hasSignInControl = true;
    }
    if (name.includes("captcha") || name.includes("verify you are human")
      || name.includes("accept all cookies") || name.includes("accept cookies")
      || name === "consent" || name === "i agree") {
      hasHumanChallenge = true;
    }
  }

  return {
    composerRefs,
    projectNewChatRefs,
    hasStopControl,
    hasSignInControl,
    hasHumanChallenge,
    hasAmbiguousDialog,
  };
};

const resolveAgentBrowserExecutable = (configured: string | null | undefined): string | null => {
  if (configured !== undefined) return configured;
  try {
    const bunNamespace = (globalThis as Record<string, unknown>).Bun as Record<string, unknown> | undefined;
    if (bunNamespace !== undefined && typeof bunNamespace.which === "function") {
      return (bunNamespace.which as (name: string) => string | null)("agent-browser") ?? null;
    }
  } catch {
    // Availability is reported as a closed browser recovery reason.
  }
  return null;
};

const recovery = (
  reason: BrowserFailureReason,
  certainty: SubmissionCertainty,
  conversationUrl?: string,
  rejectedText?: string,
): BrowserAutomationResult => ({
  kind: "recovery",
  phase: reason === "login_required" ? "needs_login" : "needs_manual",
  reason,
  certainty,
  ...(conversationUrl !== undefined ? { conversationUrl } : {}),
  ...(rejectedText !== undefined ? { rejectedText } : {}),
});

const responseBelongsToRequest = (text: string, requestId: string): boolean => {
  const begin = text.indexOf(BROWSER_RESULT_BEGIN);
  const end = text.indexOf(BROWSER_RESULT_END);
  if (begin === -1 || end === -1
    || begin !== text.lastIndexOf(BROWSER_RESULT_BEGIN)
    || end !== text.lastIndexOf(BROWSER_RESULT_END)) {
    return false;
  }
  const payloadStart = begin + BROWSER_RESULT_BEGIN.length;
  if (end <= payloadStart) return false;
  try {
    const parsed: unknown = JSON.parse(text.slice(payloadStart, end).trim());
    const envelope = BrowserCompletionEnvelopeSchema.safeParse(parsed);
    return envelope.success && envelope.data.requestId === requestId;
  } catch {
    return false;
  }
};

const responseIsFinalButUnusable = (text: string): boolean => {
  const begin = text.indexOf(BROWSER_RESULT_BEGIN);
  const end = text.indexOf(BROWSER_RESULT_END);
  if (end === -1) return false;
  if (begin === -1 || end <= begin + BROWSER_RESULT_BEGIN.length) return true;
  try {
    const parsed: unknown = JSON.parse(text.slice(begin + BROWSER_RESULT_BEGIN.length, end).trim());
    return !BrowserCompletionEnvelopeSchema.safeParse(parsed).success;
  } catch {
    return true;
  }
};

const extractConversationId = (conversationUrl: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(conversationUrl);
  } catch {
    return null;
  }
  const match = CONVERSATION_PATH_RE.exec(parsed.pathname);
  return match !== null ? match[1]! : null;
};

export class AgentBrowserAutomation {
  private readonly executablePath: string | null | undefined;
  private readonly runner: CommandRunner;
  private readonly factory: WorkspaceFactory;
  private readonly cleanup: WorkspaceCleanup;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly commandWait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly ownedTabCleanup: OwnedTabCleanup;
  private readonly cdpPageClientFactory: CdpPageClientFactory | undefined;

  constructor(options: AgentBrowserAutomationOptions = {}) {
    if (options.executablePath !== undefined && options.executablePath !== null
      && typeof options.executablePath !== "string") {
      throw new TypeError("executablePath must be string | null");
    }
    if (options.commandRunner !== undefined && typeof options.commandRunner !== "function") {
      throw new TypeError("commandRunner must be a function");
    }
    if (options.workspaceFactory !== undefined && typeof options.workspaceFactory !== "function") {
      throw new TypeError("workspaceFactory must be a function");
    }
    if (options.workspaceCleanup !== undefined && typeof options.workspaceCleanup !== "function") {
      throw new TypeError("workspaceCleanup must be a function");
    }
    if (options.deadlineMs !== undefined
      && (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0
        || options.deadlineMs > AUTOMATION_DEADLINE_MS)) {
      throw new RangeError("Browser automation deadline is invalid");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (options.sleep !== undefined && typeof options.sleep !== "function") {
      throw new TypeError("sleep must be a function");
    }
    if (options.commandWait !== undefined && typeof options.commandWait !== "function") {
      throw new TypeError("commandWait must be a function");
    }
    if (options.ownedTabCleanup !== undefined && typeof options.ownedTabCleanup !== "function") {
      throw new TypeError("ownedTabCleanup must be a function");
    }
    if (options.cdpPageClientFactory !== undefined && typeof options.cdpPageClientFactory !== "function") {
      throw new TypeError("cdpPageClientFactory must be a function");
    }
    this.executablePath = options.executablePath;
    this.runner = options.commandRunner ?? defaultCommandRunner;
    this.factory = options.workspaceFactory ?? defaultWorkspaceFactory;
    this.cleanup = options.workspaceCleanup ?? defaultWorkspaceCleanup;
    this.deadlineMs = options.deadlineMs ?? AUTOMATION_DEADLINE_MS;
    this.now = options.now ?? performance.now.bind(performance);
    this.sleep = options.sleep ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
    this.commandWait = options.commandWait ?? (async (milliseconds, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        signal.addEventListener("abort", finish, { once: true });
      });
    });
    this.ownedTabCleanup = options.ownedTabCleanup ?? defaultOwnedTabCleanup;
    this.cdpPageClientFactory = options.cdpPageClientFactory;
  }

  get eventCollectionEnabled(): boolean {
    return this.cdpPageClientFactory !== undefined;
  }

  async run(
    input: BrowserAutomationInput,
    hooks: BrowserAutomationHooks,
  ): Promise<BrowserAutomationResult> {
    const targetUrl = this.validateInput(input);
    const priorCertainty = input.mode === "collect_only" ? "submitted" : "not_submitted";
    if (targetUrl === null) return recovery("ui_changed", priorCertainty);
    const priorConversationUrl = input.mode === "collect_only" ? targetUrl : undefined;
    if (input.mode === "submit_and_collect"
      && !await this.validateUploadPaths(input.stagingDirectory, input.uploadPaths)) {
      return recovery("upload_failed", "not_submitted");
    }
    const executable = resolveAgentBrowserExecutable(this.executablePath);
    if (executable === null) return recovery("browser_unavailable", priorCertainty, priorConversationUrl);

    let workspace: WorkspacePaths;
    try {
      workspace = await this.factory();
    } catch {
      return recovery("browser_unavailable", priorCertainty, priorConversationUrl);
    }

    const started = this.now();
    const context: AutomationContext = {
      executable,
      sessionPort: input.session.port,
      workspace,
      env: this.buildAutomationEnv(workspace.dir),
      hooks,
      deadline: started + this.deadlineMs,
      lastHeartbeat: started,
    };
    try {
      return await this.executeRun(input, targetUrl, context);
    } finally {
      if (context.eventClient !== undefined) {
        if (context.eventRestore !== undefined) {
          try {
            await context.eventRestore();
          } catch {}
        }
        try {
          context.eventClient.close();
        } catch {}
      }
      if (context.ownedTargetId !== undefined) {
        try {
          await this.ownedTabCleanup({
            executable: context.executable,
            targetId: context.ownedTargetId,
            sessionPort: context.sessionPort,
            workspace: context.workspace,
            env: context.env,
          });
        } catch {
          // Cleanup is best-effort and can only target the exact fresh pinned tab.
        }
      }
      try {
        await this.cleanup(workspace.dir);
      } catch {
        // Cleanup failure never changes a safe, already-bounded result.
      }
    }
  }

  async waitForAuthenticatedProject(
    input: AuthenticationProbeInput,
    hooks: BrowserAutomationHooks,
  ): Promise<"authenticated" | "timed_out" | "manual"> {
    const projectUrl = sanitizeChatgptUrl(input.projectUrl, "configured");
    if (projectUrl === null || !Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0
      || input.deadlineMs > AUTHENTICATION_DEADLINE_MAX_MS
      || !Number.isInteger(input.session.port) || input.session.port < 1 || input.session.port > 65_535) {
      return "manual";
    }
    const executable = resolveAgentBrowserExecutable(this.executablePath);
    if (executable === null) return "manual";

    let workspace: WorkspacePaths;
    try {
      workspace = await this.factory();
    } catch {
      return "manual";
    }
    const started = this.now();
    const context: AutomationContext = {
      executable,
      sessionPort: input.session.port,
      workspace,
      env: this.buildAutomationEnv(workspace.dir),
      hooks,
      deadline: started + input.deadlineMs,
      lastHeartbeat: started,
    };
    let navigationReported = false;

    try {
      const opened = await this.command(context, ["open", projectUrl]);
      if (opened.kind === "failed") return opened.failure === "timed_out" ? "timed_out" : "manual";

      for (;;) {
        const observed = await this.readObservedUrl(context);
        if (observed.kind === "failed") {
          return observed.failure === "timed_out" ? "timed_out" : "manual";
        }
        if (!navigationReported && (observed.value.kind === "login"
          || (observed.value.kind === "page" && observed.value.url === projectUrl))) {
          await hooks.navigationConfirmed?.();
          navigationReported = true;
        }
        const snapshot = await this.readSnapshot(context);
        if (snapshot.kind === "failed") {
          return snapshot.failure === "timed_out" ? "timed_out" : "manual";
        }
        const state = analyzeInteractiveState(snapshot.value);
        if (state === null || state.hasHumanChallenge || state.hasAmbiguousDialog) return "manual";
        if (observed.value.kind === "invalid") return "manual";
        if (observed.value.kind === "page" && observed.value.url === projectUrl
          && (state.composerRefs.length === 1
            || (state.composerRefs.length === 0
              && state.projectNewChatRefs.length === 1
              && !state.hasSignInControl))) {
          return "authenticated";
        }
        const waitingForLogin = observed.value.kind === "login" || state.hasSignInControl;
        if (!waitingForLogin) return "manual";
        const paused = await this.pause(context);
        if (paused !== "ok") return paused === "timed_out" ? "timed_out" : "manual";
      }
    } finally {
      try {
        await this.cleanup(workspace.dir);
      } catch {
        // The probe result remains closed and safe.
      }
    }
  }

  private validateInput(input: BrowserAutomationInput): string | null {
    if (input === null || typeof input !== "object" || !SAFE_REQUEST_ID.test(input.requestId)
      || (input.mode !== "submit_and_collect" && input.mode !== "collect_only")
      || (input.targetKind !== "configured" && input.targetKind !== "conversation")
      || (input.mode === "collect_only" && input.targetKind !== "conversation")
      || typeof input.prompt !== "string" || Buffer.byteLength(input.prompt, "utf8") > PROMPT_MAX_BYTES
      || !Array.isArray(input.uploadPaths) || typeof input.stagingDirectory !== "string"
      || !Number.isSafeInteger(input.maximumResponseBytes) || input.maximumResponseBytes <= 0
      || input.maximumResponseBytes > HARD_BUDGET.maxCompletionBytes
      || !Number.isInteger(input.session.port) || input.session.port < 1 || input.session.port > 65_535) {
      return null;
    }
    return sanitizeChatgptUrl(input.targetUrl, input.targetKind);
  }

  private async validateUploadPaths(
    stagingDirectory: string,
    uploadPaths: readonly string[],
  ): Promise<boolean> {
    if (uploadPaths.length > HARD_BUDGET.maxPaths || !path.isAbsolute(stagingDirectory)) return false;
    try {
      const directoryInfo = await fs.promises.lstat(stagingDirectory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()
        || await fs.promises.realpath(stagingDirectory) !== stagingDirectory) {
        return false;
      }
      for (const uploadPath of uploadPaths) {
        if (typeof uploadPath !== "string" || !path.isAbsolute(uploadPath)) return false;
        const relative = path.relative(stagingDirectory, uploadPath).replaceAll("\\", "/");
        if (relative === "" || relative === ".." || relative.startsWith("../")
          || path.isAbsolute(relative)) {
          return false;
        }
        const info = await fs.promises.lstat(uploadPath);
        if (info.isSymbolicLink() || !info.isFile()
          || await fs.promises.realpath(uploadPath) !== uploadPath) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async executeRun(
    input: BrowserAutomationInput,
    targetUrl: string,
    context: AutomationContext,
  ): Promise<BrowserAutomationResult> {
    const priorCertainty = input.mode === "collect_only" ? "submitted" : "not_submitted";
    const priorConversationUrl = input.mode === "collect_only" ? targetUrl : undefined;
    const opened = await this.command(context, ["open", targetUrl]);
    if (opened.kind === "failed") {
      return recovery(
        opened.failure === "timed_out" ? "timed_out" : "browser_unavailable",
        priorCertainty,
        priorConversationUrl,
      );
    }
    if (typeof opened.value.targetId === "string" && TARGET_ID_RE.test(opened.value.targetId)) {
      context.ownedTargetId = opened.value.targetId;
    }
    if (this.cdpPageClientFactory !== undefined && input.mode === "submit_and_collect") {
      context.eventClient = await this.attachEventCollector(context);
    }

    const observed = await this.readObservedUrl(context);
    if (observed.kind === "failed") {
      return recovery(
        observed.failure === "timed_out" ? "timed_out" : "ui_changed",
        priorCertainty,
        priorConversationUrl,
      );
    }
    if (observed.value.kind === "login") {
      return recovery("login_required", priorCertainty, priorConversationUrl);
    }
    if (observed.value.kind === "invalid") {
      return recovery("ui_changed", priorCertainty, priorConversationUrl);
    }
    let currentUrl = observed.value.kind === "page" ? observed.value.url : null;

    let snapshot = await this.readSnapshot(context);
    if (snapshot.kind === "failed") {
      return recovery(
        snapshot.failure === "timed_out" ? "timed_out" : "ui_changed",
        priorCertainty,
        priorConversationUrl,
      );
    }
    let state = analyzeInteractiveState(snapshot.value);
    const interactiveSettleDeadline = Math.min(
      context.deadline,
      this.now() + INTERACTIVE_LOAD_SETTLE_MS,
    );
    while (currentUrl === targetUrl
      && state !== null
      && !state.hasSignInControl
      && !state.hasHumanChallenge
      && !state.hasAmbiguousDialog
      && state.composerRefs.length === 0
      && (input.targetKind === "conversation" || state.projectNewChatRefs.length === 0)
      && this.now() < interactiveSettleDeadline) {
      const paused = await this.pause(context);
      if (paused !== "ok") {
        return recovery(paused === "timed_out" ? "timed_out" : "ui_changed", priorCertainty);
      }
      const settledUrl = await this.readObservedUrl(context);
      if (settledUrl.kind === "failed") {
        return recovery(settledUrl.failure === "timed_out" ? "timed_out" : "ui_changed", priorCertainty);
      }
      if (settledUrl.value.kind === "login") return recovery("login_required", priorCertainty);
      if (settledUrl.value.kind !== "page" || settledUrl.value.url !== targetUrl) {
        return recovery("ui_changed", priorCertainty);
      }
      currentUrl = settledUrl.value.url;
      snapshot = await this.readSnapshot(context);
      if (snapshot.kind === "failed") {
        return recovery(snapshot.failure === "timed_out" ? "timed_out" : "ui_changed", priorCertainty);
      }
      state = analyzeInteractiveState(snapshot.value);
    }
    const initialClassification = this.classifyInteractiveFailure(state);
    const isAuthenticatedProjectLanding = input.mode === "submit_and_collect"
      && input.targetKind === "configured"
      && currentUrl === targetUrl
      && state !== null
      && !state.hasSignInControl
      && !state.hasHumanChallenge
      && !state.hasAmbiguousDialog
      && state.composerRefs.length === 0
      && state.projectNewChatRefs.length === 1;
    if (initialClassification !== null && !isAuthenticatedProjectLanding) {
      return recovery(initialClassification.reason, priorCertainty, priorConversationUrl);
    }
    state = state!;

    if (input.mode === "collect_only") {
      if (currentUrl !== targetUrl) return recovery("ui_changed", "submitted", targetUrl);
      if (state.composerRefs.length !== 1) return recovery("ui_changed", "submitted", targetUrl);
      const alreadyComplete = await this.attemptImmediateCompletionRead(input, context, targetUrl);
      if (alreadyComplete !== null) {
        return this.withPath(
          { kind: "completed", conversationUrl: targetUrl, responseText: alreadyComplete },
          "immediate",
        );
      }
      return this.withPath(await this.collectResponse(input, context, targetUrl, null), "polling");
    }

    if (currentUrl === null) return recovery("ui_changed", "not_submitted");

    if (input.targetKind === "configured") {
      if (currentUrl !== targetUrl || state.composerRefs.length !== 1) {
        if (state.projectNewChatRefs.length !== 1) return recovery("ui_changed", "not_submitted");
        const clicked = await this.command(context, ["click", `@${state.projectNewChatRefs[0]!}`]);
        if (clicked.kind === "failed") {
          return recovery(clicked.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
        }
        const refreshedUrl = await this.readObservedUrl(context);
        if (refreshedUrl.kind === "failed") {
          return recovery(refreshedUrl.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
        }
        if (refreshedUrl.value.kind === "login") return recovery("login_required", "not_submitted");
        if (refreshedUrl.value.kind !== "page" || refreshedUrl.value.url !== targetUrl) {
          return recovery("ui_changed", "not_submitted");
        }
        currentUrl = refreshedUrl.value.url;
        snapshot = await this.readSnapshot(context);
        if (snapshot.kind === "failed") {
          return recovery(snapshot.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
        }
        state = analyzeInteractiveState(snapshot.value);
        const refreshedClassification = this.classifyInteractiveFailure(state);
        if (refreshedClassification !== null) return recovery(refreshedClassification.reason, "not_submitted");
        state = state!;
      }
      if (currentUrl !== targetUrl || state.composerRefs.length !== 1) {
        return recovery("ui_changed", "not_submitted");
      }
    } else if (currentUrl !== targetUrl || state.composerRefs.length !== 1) {
      return recovery("ui_changed", "not_submitted");
    }

    const preSubmitCount = await this.readAssistantCount(context);
    if (preSubmitCount.kind === "failed") {
      return recovery(preSubmitCount.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
    }
    if (input.targetKind === "configured" && preSubmitCount.value !== 0) {
      return recovery("ui_changed", "not_submitted");
    }
    let priorResponse: string | null = null;
    if (input.targetKind === "conversation") {
      const settled = await this.settleConversationResponse(context, input.maximumResponseBytes);
      if (settled.kind === "failed") {
        return recovery(settled.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
      }
      priorResponse = settled.value;
    }

    if (input.uploadPaths.length > 0) {
      const preUploadUrl = await this.readObservedUrl(context);
      if (preUploadUrl.kind === "failed") {
        return recovery(preUploadUrl.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
      }
      if (preUploadUrl.value.kind === "login") return recovery("login_required", "not_submitted");
      if (preUploadUrl.value.kind !== "page" || preUploadUrl.value.url !== targetUrl) {
        return recovery("ui_changed", "not_submitted");
      }
      const uploaded = await this.command(
        context,
        ["upload", UPLOAD_SELECTOR, ...input.uploadPaths],
        MAX_STDOUT_BYTES,
        12_000,
        () => this.validateUploadPaths(input.stagingDirectory, input.uploadPaths),
      );
      if (uploaded.kind === "failed") {
        return recovery(uploaded.failure === "timed_out" ? "timed_out" : "upload_failed", "not_submitted");
      }
      snapshot = await this.readSnapshot(context);
      if (snapshot.kind === "failed") {
        return recovery(snapshot.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
      }
      state = analyzeInteractiveState(snapshot.value);
      const uploadedClassification = this.classifyInteractiveFailure(state);
      if (uploadedClassification !== null || state!.composerRefs.length !== 1) {
        return recovery(uploadedClassification?.reason ?? "ui_changed", "not_submitted");
      }
    }

    const composerRef = state?.composerRefs[0];
    if (composerRef === undefined) return recovery("ui_changed", "not_submitted");
    const preFillUrl = await this.readObservedUrl(context);
    if (preFillUrl.kind === "failed") {
      return recovery(preFillUrl.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
    }
    if (preFillUrl.value.kind === "login") return recovery("login_required", "not_submitted");
    if (preFillUrl.value.kind !== "page" || preFillUrl.value.url !== targetUrl) {
      return recovery("ui_changed", "not_submitted");
    }
    const filled = await this.command(context, ["fill", `@${composerRef}`, input.prompt]);
    if (filled.kind === "failed") {
      return recovery(filled.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
    }

    const preSubmissionUrl = await this.readObservedUrl(context);
    if (preSubmissionUrl.kind === "failed") {
      return recovery(preSubmissionUrl.failure === "timed_out" ? "timed_out" : "ui_changed", "not_submitted");
    }
    if (preSubmissionUrl.value.kind === "login") return recovery("login_required", "not_submitted");
    if (preSubmissionUrl.value.kind !== "page" || preSubmissionUrl.value.url !== targetUrl) {
      return recovery("ui_changed", "not_submitted");
    }

    try {
      await context.hooks.beforeSubmission();
    } catch {
      return recovery("browser_unavailable", "not_submitted");
    }
    if (input.targetKind === "conversation") {
      context.eventClient?.resetBufferedFrames();
    }
    const pressed = await this.command(context, ["press", "Enter"]);
    if (pressed.kind === "failed") return recovery("submission_uncertain", "uncertain");

    let submittedUrl = await this.readObservedUrl(context);
    if (submittedUrl.kind === "failed" || submittedUrl.value.kind !== "page") {
      return recovery("submission_uncertain", "uncertain");
    }
    const navigationDeadline = Math.min(
      context.deadline,
      this.now() + POST_SUBMISSION_NAVIGATION_MS,
    );
    while (input.targetKind === "configured"
      && submittedUrl.value.kind === "page"
      && submittedUrl.value.url === targetUrl
      && this.now() < navigationDeadline) {
      const paused = await this.pause(context);
      if (paused !== "ok") return recovery("submission_uncertain", "uncertain");
      submittedUrl = await this.readObservedUrl(context);
      if (submittedUrl.kind === "failed" || submittedUrl.value.kind !== "page") {
        return recovery("submission_uncertain", "uncertain");
      }
    }
    const conversationUrl = submittedUrl.value.url;
    if ((input.targetKind === "configured" && conversationUrl === targetUrl)
      || (input.targetKind === "conversation" && conversationUrl !== targetUrl)) {
      return recovery("submission_uncertain", "uncertain");
    }
    try {
      await context.hooks.submissionConfirmed(conversationUrl);
    } catch {
      return recovery("submission_uncertain", "uncertain", conversationUrl);
    }
    if (this.cdpPageClientFactory === undefined) {
      return this.collectResponse(input, context, conversationUrl, priorResponse);
    }
    if (context.eventClient === undefined) {
      return this.withPath(await this.collectResponse(input, context, conversationUrl, priorResponse), "polling");
    }
    return this.collectResponseEventDriven(input, context, conversationUrl, context.eventClient);
  }

  private classifyInteractiveFailure(
    state: InteractiveState | null,
  ): { reason: BrowserFailureReason } | null {
    if (state === null) return { reason: "ui_changed" };
    if (state.hasHumanChallenge) return { reason: "human_challenge" };
    if (state.hasAmbiguousDialog) return { reason: "ui_changed" };
    if (state.composerRefs.length === 0 && state.hasSignInControl) {
      return { reason: "login_required" };
    }
    if (state.composerRefs.length !== 1) return { reason: "ui_changed" };
    return null;
  }

  private async collectResponse(
    input: BrowserAutomationInput,
    context: AutomationContext,
    conversationUrl: string,
    priorResponse: string | null,
  ): Promise<BrowserAutomationResult> {
    let stableForeign: { text: string; pairs: number } | null = null;
    for (;;) {
      const pollUrl = await this.readObservedUrl(context);
      if (pollUrl.kind === "failed") {
        return recovery(pollUrl.failure === "timed_out" || pollUrl.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      if (pollUrl.value.kind === "login") {
        return recovery("login_required", "submitted", conversationUrl);
      }
      if (pollUrl.value.kind !== "page" || pollUrl.value.url !== conversationUrl) {
        return recovery("ui_changed", "submitted", conversationUrl);
      }
      const snapshot = await this.readSnapshot(context);
      if (snapshot.kind === "failed") {
        return recovery(snapshot.failure === "timed_out" || snapshot.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      const state = analyzeInteractiveState(snapshot.value);
      if (state === null) return recovery("invalid_response", "submitted", conversationUrl);
      if (state.hasHumanChallenge) return recovery("human_challenge", "submitted", conversationUrl);
      if (state.hasAmbiguousDialog) return recovery("ui_changed", "submitted", conversationUrl);
      if (state.hasStopControl) {
        const paused = await this.pause(context);
        if (paused !== "ok") return recovery("timed_out", "submitted", conversationUrl);
        continue;
      }

      const assistantCount = await this.readAssistantCount(context);
      if (assistantCount.kind === "failed") {
        return recovery(assistantCount.failure === "timed_out" || assistantCount.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      if (assistantCount.value === 0) {
        const paused = await this.pause(context);
        if (paused !== "ok") return recovery("timed_out", "submitted", conversationUrl);
        continue;
      }

      const firstReadUrl = await this.readObservedUrl(context);
      if (firstReadUrl.kind === "failed") {
        return recovery(firstReadUrl.failure === "timed_out" || firstReadUrl.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      if (firstReadUrl.value.kind === "login") {
        return recovery("login_required", "submitted", conversationUrl);
      }
      if (firstReadUrl.value.kind !== "page" || firstReadUrl.value.url !== conversationUrl) {
        return recovery("ui_changed", "submitted", conversationUrl);
      }
      const first = await this.readResponseText(context, input.maximumResponseBytes);
      if (first.kind === "failed") {
        return recovery(first.failure === "timed_out" || first.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      if (first.value.length === 0 || first.value === priorResponse) {
        const waiting = await this.pause(context);
        if (waiting !== "ok") return recovery("timed_out", "submitted", conversationUrl);
        continue;
      }
      const paused = await this.pause(context);
      if (paused !== "ok") return recovery("timed_out", "submitted", conversationUrl);
      const secondReadUrl = await this.readObservedUrl(context);
      if (secondReadUrl.kind === "failed") {
        return recovery(secondReadUrl.failure === "timed_out" || secondReadUrl.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      if (secondReadUrl.value.kind === "login") {
        return recovery("login_required", "submitted", conversationUrl);
      }
      if (secondReadUrl.value.kind !== "page" || secondReadUrl.value.url !== conversationUrl) {
        return recovery("ui_changed", "submitted", conversationUrl);
      }
      const second = await this.readResponseText(context, input.maximumResponseBytes);
      if (second.kind === "failed") {
        return recovery(second.failure === "timed_out" || second.failure === "cancelled"
          ? "timed_out" : "invalid_response", "submitted", conversationUrl);
      }
      if (first.value === second.value) {
        if (responseBelongsToRequest(second.value, input.requestId)) {
          return { kind: "completed", conversationUrl, responseText: second.value };
        }
        if (responseIsFinalButUnusable(second.value)) {
          return recovery("invalid_response", "submitted", conversationUrl);
        }
        stableForeign = stableForeign !== null && stableForeign.text === second.value
          ? { text: second.value, pairs: stableForeign.pairs + 1 }
          : { text: second.value, pairs: 1 };
        if (stableForeign.pairs >= FINAL_ANSWER_STABLE_PAIRS) {
          return recovery("invalid_response", "submitted", conversationUrl);
        }
      } else {
        stableForeign = null;
      }
      const retryPause = await this.pause(context);
      if (retryPause !== "ok") return recovery("timed_out", "submitted", conversationUrl);
    }
  }

  private withPath(
    result: BrowserAutomationResult,
    path: "event" | "polling" | "event_recovered" | "immediate",
  ): BrowserAutomationResult {
    return { ...result, collectionPath: path };
  }

  private async attemptImmediateCompletionRead(
    input: BrowserAutomationInput,
    context: AutomationContext,
    conversationUrl: string,
  ): Promise<string | null> {
    const readContext: AutomationContext = {
      ...context,
      deadline: Math.max(context.deadline, this.now() + IMMEDIATE_ANSWER_READ_BUDGET_MS),
    };
    const observed = await this.readObservedUrl(readContext);
    if (observed.kind === "failed" || observed.value.kind !== "page" || observed.value.url !== conversationUrl) {
      return null;
    }
    const text = await this.readResponseText(readContext, input.maximumResponseBytes);
    if (text.kind === "failed") return null;
    return responseBelongsToRequest(text.value, input.requestId) ? text.value : null;
  }

  private async attachEventCollector(
    context: AutomationContext,
  ): Promise<CdpPageClientLike | undefined> {
    if (this.cdpPageClientFactory === undefined || context.ownedTargetId === undefined) {
      return undefined;
    }
    let client: CdpPageClientLike;
    try {
      client = this.cdpPageClientFactory({ port: context.sessionPort, targetId: context.ownedTargetId });
    } catch {
      return undefined;
    }
    try {
      await client.connect();
    } catch {
      return undefined;
    }
    const outcome = await unthrottlePage(client);
    const networkUnavailable = outcome.kind === "degraded"
      && (outcome.failedMethod === "Page.enable" || outcome.failedMethod === "Network.enable");
    if (networkUnavailable) {
      try {
        await outcome.restore();
      } catch {}
      try {
        client.close();
      } catch {}
      return undefined;
    }
    context.eventRestore = outcome.restore;
    return client;
  }

  private async watchTurnWithHeartbeat(
    input: BrowserAutomationInput,
    context: AutomationContext,
    client: CdpPageClientLike,
    conversationId: string,
    conversationUrl: string,
  ): Promise<HeartbeatWatchOutcome> {
    let hintReadPromise: Promise<HeartbeatRaceResult> | null = null;
    let lastHintReadStartedAt = -Infinity;
    const drainHintRead = async (): Promise<void> => {
      if (hintReadPromise === null) return;
      await hintReadPromise;
      hintReadPromise = null;
    };
    const watchPromise = watchForTurnCompletion(client, conversationId, context.deadline - this.now(), {
      onHint: () => {
        if (hintReadPromise !== null) return;
        if (this.now() - lastHintReadStartedAt < HINT_READ_COOLDOWN_MS) return;
        lastHintReadStartedAt = this.now();
        hintReadPromise = this.attemptImmediateCompletionRead(input, context, conversationUrl)
          .then((text) => ({ kind: "hint_read" as const, text }));
      },
    });
    for (;;) {
      const untilDeadline = context.deadline - this.now();
      if (untilDeadline <= 0) {
        await drainHintRead();
        return { kind: "deadline_exceeded" };
      }
      const untilHeartbeat = Math.max(
        1,
        HEARTBEAT_INTERVAL_MS - (this.now() - context.lastHeartbeat),
      );
      const waitController = new AbortController();
      const waited = this.commandWait(
        Math.min(untilDeadline, untilHeartbeat),
        waitController.signal,
      ).then(
        () => ({ kind: "elapsed" as const }),
        () => ({ kind: "wait_failed" as const }),
      );
      const racers: Array<Promise<HeartbeatRaceResult>> = [
        watchPromise.then((value) => ({ kind: "watch" as const, value })),
        waited,
      ];
      if (hintReadPromise !== null) racers.push(hintReadPromise);
      const settled = await Promise.race(racers);
      waitController.abort();
      if (settled.kind === "watch") {
        await drainHintRead();
        return settled.value;
      }
      if (settled.kind === "hint_read") {
        hintReadPromise = null;
        if (settled.text !== null) return { kind: "hint_recovered", responseText: settled.text };
        continue;
      }
      const checkpoint = await this.checkpoint(context);
      if (checkpoint !== "ok") {
        await drainHintRead();
        return { kind: "deadline_exceeded" };
      }
    }
  }

  private async collectResponseEventDriven(
    input: BrowserAutomationInput,
    context: AutomationContext,
    conversationUrl: string,
    client: CdpPageClientLike,
  ): Promise<BrowserAutomationResult> {
    const conversationId = extractConversationId(conversationUrl);
    if (conversationId === null) {
      return this.withPath(await this.collectResponse(input, context, conversationUrl, null), "polling");
    }
    const outcome = await this.watchTurnWithHeartbeat(input, context, client, conversationId, conversationUrl);
    if (outcome.kind === "hint_recovered") {
      return this.withPath(
        { kind: "completed", conversationUrl, responseText: outcome.responseText },
        "event_recovered",
      );
    }
    if (outcome.kind === "connection_lost") {
      const recovered = await this.attemptImmediateCompletionRead(input, context, conversationUrl);
      if (recovered !== null) {
        return this.withPath({ kind: "completed", conversationUrl, responseText: recovered }, "event_recovered");
      }
      return this.withPath(await this.collectResponse(input, context, conversationUrl, null), "polling");
    }
    if (outcome.kind === "deadline_exceeded") {
      const recovered = await this.attemptImmediateCompletionRead(input, context, conversationUrl);
      if (recovered !== null) {
        return this.withPath({ kind: "completed", conversationUrl, responseText: recovered }, "event_recovered");
      }
      return this.withPath(recovery("timed_out", "submitted", conversationUrl), "event");
    }
    return this.settleEventCompletionText(input, context, conversationUrl);
  }

  private async settleEventCompletionText(
    input: BrowserAutomationInput,
    context: AutomationContext,
    conversationUrl: string,
  ): Promise<BrowserAutomationResult> {
    const windowDeadline = this.now() + POST_COMPLETION_TEXT_MS;
    for (;;) {
      if (this.now() >= context.deadline) {
        return this.withPath(recovery("timed_out", "submitted", conversationUrl), "event");
      }
      const pollUrl = await this.readObservedUrl(context);
      if (pollUrl.kind === "failed") {
        return this.withPath(
          recovery(
            pollUrl.failure === "timed_out" || pollUrl.failure === "cancelled" ? "timed_out" : "invalid_response",
            "submitted",
            conversationUrl,
          ),
          "event",
        );
      }
      if (pollUrl.value.kind === "login") {
        return this.withPath(recovery("login_required", "submitted", conversationUrl), "event");
      }
      if (pollUrl.value.kind !== "page" || pollUrl.value.url !== conversationUrl) {
        return this.withPath(recovery("ui_changed", "submitted", conversationUrl), "event");
      }
      const text = await this.readResponseText(context, input.maximumResponseBytes);
      if (text.kind === "failed") {
        if (text.failure === "timed_out" || text.failure === "cancelled") {
          return this.withPath(recovery("timed_out", "submitted", conversationUrl), "event");
        }
        if (this.now() >= windowDeadline) {
          return this.withPath(recovery("invalid_response", "submitted", conversationUrl), "event");
        }
        const retryPause = await this.pause(context);
        if (retryPause !== "ok") {
          return this.withPath(recovery("timed_out", "submitted", conversationUrl), "event");
        }
        continue;
      }
      if (responseBelongsToRequest(text.value, input.requestId)) {
        return this.withPath({ kind: "completed", conversationUrl, responseText: text.value }, "event");
      }
      if (responseIsFinalButUnusable(text.value)) {
        return this.withPath(recovery("invalid_response", "submitted", conversationUrl, text.value), "event");
      }
      if (this.now() >= windowDeadline) {
        return this.withPath(recovery("invalid_response", "submitted", conversationUrl, text.value), "event");
      }
      const paused = await this.pause(context);
      if (paused !== "ok") {
        return this.withPath(recovery("timed_out", "submitted", conversationUrl), "event");
      }
    }
  }

  private async readObservedUrl(
    context: AutomationContext,
  ): Promise<StepResult<ReturnType<typeof classifyObservedChatgptUrl>>> {
    const result = await this.command(context, ["get", "url"]);
    if (result.kind === "failed") return result;
    return { kind: "ok", value: classifyObservedChatgptUrl(result.value.url) };
  }

  private async readSnapshot(context: AutomationContext): Promise<StepResult<Record<string, unknown>>> {
    return this.command(context, ["snapshot", "-i"], SNAPSHOT_STDOUT_BYTES);
  }

  private async settleConversationResponse(
    context: AutomationContext,
    maximumResponseBytes: number,
  ): Promise<StepResult<string>> {
    let previous: string | null = null;
    for (;;) {
      const paused = await this.pause(context);
      if (paused !== "ok") return { kind: "failed", failure: paused };
      const current = await this.readLatestResponse(context, maximumResponseBytes);
      if (current.kind === "failed") return current;
      if (current.value !== null && current.value === previous) return { kind: "ok", value: current.value };
      previous = current.value;
    }
  }

  private async readLatestResponse(
    context: AutomationContext,
    maximumResponseBytes: number,
  ): Promise<StepResult<string | null>> {
    const count = await this.readAssistantCount(context);
    if (count.kind === "failed") return count;
    if (count.value === 0) return { kind: "ok", value: null };
    const text = await this.readResponseText(context, maximumResponseBytes);
    if (text.kind === "failed") return text;
    return { kind: "ok", value: text.value.length === 0 ? null : text.value };
  }

  private async readAssistantCount(context: AutomationContext): Promise<StepResult<number>> {
    const result = await this.command(context, ["get", "count", ASSISTANT_SELECTOR]);
    if (result.kind === "failed") return result;
    const count = result.value.count;
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      return { kind: "failed", failure: "command_failed" };
    }
    return { kind: "ok", value: count as number };
  }

  private async readResponseText(
    context: AutomationContext,
    maximumResponseBytes: number,
  ): Promise<StepResult<string>> {
    const maximumOutputBytes = Math.min(
      maximumResponseBytes + RESPONSE_OVERHEAD_BYTES,
      HARD_BUDGET.maxCompletionBytes + RESPONSE_OVERHEAD_BYTES,
    );
    const result = await this.command(
      context,
      ["find", "last", ASSISTANT_SELECTOR, "text"],
      maximumOutputBytes,
      maximumOutputBytes,
    );
    if (result.kind === "failed") return result;
    const text = result.value.text;
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximumResponseBytes) {
      return { kind: "failed", failure: "command_failed" };
    }
    return { kind: "ok", value: text };
  }

  private async command(
    context: AutomationContext,
    commandArgs: readonly string[],
    processMaximumBytes = MAX_STDOUT_BYTES,
    agentMaximumBytes = 12_000,
    preflight?: () => Promise<boolean>,
  ): Promise<StepResult<Record<string, unknown>>> {
    const checkpoint = await this.checkpoint(context);
    if (checkpoint !== "ok") return { kind: "failed", failure: checkpoint };
    if (preflight !== undefined) {
      try {
        if (!await preflight()) return { kind: "failed", failure: "command_failed" };
      } catch {
        return { kind: "failed", failure: "command_failed" };
      }
      if (this.now() >= context.deadline) return { kind: "failed", failure: "timed_out" };
    }
    const remaining = context.deadline - this.now();
    const argv = [
      context.executable,
      "--session", "chatgpt-consult",
      "--cdp", String(context.sessionPort),
      "--pin-tab",
      "--content-boundaries",
      "--max-output", String(agentMaximumBytes),
      "--action-policy", context.workspace.policyPath,
      "--config", context.workspace.configPath,
      "--idle-timeout", "10s",
      "--json",
      ...commandArgs,
    ];
    let pending: Promise<
      | { kind: "result"; value: { status: number; output: string } }
      | { kind: "error" }
    >;
    try {
      pending = this.runner(argv, {
        cwd: context.workspace.dir,
        env: context.env,
        timeoutMs: remaining,
        maxBytes: processMaximumBytes,
      }).then(
        (value) => ({ kind: "result" as const, value }),
        () => ({ kind: "error" as const }),
      );
    } catch {
      return { kind: "failed", failure: "command_failed" };
    }

    for (;;) {
      const untilDeadline = context.deadline - this.now();
      if (untilDeadline <= 0) return { kind: "failed", failure: "timed_out" };
      const untilHeartbeat = Math.max(
        1,
        HEARTBEAT_INTERVAL_MS - (this.now() - context.lastHeartbeat),
      );
      const waitController = new AbortController();
      const waited = this.commandWait(
        Math.min(untilDeadline, untilHeartbeat),
        waitController.signal,
      ).then(
        () => ({ kind: "elapsed" as const }),
        () => ({ kind: "wait_failed" as const }),
      );
      const settled = await Promise.race([
        pending.then((value) => ({ kind: "command" as const, value })),
        waited,
      ]);
      if (settled.kind === "command") {
        waitController.abort();
        if (this.now() >= context.deadline) return { kind: "failed", failure: "timed_out" };
        if (settled.value.kind === "error" || settled.value.value.status !== 0) {
          return { kind: "failed", failure: "command_failed" };
        }
        const data = parseEnvelope(settled.value.value.output);
        return data === null
          ? { kind: "failed", failure: "command_failed" }
          : { kind: "ok", value: data };
      }
      waitController.abort();
      if (settled.kind === "wait_failed") {
        await this.drainPendingCommand(pending, context);
        return { kind: "failed", failure: "timed_out" };
      }
      const pendingCheckpoint = await this.checkpoint(context);
      if (pendingCheckpoint !== "ok") {
        await this.drainPendingCommand(pending, context);
        return { kind: "failed", failure: pendingCheckpoint };
      }
    }
  }

  private async drainPendingCommand(
    pending: Promise<unknown>,
    context: AutomationContext,
  ): Promise<void> {
    const remaining = context.deadline - this.now();
    if (remaining <= 0) return;
    const waitController = new AbortController();
    try {
      await Promise.race([
        pending,
        this.commandWait(remaining, waitController.signal).catch(() => undefined),
      ]);
    } finally {
      waitController.abort();
    }
  }

  private async checkpoint(context: AutomationContext): Promise<"ok" | "cancelled" | "timed_out"> {
    if (this.now() >= context.deadline) return "timed_out";
    try {
      if (await context.hooks.isCancelled()) return "cancelled";
      if (this.now() - context.lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        await context.hooks.heartbeat();
        context.lastHeartbeat = this.now();
      }
    } catch {
      return "timed_out";
    }
    return this.now() >= context.deadline ? "timed_out" : "ok";
  }

  private async pause(context: AutomationContext): Promise<"ok" | "cancelled" | "timed_out"> {
    const checkpoint = await this.checkpoint(context);
    if (checkpoint !== "ok") return checkpoint;
    const remaining = context.deadline - this.now();
    if (remaining <= 0) return "timed_out";
    try {
      await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    } catch {
      return "timed_out";
    }
    return this.checkpoint(context);
  }

  private buildAutomationEnv(workspaceDir: string): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      HOME: workspaceDir,
      XDG_CONFIG_HOME: workspaceDir,
    };
    if (process.env.TMPDIR !== undefined && process.env.TMPDIR.length > 0) {
      env.TMPDIR = process.env.TMPDIR;
    }
    return env;
  }
}
