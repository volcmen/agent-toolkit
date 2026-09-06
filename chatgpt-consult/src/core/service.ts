import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { type ContextService } from "../context/selection";
import { configuredRoot } from "../browser/cdp";
import { formatChatgptHandoff, sanitizeChatgptUrl } from "../browser/handoff";
import { classifyPath } from "../security/policy";
import type { ResolvedProject } from "../security/project";
import { inspectTextClaimMaterial, redactCompletionClaimMaterial } from "./claim-material";
import { ConsultError } from "./errors";
import {
  CapabilityProfileSchema,
  CompletionSchema,
  LocalConfigSchema,
  resolveBudget,
  type CapabilityProfile,
  type BrowserFailureReason,
  type BrowserPhase,
  type ConsultationCompletion,
  type ConsultationRequest,
  type ContextBudgetOverride,
  type LocalConfig,
  type StoredCompletion,
  type SubmissionCertainty,
} from "./schema";
import { RequestStore } from "./store";
import { buildBoundedConsultationText } from "./bundle";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANUAL_BUNDLE_LIMIT = 65_536;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]|^\\\\/;
export interface BrowserWorkerLauncher {
  start(requestId: string): Promise<void>;
}

class UnavailableBrowserWorkerLauncher implements BrowserWorkerLauncher {
  async start(): Promise<void> {
    throw new ConsultError("UNAVAILABLE", "Browser worker unavailable");
  }
}

export interface StartInput {
  goal: string;
  profile: CapabilityProfile;
  files: string[];
  smart: boolean;
  attachments: string[];
  diff: "working" | "none";
  open: boolean;
  allowSensitive?: boolean;
  connectors?: string[];
  idempotencyKey?: string;
  budget?: ContextBudgetOverride;
  parentId?: string | null;
  conversationUrl?: string | null;
}

export interface FollowupInput extends Omit<StartInput, "profile" | "parentId"> {
  parentId: string;
  profile?: CapabilityProfile;
}

export interface StartResult {
  requestId: string;
  state: ConsultationRequest["state"];
  revision: number;
  claimToken: string;
  handoff: string;
  browser?: BrowserStatus;
}

export interface BrowserStatus {
  phase: BrowserPhase;
  reason: BrowserFailureReason | null;
  attempt: number;
  submissionCertainty: SubmissionCertainty;
  workerActive: boolean;
  conversationUrl?: string;
}

export interface StatusResult {
  requestId: string;
  state: ConsultationRequest["state"];
  revision: number;
  goal: string;
  profile: CapabilityProfile;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  summary?: string;
  completionSource?: StoredCompletion["source"];
  browser?: BrowserStatus;
}

export interface ShowResult extends StatusResult {
  completion: ConsultationCompletion | null;
}

export interface HandoffResult {
  requestId: string;
  state: ConsultationRequest["state"];
  revision: number;
  claimToken: string;
  handoff: string;
}

export interface OpenResult extends StatusResult {
  browser: BrowserStatus;
}

export interface ConsultationSummary extends StatusResult {}

export interface ConsultationServiceOptions {
  workerLauncher?: BrowserWorkerLauncher;
  now?: () => Date;
  beforePublicationCommit?: (directory: string) => Promise<void>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type WaitOutcome = "snapshot" | "actionable" | "bound_elapsed" | "aborted";

export interface WaitStatusResult {
  status: StatusResult;
  outcome: WaitOutcome;
  waitedSeconds: number;
}

export const MAX_STATUS_WAIT_SECONDS = 50;
const STATUS_WAIT_INTERVAL_MS = 1_000;

const waitForInterval = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, milliseconds);
    signal?.addEventListener("abort", settle, { once: true });
  });

const statusIsActionable = (status: StatusResult): boolean => {
  if (status.state !== "pending" && status.state !== "claimed") return true;
  const browser = status.browser;
  if (browser === undefined) return true;
  if (!browser.workerActive) return true;
  if (browser.phase === "needs_login") return true;
  if (browser.phase !== "needs_manual") return false;
  return !(browser.reason === "submission_uncertain" && browser.submissionCertainty === "uncertain");
};

export interface InitializeProjectInput {
  chatgptProjectUrl?: string;
}

const timestamp = (now: () => Date): string => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ConsultError("INTERNAL", "Clock returned an invalid date");
  }
  return value.toISOString();
};

const atomicWrite = async (path: string, data: string, mode: number): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  let renamed = false;
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
    await chmod(path, mode);
  } finally {
    try {
      await handle.close();
    } catch {
      // The handle is already closed on the successful path.
    }
    if (!renamed) await rm(temporary, { force: true });
  }
};

const GLOBAL_CONFIG_FILE = "config.json";

const readConfigFile = async (path: string, label: string): Promise<LocalConfig | null> => {
  let text: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ConsultError("CORRUPT_STATE", `${label} configuration is not a regular file`);
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConsultError("INVALID_INPUT", `${label} configuration is malformed JSON`);
  }
  const parsed = LocalConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConsultError("INVALID_INPUT", `${label} configuration does not match its schema`);
  }
  try {
    resolveBudget(parsed.data.budget);
  } catch {
    throw new ConsultError("INVALID_INPUT", `${label} configuration budget exceeds a hard ceiling`);
  }
  if (parsed.data.chatgptProjectUrl != null) {
    const canonical = sanitizeChatgptUrl(parsed.data.chatgptProjectUrl, "configured");
    if (canonical === null) {
      throw new ConsultError("INVALID_INPUT", "Persisted project URL is not a valid ChatGPT endpoint");
    }
    if (canonical !== parsed.data.chatgptProjectUrl) {
      return { ...parsed.data, chatgptProjectUrl: canonical };
    }
  }
  return parsed.data;
};

const readExistingConfig = (project: ResolvedProject): Promise<LocalConfig | null> =>
  readConfigFile(join(project.stateDir, "config.local.json"), "Local");

export const globalConfigPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => join(configuredRoot(environment), GLOBAL_CONFIG_FILE);

const readGlobalConfig = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<LocalConfig | null> => {
  let path: string;
  try {
    path = globalConfigPath(environment);
  } catch {
    return null;
  }
  return readConfigFile(path, "Global");
};

export const readLocalConfig = async (
  project: ResolvedProject,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LocalConfig> => {
  const existing = await readExistingConfig(project) ?? await readGlobalConfig(environment);
  return existing ?? LocalConfigSchema.parse({
    schemaVersion: 1,
    defaultProfile: "lean",
    connectorAllowlist: [],
    budget: {},
  });
};

export const configureBrowserCdp = async (
  project: ResolvedProject,
  port: number | null,
): Promise<LocalConfig> => {
  if (port !== null && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new ConsultError("INVALID_INPUT", "Browser CDP port must be an integer from 1 through 65535");
  }
  const current = await readLocalConfig(project);
  const { browserCdpPort: _discarded, ...withoutPort } = current;
  const parsed = LocalConfigSchema.safeParse(port === null
    ? withoutPort
    : { ...withoutPort, browserCdpPort: port });
  if (!parsed.success) {
    throw new ConsultError("INVALID_INPUT", "Local configuration does not match its schema");
  }
  const path = join(project.stateDir, "config.local.json");
  await atomicWrite(path, `${JSON.stringify(parsed.data, null, 2)}\n`, PRIVATE_FILE_MODE);
  return parsed.data;
};

const ensureIgnoreLine = async (project: ResolvedProject): Promise<void> => {
  const path = join(project.root, ".gitignore");
  let original = "";
  let mode = 0o644;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ConsultError("FORBIDDEN_PATH", ".gitignore must be a regular project file");
    }
    mode = info.mode & 0o777;
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original === "" ? [] : original.split(/\r?\n/);
  if (original.endsWith("\n")) lines.pop();
  const preserved = lines.filter((line) => line !== ".chatgpt-consult/");
  preserved.push(".chatgpt-consult/");
  await atomicWrite(path, `${preserved.join(eol)}${eol}`, mode);
};

export const initializeProject = async (
  project: ResolvedProject,
  input: InitializeProjectInput,
): Promise<{ stateDir: string; configPath?: string }> => {
  let canonicalUrl: string | undefined;
  if (input.chatgptProjectUrl !== undefined) {
    const sanitized = sanitizeChatgptUrl(input.chatgptProjectUrl, "configured");
    if (sanitized === null) {
      throw new ConsultError("INVALID_INPUT", "Project URL is not a valid ChatGPT endpoint");
    }
    canonicalUrl = sanitized;
  }
  await RequestStore.init(project);
  await ensureIgnoreLine(project);
  const existing = await readExistingConfig(project);
  if (!existing && canonicalUrl === undefined) {
    return { stateDir: ".chatgpt-consult" };
  }
  const value = {
    ...(existing ?? {
      schemaVersion: 1 as const,
      defaultProfile: "lean" as const,
      connectorAllowlist: [],
      budget: {},
    }),
    ...(canonicalUrl === undefined
      ? {}
      : { chatgptProjectUrl: canonicalUrl }),
  };
  const parsed = LocalConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConsultError("INVALID_INPUT", "Local configuration does not match its schema");
  }
  try {
    resolveBudget(parsed.data.budget);
  } catch {
    throw new ConsultError("INVALID_INPUT", "Local configuration budget exceeds a hard ceiling");
  }
  const path = join(project.stateDir, "config.local.json");
  await atomicWrite(path, `${JSON.stringify(parsed.data, null, 2)}\n`, PRIVATE_FILE_MODE);
  return { stateDir: ".chatgpt-consult", configPath: ".chatgpt-consult/config.local.json" };
};

const normalizeConnectors = (values: string[]): string[] => {
  if (values.length > 100) {
    throw new ConsultError("INVALID_INPUT", "At most 100 connector names are permitted");
  }
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (normalized.some((value) => !value || value.length > 128)) {
    throw new ConsultError("INVALID_INPUT", "Connector names must contain 1 to 128 characters");
  }
  return [...new Set(normalized)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)));
};

const validateIdempotencyKey = (value: string): string => {
  if (!SAFE_IDEMPOTENCY_KEY.test(value)) {
    throw new ConsultError(
      "INVALID_INPUT",
      "Idempotency keys must contain 1 to 128 safe characters",
    );
  }
  return value;
};

const workerIsActive = (request: ConsultationRequest, now: Date): boolean => {
  const lease = request.browserExecution?.lease;
  return lease !== null && lease !== undefined
    && new Date(lease.expiresAt).getTime() > now.getTime();
};

const publicStatus = (
  request: ConsultationRequest,
  result: StoredCompletion | null,
  now: Date,
): StatusResult => ({
  requestId: request.id,
  state: request.state,
  revision: request.revision,
  goal: request.goal,
  profile: request.profile,
  parentId: request.parentId,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
  expiresAt: request.expiresAt,
  ...(result ? {
    summary: redactCompletionClaimMaterial(result.completion, request.claimHash).summary,
  } : {}),
  ...(result ? { completionSource: result.source } : {}),
  ...(request.browserExecution ? {
    browser: {
      phase: request.browserExecution.phase,
      reason: request.browserExecution.reason,
      attempt: request.browserExecution.attempt,
      submissionCertainty: request.browserExecution.submission.certainty,
      workerActive: workerIsActive(request, now),
      ...(request.conversationUrl ? { conversationUrl: request.conversationUrl } : {}),
    },
  } : {}),
});

const safePublicationPath = (output: string): string => {
  if (!output || output.includes("\0") || isAbsolute(output) || WINDOWS_ABSOLUTE.test(output)) {
    throw new ConsultError("FORBIDDEN_PATH", "Publication path must be project-relative");
  }
  if (output.replaceAll("\\", "/").split("/").includes("..")) {
    throw new ConsultError("FORBIDDEN_PATH", "Publication path cannot contain traversal");
  }
  const normalized = normalize(output).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new ConsultError("FORBIDDEN_PATH", "Publication path leaves the project");
  }
  if (normalized === ".chatgpt-consult" || normalized.startsWith(".chatgpt-consult/")) {
    throw new ConsultError("FORBIDDEN_PATH", "Private state cannot be published");
  }
  if (classifyPath(normalized).kind === "deny") {
    throw new ConsultError("FORBIDDEN_PATH", "Publication path is denied by project policy");
  }
  return normalized;
};

const revalidateSafeDirectory = async (root: string, directory: string): Promise<void> => {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ConsultError("FORBIDDEN_PATH", "Output directory is not a real directory");
  }
  const canonical = await realpath(directory);
  const contained = relative(root, canonical).replaceAll("\\", "/");
  if (
    canonical !== directory
    || contained === ".."
    || contained.startsWith("../")
    || isAbsolute(contained)
  ) {
    throw new ConsultError("FORBIDDEN_PATH", "Output directory leaves the project");
  }
};

const ensureSafeDirectory = async (
  root: string,
  relativeDirectory: string,
  mode: number,
): Promise<string> => {
  let current = root;
  for (const component of relativeDirectory.split("/").filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ConsultError("FORBIDDEN_PATH", "Output directory is not a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode });
    }
  }
  const canonical = await realpath(current);
  const contained = relative(root, canonical).replaceAll("\\", "/");
  if (contained === ".." || contained.startsWith("../") || isAbsolute(contained)) {
    throw new ConsultError("FORBIDDEN_PATH", "Output directory leaves the project");
  }
  return canonical;
};

const stripMarkdownTitle = (value: string): string => value
  .replace(/[\r\n]+/g, " ")
  .replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 120) || "Consultation";

const slugFor = (value: string): string => value
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 72)
  .replace(/-+$/g, "") || "consultation";

const markdownText = (value: string): string => value
  .replaceAll("\\", "\\\\")
  .replace(/([`*_{}\[\]<>#+|])/g, "\\$1")
  .replace(/\r?\n/g, " ");

const markdownList = (values: string[]): string =>
  values.length === 0 ? "_None._" : values.map((value) => `- ${markdownText(value)}`).join("\n");

const renderPublication = (
  request: ConsultationRequest,
  result: StoredCompletion,
  date: string,
): string => {
  const value = redactCompletionClaimMaterial(result.completion, request.claimHash);
  return [
    `# ${stripMarkdownTitle(request.goal)}`,
    "",
    `Date: ${date}`,
    `Request ID: \`${request.id}\``,
    "",
    "## Goal",
    "",
    markdownText(request.goal),
    "",
    "## Summary",
    "",
    markdownText(value.summary),
    "",
    "## Answer",
    "",
    markdownText(value.answer),
    "",
    "## Evidence",
    "",
    markdownList(value.evidence),
    "",
    "## Assumptions",
    "",
    markdownList(value.assumptions),
    "",
    "## Risks",
    "",
    markdownList(value.risks),
    "",
    "## Recommendations",
    "",
    markdownList(value.recommendations),
    "",
    "## Follow-ups",
    "",
    markdownList(value.followUpQuestions),
    "",
  ].join("\n");
};

export class ConsultationService {
  private readonly project: Readonly<ResolvedProject>;
  private readonly store: RequestStore;
  private readonly context: ContextService;
  private readonly workerLauncher: BrowserWorkerLauncher;
  private readonly now: () => Date;
  private readonly beforePublicationCommit: ((directory: string) => Promise<void>) | undefined;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    project: ResolvedProject,
    store: RequestStore,
    context: ContextService,
    options: ConsultationServiceOptions = {},
  ) {
    this.project = Object.freeze({ ...project });
    this.store = store;
    this.context = context;
    this.workerLauncher = options.workerLauncher ?? new UnavailableBrowserWorkerLauncher();
    this.now = options.now ?? (() => new Date());
    this.beforePublicationCommit = options.beforePublicationCommit;
    this.wait = options.wait ?? waitForInterval;
  }

  async start(input: StartInput): Promise<StartResult> {
    if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 8_192) {
      throw new ConsultError("INVALID_INPUT", "A goal containing 1 to 8192 characters is required");
    }
    const profile = CapabilityProfileSchema.safeParse(input.profile);
    if (!profile.success) throw new ConsultError("INVALID_INPUT", "Capability profile is invalid");
    const connectors = normalizeConnectors(input.connectors ?? []);
    if (connectors.length > 0 && profile.data !== "connected") {
      throw new ConsultError("INVALID_INPUT", "Connectors require the connected profile");
    }
    let budget;
    try {
      budget = resolveBudget(input.budget ?? {});
    } catch {
      throw new ConsultError("INVALID_INPUT", "Request budget is invalid or exceeds a hard ceiling");
    }
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey ?? randomUUID());

    const built = await this.context.build({
      goal: input.goal,
      files: input.files,
      smart: input.smart,
      allowSensitive: input.allowSensitive ?? false,
      budget,
    });
    const attachments = await this.context.storeAttachments({
      paths: input.attachments,
      budget,
      allowSensitive: input.allowSensitive ?? false,
    });
    const diff = input.diff === "working"
      ? (await this.context.captureDiff({
        kind: "working",
        budget,
        allowSensitive: input.allowSensitive ?? false,
      })).metadata
      : null;
    const sensitivity = [
      ...built.entries.map((entry) => ({
        scope: `context:${entry.path}`,
        decision: entry.sensitivity.decision,
        reasons: entry.sensitivity.reasons,
      })),
      ...attachments.map((entry) => ({
        scope: `attachment:${entry.id}`,
        decision: entry.sensitivity.decision,
        reasons: entry.sensitivity.reasons,
      })),
    ];

    const created = await this.store.create({
      projectName: basename(this.project.root),
      goal: input.goal.trim(),
      profile: profile.data,
      parentId: input.parentId ?? null,
      conversationUrl: input.conversationUrl ?? null,
      idempotencyKey,
      budget,
      contextManifest: {
        selectors: built.selectors,
        paths: built.entries,
        smartSelection: built.smartSelection,
        exclusions: built.exclusions,
      },
      diff,
      attachments,
      sensitivity,
      connectorAllowlist: connectors,
    });
    let request = created.request;
    const result: StartResult = {
      requestId: created.request.id,
      state: created.request.state,
      revision: created.request.revision,
      claimToken: created.claimToken,
      handoff: formatChatgptHandoff(created.request.id, created.claimToken),
    };
    if (input.open) {
      request = await this.store.queueBrowserExecution(created.request.id);
      request = await this.launchWorker(created.request.id);
      result.state = request.state;
      result.revision = request.revision;
      result.browser = this.browserStatus(request);
    }
    return result;
  }

  async status(id: string): Promise<StatusResult> {
    const request = await this.store.get(id);
    return publicStatus(request, await this.store.getCompletion(id), this.now());
  }

  async waitStatus(id: string, seconds: number, signal?: AbortSignal): Promise<WaitStatusResult> {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_STATUS_WAIT_SECONDS) {
      throw new ConsultError(
        "INVALID_INPUT",
        `wait_seconds: expected an integer from 0 to ${MAX_STATUS_WAIT_SECONDS}`,
      );
    }
    let status = await this.status(id);
    if (seconds === 0) return { status, outcome: "snapshot", waitedSeconds: 0 };
    if (statusIsActionable(status)) return { status, outcome: "actionable", waitedSeconds: 0 };
    for (let waited = 1; waited <= seconds; waited += 1) {
      if (signal?.aborted) return { status, outcome: "aborted", waitedSeconds: waited - 1 };
      await this.wait(STATUS_WAIT_INTERVAL_MS, signal);
      if (signal?.aborted) return { status, outcome: "aborted", waitedSeconds: waited - 1 };
      status = await this.status(id);
      if (statusIsActionable(status)) return { status, outcome: "actionable", waitedSeconds: waited };
    }
    return { status, outcome: "bound_elapsed", waitedSeconds: seconds };
  }

  async show(id: string): Promise<ShowResult> {
    const request = await this.store.get(id);
    const result = await this.store.getCompletion(id);
    return {
      ...publicStatus(request, result, this.now()),
      completion: result
        ? redactCompletionClaimMaterial(result.completion, request.claimHash)
        : null,
    };
  }

  async followup(input: FollowupInput): Promise<StartResult> {
    const parent = await this.store.get(input.parentId);
    if (input.open && parent.conversationUrl === null) {
      throw new ConsultError(
        "CONFLICT",
        "Automatic follow-up requires a proven parent conversation URL",
      );
    }
    const profile = input.profile ?? parent.profile;
    return this.start({
      ...input,
      profile,
      parentId: parent.id,
      conversationUrl: parent.conversationUrl,
      connectors: input.connectors
        ?? (profile === "connected" ? parent.connectorAllowlist : []),
    });
  }

  async cancel(id: string): Promise<StatusResult> {
    const request = await this.store.cancel(id);
    return publicStatus(request, await this.store.getCompletion(id), this.now());
  }

  async publish(id: string, output?: string): Promise<{ path: string }> {
    const request = await this.store.get(id);
    const result = await this.store.getCompletion(id);
    if (request.state !== "completed" || !result) {
      throw new ConsultError("CONFLICT", "Only a completed request can be published");
    }
    const date = timestamp(this.now).slice(0, 10);
    const path = safePublicationPath(
      output ?? `docs/consultations/${date}-${slugFor(request.goal)}.md`,
    );
    if (inspectTextClaimMaterial(path, request.claimHash) !== "clean") {
      throw new ConsultError("INVALID_INPUT", "Publication path contains forbidden claim material");
    }
    await this.writePublication(path, renderPublication(request, result, date));
    return { path };
  }

  private async writePublication(path: string, text: string): Promise<void> {
    const relativeDirectory = dirname(path).replaceAll("\\", "/");
    const directory = await ensureSafeDirectory(this.project.root, relativeDirectory, 0o755);
    if (this.beforePublicationCommit) await this.beforePublicationCommit(directory);
    await revalidateSafeDirectory(this.project.root, directory);
    const destination = join(directory, basename(path));
    const temporary = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      await revalidateSafeDirectory(this.project.root, directory);
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ConsultError("CONFLICT", "Publication already exists");
        }
        throw error;
      }
      await unlink(temporary);
    } finally {
      try {
        await handle.close();
      } catch {
        // The handle is already closed on the successful path.
      }
      await rm(temporary, { force: true });
    }
  }

  async rotateHandoff(id: string, allowClaimed = false): Promise<HandoffResult> {
    const rotated = await this.store.rotateClaim(id, allowClaimed);
    return {
      requestId: rotated.request.id,
      state: rotated.request.state,
      revision: rotated.request.revision,
      claimToken: rotated.claimToken,
      handoff: formatChatgptHandoff(rotated.request.id, rotated.claimToken),
    };
  }

  async open(id: string): Promise<OpenResult> {
    const request = await this.store.get(id);
    if (request.state === "cancelled" || request.state === "completed"
      || request.state === "expired") {
      throw new ConsultError("CONFLICT", `Cannot resume a ${request.state} request`);
    }
    await this.store.queueBrowserExecution(id);
    const resumed = await this.launchWorker(id);
    const status = publicStatus(resumed, await this.store.getCompletion(id), this.now());
    if (!status.browser) {
      throw new ConsultError("INTERNAL", "Browser execution state is unavailable");
    }
    return { ...status, browser: status.browser };
  }

  private async launchWorker(id: string): Promise<ConsultationRequest> {
    try {
      await this.workerLauncher.start(id);
    } catch {
      await this.store.recordBrowserLaunchFailure(id);
    }
    return this.store.get(id);
  }

  private browserStatus(request: ConsultationRequest): BrowserStatus {
    const execution = request.browserExecution;
    if (execution === null) {
      throw new ConsultError("INTERNAL", "Browser execution state is unavailable");
    }
    return {
      phase: execution.phase,
      reason: execution.reason,
      attempt: execution.attempt,
      submissionCertainty: execution.submission.certainty,
      workerActive: workerIsActive(request, this.now()),
      ...(request.conversationUrl ? { conversationUrl: request.conversationUrl } : {}),
    };
  }

  async manualBundle(id: string): Promise<{ path: string; text: string }> {
    const request = await this.store.get(id);
    if (request.state === "expired") {
      throw new ConsultError("EXPIRED", "The request has expired");
    }
    if (request.state !== "pending" && request.state !== "claimed") {
      throw new ConsultError("CONFLICT", `Cannot bundle a ${request.state} request`);
    }
    const text = await buildBoundedConsultationText(
      this.project,
      this.store,
      request,
      MANUAL_BUNDLE_LIMIT,
    );
    const directory = await ensureSafeDirectory(this.project.stateDir, "manual", PRIVATE_DIRECTORY_MODE);
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    const stateRelativePath = `manual/${request.id}.md`;
    await atomicWrite(join(this.project.stateDir, stateRelativePath), text, PRIVATE_FILE_MODE);
    return { path: `.chatgpt-consult/${stateRelativePath}`, text };
  }

  async importManualCompletion(id: string, value: unknown): Promise<StatusResult> {
    const parsed = CompletionSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConsultError("INVALID_INPUT", "Completion does not match the completion schema");
    }
    const request = await this.store.get(id);
    const expectedRevision = request.state === "completed"
      ? request.revision - 1
      : request.revision;
    const completed = await this.store.completeLocal(id, expectedRevision, parsed.data);
    return publicStatus(completed.request, completed.result, this.now());
  }

  async listRecent(limit = 20): Promise<ConsultationSummary[]> {
    const requests = await this.store.listRecent(limit);
    return Promise.all(requests.map(async (request) =>
      publicStatus(request, await this.store.getCompletion(request.id), this.now())));
  }
}
