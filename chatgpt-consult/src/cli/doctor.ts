import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createAutomationWorkspace, createAutomationSessionId, type CommandRunner } from "../browser/agent-browser";
import { resolveChromePaths } from "../browser/cdp";
import { runBoundedDiagnosticResult } from "../browser/chrome";
import { classifyObservedChatgptUrl } from "../browser/handoff";
import { attachExternalCdp } from "../browser/session";
import type { LocalConfig } from "../core/schema";
import { readLocalConfig } from "../core/service";
import { resolveProject, type ResolvedProject } from "../security/project";
import { setupClients } from "./setup";

export const DOCTOR_PROBE_NAMES = [
  "bun",
  "project",
  "ignore_rule",
  "state_permissions",
  "stdio_mcp",
  "agent_browser",
  "chrome",
  "cdp",
  "chatgpt_project_url",
  "chatgpt_project_page",
  "browser_login",
  "http_mcp",
  "tunnel",
  "webview",
] as const;

export type DoctorProbeName = typeof DOCTOR_PROBE_NAMES[number];
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorProbeOutcome {
  readonly status: DoctorStatus;
  readonly message: string;
  readonly fix?: string;
}

export type DoctorProbe = () => Promise<DoctorProbeOutcome> | DoctorProbeOutcome;

export interface DoctorCheck extends DoctorProbeOutcome {
  readonly name: DoctorProbeName;
  readonly required: boolean;
}

export interface DoctorResult {
  readonly kind: "doctor";
  readonly success: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorInput {
  readonly cwd?: string;
  readonly probes?: Partial<Record<DoctorProbeName, DoctorProbe>>;
}

const REQUIRED = new Set<DoctorProbeName>([
  "bun",
  "project",
  "ignore_rule",
  "state_permissions",
  "agent_browser",
  "chrome",
  "chatgpt_project_url",
  "browser_login",
]);
const SUBPROCESS_TIMEOUT_MS = 5_000;
const NETWORK_TIMEOUT_MS = 2_000;
const PROJECT_PAGE_PROBE_DEADLINE_MS = 15_000;
const PROJECT_PAGE_SNAPSHOT_MAX_ATTEMPTS = 8;
const PROJECT_PAGE_SNAPSHOT_RETRY_MS = 1_500;
const PROJECT_PAGE_TAB_CLOSE_BUDGET_MS = 2_000;
const PROJECT_PAGE_MAX_STDOUT_BYTES = 131_072;
const PROJECT_PAGE_MAX_REFS = 512;
const PROJECT_COMPOSER_NAME_PREFIX = "new chat in ";
const SIGN_IN_CONTROL_NAMES: ReadonlySet<string> = new Set(["log in", "sign in", "sign up"]);
const RATE_LIMIT_SIGNAL_TEXT = "too many requests";

export const isSupportedBunVersion = (value: string): boolean => {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 4);
};

const sanitizeUrls = (message: string): string => message.replace(
  /https?:\/\/[^\s"'<>]+/gi,
  (raw) => {
    try {
      const parsed = new URL(raw);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
    } catch {
      return "[redacted URL]";
    }
  },
);

export const redactDoctorText = (value: string): string => sanitizeUrls(value)
  .replace(/\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s,;]+/gi, "Authorization: [redacted]")
  .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\s]+/gi, "Cookie: [redacted]")
  .replace(/\b[A-Za-z0-9_-]{43}\b/g, "[redacted claim]")
  .replace(/\/(?:Users|home|tmp|private|var|opt)(?:\/[^\s,;]*)?/g, "[redacted path]")
  .replace(/\b[A-Za-z]:\\[^\s,;]*/g, "[redacted path]");

const boundedCommandStatus = async (argv: readonly string[]): Promise<number | null> => {
  const child = Bun.spawn(argv as string[], {
    stdin: null,
    stdout: "ignore",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timed-out");
  const result = await Promise.race([
    child.exited,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), SUBPROCESS_TIMEOUT_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result !== timedOut) return result;
  try { child.kill("SIGTERM"); } catch { /* exact-child cleanup is best effort */ }
  const terminated = await Promise.race([
    child.exited.then((status) => ({ done: true as const, status })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 250)),
  ]);
  if (terminated.done) return null;
  try { child.kill("SIGKILL"); } catch { /* exact-child cleanup is best effort */ }
  await Promise.race([
    child.exited,
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
  return null;
};

const fetchBounded = async (url: string): Promise<Response | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "error" });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

export const isProjectScopedComposerName = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith(PROJECT_COMPOSER_NAME_PREFIX)
    && normalized.length > PROJECT_COMPOSER_NAME_PREFIX.length;
};

export interface ProjectPageObservation {
  readonly urlKind: "page" | "root" | "login" | "invalid";
  readonly url?: string;
  readonly composerNames: readonly string[];
  readonly signInControlPresent: boolean;
  readonly rateLimited: boolean;
}

export const classifyProjectPageObservation = (
  configuredUrl: string,
  observation: ProjectPageObservation,
): DoctorProbeOutcome => {
  const urlMatches = observation.urlKind === "page" && observation.url === configuredUrl;
  const hasProjectComposer = observation.composerNames.some(isProjectScopedComposerName);

  if (observation.urlKind === "login" || observation.signInControlPresent) {
    return {
      status: "warn",
      message: "ChatGPT requires signing in before the configured project page can be verified live.",
      fix: "chatgpt-consult setup browser",
    };
  }
  if (urlMatches && hasProjectComposer) {
    return observation.rateLimited
      ? {
        status: "pass",
        message: "The configured ChatGPT Project URL resolves to a project-scoped page; a "
          + "rate-limit banner was also present, but the project composer is still usable.",
      }
      : {
        status: "pass",
        message: "The configured ChatGPT Project URL resolves to a project-scoped page.",
      };
  }
  if (observation.rateLimited) {
    return {
      status: "warn",
      message: "ChatGPT is rate-limiting page loads (\"Too many requests\"); the configured "
        + "project page could not be verified right now.",
    };
  }
  if (urlMatches && observation.composerNames.length > 0) {
    return {
      status: "fail",
      message: "The configured ChatGPT Project URL resolved to a generic ChatGPT composer "
        + "instead of the configured project; consultations would not land in the configured project.",
      fix: "Confirm the project URL includes its name slug (…-<slug>/project), then "
        + "chatgpt-consult init --chatgpt-project-url <url>.",
    };
  }
  if (urlMatches) {
    return {
      status: "warn",
      message: "The configured ChatGPT Project URL resolved correctly, but no composer could be "
        + "found; the probe could not confirm the page is usable.",
    };
  }
  return {
    status: "fail",
    message: "The configured ChatGPT Project URL did not resolve to a project-scoped page; "
      + "consultations would not land in the configured project.",
    fix: "Confirm the project URL includes its name slug (…-<slug>/project), then "
      + "chatgpt-consult init --chatgpt-project-url <url>.",
  };
};

export interface ProjectPageProbeConfig {
  readonly chatgptProjectUrl?: string | undefined;
  readonly browserCdpPort?: number | undefined;
}

export interface ProjectPageWorkspace {
  readonly dir: string;
  readonly policyPath: string;
  readonly configPath: string;
}

export interface ProjectPageProbeDeps {
  readonly resolveExecutable?: () => string | null;
  readonly attach?: (port: number) => Promise<{ readonly port: number }>;
  readonly commandRunner?: CommandRunner;
  readonly workspaceFactory?: () => Promise<ProjectPageWorkspace>;
  readonly workspaceCleanup?: (dir: string) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly deadlineMs?: number;
}

const parseAgentBrowserEnvelope = (output: string): Record<string, unknown> | null => {
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
};

interface SnapshotSignals {
  readonly composerNames: readonly string[];
  readonly signInControlPresent: boolean;
  readonly rateLimited: boolean;
}

const EMPTY_SNAPSHOT_SIGNALS: SnapshotSignals = {
  composerNames: [],
  signInControlPresent: false,
  rateLimited: false,
};

const extractSnapshotSignals = (data: Record<string, unknown>): SnapshotSignals => {
  const refs = data.refs;
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) {
    return EMPTY_SNAPSHOT_SIGNALS;
  }
  const entries = Object.entries(refs as Record<string, unknown>);
  if (entries.length > PROJECT_PAGE_MAX_REFS) {
    return EMPTY_SNAPSHOT_SIGNALS;
  }
  const composerNames: string[] = [];
  let signInControlPresent = false;
  let rateLimited = false;
  for (const [, raw] of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
    const name = typeof entry.name === "string"
      ? entry.name.trim().toLowerCase().replace(/\s+/g, " ")
      : "";
    if (name.length === 0) continue;
    if (role === "textbox") composerNames.push(name);
    if ((role === "button" || role === "link") && SIGN_IN_CONTROL_NAMES.has(name)) {
      signInControlPresent = true;
    }
    if (name.includes(RATE_LIMIT_SIGNAL_TEXT)) rateLimited = true;
  }
  return { composerNames, signInControlPresent, rateLimited };
};

const buildProjectPageEnv = (workspaceDir: string): Record<string, string> => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    HOME: workspaceDir,
    XDG_CONFIG_HOME: workspaceDir,
  };
  const tmp = process.env.TMPDIR;
  if (tmp !== undefined && tmp.length > 0) env.TMPDIR = tmp;
  return env;
};

const cleanupProjectPageWorkspace = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};

const defaultProjectPageCommandRunner: CommandRunner = async (argv, options) => {
  const child = Bun.spawn(argv as string[], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "ignore",
  });
  return runBoundedDiagnosticResult(
    { stdout: child.stdout, exited: child.exited, kill: (signal) => { child.kill(signal); } },
    { timeoutMs: options.timeoutMs, maximumBytes: options.maxBytes, cleanupTimeoutMs: 1_000 },
  );
};

export const probeProjectPage = async (
  config: ProjectPageProbeConfig,
  deps: ProjectPageProbeDeps = {},
): Promise<DoctorProbeOutcome> => {
  if (!config.chatgptProjectUrl) {
    return { status: "skip", message: "No ChatGPT Project URL is configured for a live probe." };
  }
  if (config.browserCdpPort === undefined) {
    return {
      status: "skip",
      message: "No CDP port is configured; the live project-page probe only runs against "
        + "an externally attached Chrome.",
      fix: "chatgpt-consult setup browser --cdp <port>",
    };
  }

  const resolveExecutable = deps.resolveExecutable ?? (() => Bun.which("agent-browser"));
  const executable = resolveExecutable();
  if (!executable) {
    return { status: "skip", message: "agent-browser is unavailable; the live project-page probe cannot run." };
  }

  const attach = deps.attach ?? attachExternalCdp;
  let session: { readonly port: number };
  try {
    session = await attach(config.browserCdpPort);
  } catch {
    return {
      status: "skip",
      message: "Chrome is unreachable on the configured CDP port.",
      fix: "chatgpt-consult setup browser --cdp <port>",
    };
  }

  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (deps.deadlineMs ?? PROJECT_PAGE_PROBE_DEADLINE_MS);
  const runner = deps.commandRunner ?? defaultProjectPageCommandRunner;
  const workspaceFactory = deps.workspaceFactory ?? createAutomationWorkspace;
  const workspaceCleanup = deps.workspaceCleanup ?? cleanupProjectPageWorkspace;

  let workspace: ProjectPageWorkspace;
  try {
    workspace = await workspaceFactory();
  } catch {
    return { status: "warn", message: "The live project-page probe could not prepare its workspace." };
  }

  const globalArgs = [
    executable,
    "--session", createAutomationSessionId(),
    "--cdp", String(session.port),
    "--pin-tab",
    "--content-boundaries",
    "--max-output", "12000",
    "--action-policy", workspace.policyPath,
    "--config", workspace.configPath,
    "--idle-timeout", "10s",
    "--json",
  ];
  const env = buildProjectPageEnv(workspace.dir);

  const run = async (args: readonly string[]): Promise<Record<string, unknown> | null> => {
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    try {
      const result = await runner([...globalArgs, ...args], {
        cwd: workspace.dir,
        env,
        timeoutMs: remaining,
        maxBytes: PROJECT_PAGE_MAX_STDOUT_BYTES,
      });
      if (result.status !== 0) return null;
      return parseAgentBrowserEnvelope(result.output);
    } catch {
      return null;
    }
  };

  let ownedTargetId: string | undefined;
  try {
    const opened = await run(["open", config.chatgptProjectUrl]);
    if (opened === null) {
      return {
        status: "warn",
        message: "The live project-page probe timed out opening the configured project URL.",
      };
    }

    if (typeof opened.targetId === "string" && /^[A-Fa-f0-9]{32}$/.test(opened.targetId)) {
      ownedTargetId = opened.targetId;
    }

    const urlData = await run(["get", "url"]);
    if (urlData === null) {
      return {
        status: "warn",
        message: "The live project-page probe timed out reading the resolved page URL.",
      };
    }
    const classifiedUrl = classifyObservedChatgptUrl(urlData.url);

    let composerNames: readonly string[] = [];
    let signInControlPresent = false;
    let rateLimited = false;
    if (classifiedUrl.kind !== "invalid") {
      for (let attempt = 0; attempt < PROJECT_PAGE_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
        const snapshotData = await run(["snapshot", "-i"]);
        if (snapshotData === null) break;
        const signals = extractSnapshotSignals(snapshotData);
        composerNames = signals.composerNames;
        signInControlPresent = signals.signInControlPresent;
        rateLimited = signals.rateLimited;
        if (composerNames.length > 0 || signInControlPresent || rateLimited) break;
        if (classifiedUrl.kind !== "page") break;
        if (now() + PROJECT_PAGE_SNAPSHOT_RETRY_MS >= deadline) break;
        await sleep(PROJECT_PAGE_SNAPSHOT_RETRY_MS);
      }
    }

    return classifyProjectPageObservation(config.chatgptProjectUrl, {
      urlKind: classifiedUrl.kind,
      ...(classifiedUrl.kind === "page" ? { url: classifiedUrl.url } : {}),
      composerNames,
      signInControlPresent,
      rateLimited,
    });
  } finally {
    try {
      if (ownedTargetId !== undefined) await runner([...globalArgs, "tab", "close", ownedTargetId], {
        cwd: workspace.dir,
        env,
        timeoutMs: PROJECT_PAGE_TAB_CLOSE_BUDGET_MS,
        maxBytes: 4_096,
      });
    } catch {
    }
    try {
      await workspaceCleanup(workspace.dir);
    } catch {
    }
  }
};

const createDefaultProbes = (cwd: string): Record<DoctorProbeName, DoctorProbe> => {
  let projectPromise: Promise<ResolvedProject> | undefined;
  const project = (): Promise<ResolvedProject> => {
    projectPromise ??= resolveProject(cwd);
    return projectPromise;
  };

  const config = async () => readLocalConfig(await project());

  return {
    bun: async () => isSupportedBunVersion(Bun.version)
      ? { status: "pass", message: `Bun ${Bun.version} is supported.` }
      : {
        status: "fail",
        message: "The installed Bun version is unsupported.",
        fix: "Install Bun 1.4.0 or newer.",
      },
    project: async () => {
      try {
        await project();
        return { status: "pass", message: "Project root resolved safely." };
      } catch {
        return { status: "fail", message: "Project root could not be resolved.", fix: "Run doctor from the project directory." };
      }
    },
    ignore_rule: async () => {
      try {
        const text = await readFile(join((await project()).root, ".gitignore"), "utf8");
        const present = text.split(/\r?\n/).some((line) => line.trim() === ".chatgpt-consult/");
        return present
          ? { status: "pass", message: "Private state is ignored by Git." }
          : { status: "fail", message: "The private state ignore rule is missing.", fix: "chatgpt-consult init" };
      } catch {
        return { status: "fail", message: "The private state ignore rule is missing.", fix: "chatgpt-consult init" };
      }
    },
    state_permissions: async () => {
      try {
        const info = await lstat((await project()).stateDir);
        const safe = info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700;
        return safe
          ? { status: "pass", message: "Private state directory permissions are 0700." }
          : { status: "fail", message: "Private state permissions are unsafe.", fix: "chatgpt-consult init" };
      } catch {
        return { status: "fail", message: "Private state is not initialized.", fix: "chatgpt-consult init" };
      }
    },
    stdio_mcp: async () => {
      const result = await setupClients({ apply: false, replace: false });
      const available = result.clients.filter((client) => client.status !== "skipped");
      if (available.length === 0) {
        return { status: "skip", message: "No supported local client CLI is installed.", fix: "chatgpt-consult setup clients" };
      }
      return available.some((client) => client.status === "current")
        ? { status: "pass", message: "A local stdio MCP registration matches this checkout." }
        : { status: "warn", message: "No local stdio MCP registration matches this checkout.", fix: "chatgpt-consult setup clients --apply --replace" };
    },
    http_mcp: async () => {
      const response = await fetchBounded("http://127.0.0.1:43891/health");
      return response?.ok
        ? { status: "pass", message: "Optional loopback ChatGPT MCP health check passed." }
        : { status: "skip", message: "Legacy loopback ChatGPT MCP is not running." };
    },
    tunnel: async () => {
      let raw: string | undefined;
      try { raw = (await config()).tunnelUrl; } catch { /* reported as guidance */ }
      if (!raw) {
        return { status: "skip", message: "Legacy Secure MCP Tunnel compatibility is not configured." };
      }
      let url: URL;
      try { url = new URL(raw); } catch {
        return { status: "warn", message: "Configured tunnel URL is invalid.", fix: "chatgpt-consult setup chatgpt" };
      }
      if (url.protocol !== "https:") {
        return { status: "warn", message: "Configured tunnel must use HTTPS.", fix: "chatgpt-consult setup chatgpt" };
      }
      const response = await fetchBounded(url.toString());
      return response !== null && response.status < 500
        ? { status: "pass", message: "Configured tunnel endpoint is reachable." }
        : { status: "warn", message: "Configured tunnel endpoint is not reachable.", fix: "chatgpt-consult setup chatgpt" };
    },
    chrome: async () => {
      const candidates = [
        Bun.which("google-chrome"),
        Bun.which("google-chrome-stable"),
        Bun.which("chromium"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ].filter((value): value is string => Boolean(value));
      for (const candidate of candidates) {
        if (await fileExists(candidate)) return { status: "pass", message: "A Chrome executable is available." };
      }
      return { status: "fail", message: "A Chrome executable was not found.", fix: "Install Chrome or Chromium, then run chatgpt-consult setup browser." };
    },
    cdp: async () => {
      try {
        const paths = resolveChromePaths(process.env);
        const active = await fileExists(paths.activePortPath);
        const ownership = await fileExists(paths.ownershipPath);
        return active && ownership
          ? { status: "warn", message: "Dedicated CDP state is present, but live ownership was not verified." }
          : { status: "skip", message: "Dedicated CDP session is not running." };
      } catch {
        return { status: "warn", message: "Dedicated CDP configuration is unavailable." };
      }
    },
    webview: async () => {
      const namespace = (globalThis as unknown as { Bun?: Record<string, unknown> }).Bun;
      return typeof namespace?.WebView === "function"
        ? { status: "pass", message: "Bun WebView is available." }
        : { status: "skip", message: "Optional Bun WebView compatibility is unavailable." };
    },
    agent_browser: async () => {
      const executable = Bun.which("agent-browser");
      if (!executable) {
        return { status: "fail", message: "agent-browser is unavailable.", fix: "Run python3 bun-global-tools/sync.py apply from the Personal AI workspace." };
      }
      const status = await boundedCommandStatus([executable, "--version"]);
      return status === 0
        ? { status: "pass", message: "agent-browser passed its version check." }
        : { status: "fail", message: "agent-browser did not pass its version check.", fix: "Run python3 bun-global-tools/sync.py apply from the Personal AI workspace." };
    },
    chatgpt_project_url: async () => {
      try {
        return (await config()).chatgptProjectUrl
          ? { status: "pass", message: "A ChatGPT Project URL is configured." }
          : { status: "fail", message: "No ChatGPT Project URL is configured.", fix: "chatgpt-consult init --chatgpt-project-url <url>" };
      } catch {
        return { status: "fail", message: "ChatGPT Project configuration could not be read.", fix: "chatgpt-consult init --chatgpt-project-url <url>" };
      }
    },
    chatgpt_project_page: async () => {
      let resolved: LocalConfig;
      try {
        resolved = await config();
      } catch {
        return { status: "skip", message: "ChatGPT Project configuration could not be read." };
      }
      return probeProjectPage(resolved);
    },
    browser_login: async () => {
      try {
        if (!(await config()).chatgptProjectUrl) {
          return { status: "skip", message: "Browser login is not checked without a ChatGPT Project URL." };
        }
      } catch {
        return { status: "skip", message: "Browser login is not checked before project initialization." };
      }
      return { status: "warn", message: "Browser login is verified interactively when a consultation runs.", fix: "chatgpt-consult setup browser" };
    },
  };
};

export const runDoctor = async (input: DoctorInput = {}): Promise<DoctorResult> => {
  const defaults = createDefaultProbes(input.cwd ?? process.cwd());
  const checks = await Promise.all(DOCTOR_PROBE_NAMES.map(async (name): Promise<DoctorCheck> => {
    const required = REQUIRED.has(name);
    try {
      const outcome = await (input.probes?.[name] ?? defaults[name])();
      return {
        name,
        required,
        status: outcome.status,
        message: redactDoctorText(outcome.message),
        ...(outcome.fix ? { fix: redactDoctorText(outcome.fix) } : {}),
      };
    } catch {
      return {
        name,
        required,
        status: required ? "fail" : "warn",
        message: "Probe could not complete safely.",
      };
    }
  }));
  return {
    kind: "doctor",
    success: !checks.some((check) => check.required && check.status === "fail"),
    checks,
  };
};
