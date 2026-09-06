import { lstat, readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize } from "node:path";
import { ConsultError } from "../core/errors";
import {
  DEFAULT_BUDGET,
  HARD_BUDGET,
  type AttachmentDescriptor,
  type ContextBudget,
  type ContextPath,
  validateBudget,
} from "../core/schema";
import type { RequestStore } from "../core/store";
import { classifyPath } from "../security/policy";
import {
  inspectBoundedProjectFile,
  mimeTypeForPath,
  readStableProjectFile,
  resolveProjectPath,
  resolveReadablePath,
  type ResolvedProject,
} from "../security/project";
import { scanSecrets } from "../security/secrets";
import {
  detectMimeWithFile,
  readStoredAttachment,
  storeAttachmentFiles,
  type MimeDetector,
} from "./attachments";
import { captureWorkingDiff, readCapturedDiff, runFixed, runGitFixed, type CapturedDiff } from "./diff";
import {
  approvedEntry,
  readApprovedBytes,
  searchApprovedText,
  utf8Chunk,
  type BoundedChunk,
  type SearchHit,
} from "./search";

export interface BuildContextInput {
  goal: string;
  files: string[];
  smart: boolean;
  allowSensitive: boolean;
  budget?: ContextBudget;
}

export interface ContextBuild {
  entries: ContextPath[];
  selectors: string[];
  smartSelection: boolean;
  exclusions: string[];
}

export interface ContextServiceOptions {
  detectMime?: MimeDetector;
  afterContextOpen?: (absolutePath: string) => Promise<void>;
  afterAttachmentOpen?: (absolutePath: string) => Promise<void>;
  beforeLexicalRead?: (absolutePath: string) => Promise<void>;
  resolveExecutable?: (name: string) => string | null;
  runCommand?: typeof runFixed;
}

interface ScoredCandidate {
  score: number;
  reasons: string[];
}

const GLOB_MAGIC = /[*?[\]{}]/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]|^\\\\/;
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
]);
const STOP_WORDS = new Set([
  "about", "after", "before", "could", "handling", "review", "should", "their",
  "there", "these", "those", "through", "using", "where", "which", "would",
]);

const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const invalidSelector = (): never => {
  throw new ConsultError("FORBIDDEN_PATH", "Context selector is outside the project boundary");
};

const normalizeSelector = (selector: string): string => {
  if (typeof selector !== "string" || !selector || selector.includes("\0")) invalidSelector();
  if (isAbsolute(selector) || WINDOWS_ABSOLUTE.test(selector)) invalidSelector();
  const normalized = normalize(selector).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) invalidSelector();
  return normalized;
};

interface ExpandedPaths {
  paths: string[];
  overflow: boolean;
}

const walkDirectory = async (
  project: ResolvedProject,
  relativeDirectory: string,
  maximum: number,
): Promise<ExpandedPaths> => {
  const resolved = relativeDirectory
    ? await resolveProjectPath(project, relativeDirectory)
    : { absolutePath: project.root, relative: "" };
  const info = await lstat(resolved.absolutePath);
  if (!info.isDirectory()) {
    throw new ConsultError("INVALID_INPUT", "Context selector is not a directory");
  }
  const entries = await readdir(resolved.absolutePath, { withFileTypes: true });
  entries.sort((left, right) => bytewise(left.name, right.name));
  const paths: string[] = [];
  for (const entry of entries) {
    const relative = resolved.relative ? `${resolved.relative}/${entry.name}` : entry.name;
    if (classifyPath(relative).kind === "deny") continue;
    if (entry.isDirectory()) {
      const nested = await walkDirectory(project, relative, maximum - paths.length);
      paths.push(...nested.paths);
      if (nested.overflow || paths.length >= maximum) return { paths, overflow: true };
    }
    else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative);
    if (paths.length >= maximum) return { paths, overflow: true };
  }
  return { paths, overflow: false };
};

const expandSelector = async (
  project: ResolvedProject,
  selector: string,
  maximum: number,
): Promise<ExpandedPaths> => {
  const normalized = normalizeSelector(selector);
  if (classifyPath(normalized).kind === "deny") {
    return { paths: [(await resolveReadablePath(project, normalized)).relative], overflow: false };
  }
  if (GLOB_MAGIC.test(normalized)) {
    const matches: string[] = [];
    const glob = new Bun.Glob(normalized);
    for await (const match of glob.scan({
      cwd: project.root,
      dot: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const path = normalizeSelector(match);
      if (classifyPath(path).kind === "allow") matches.push(path);
      if (matches.length >= maximum) return { paths: matches, overflow: true };
    }
    return { paths: matches.sort(bytewise), overflow: false };
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(join(project.root, normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { paths: [(await resolveReadablePath(project, normalized)).relative], overflow: false };
    }
    throw error;
  }
  if (info.isDirectory()) return walkDirectory(project, normalized, maximum);
  return { paths: [normalized], overflow: false };
};

const textMime = (mimeType: string): boolean =>
  mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType);

const inspectCandidate = async (
  project: ResolvedProject,
  path: string,
  selectionReason: string[],
  allowSensitive: boolean,
  afterOpen?: (absolutePath: string) => Promise<void>,
): Promise<ContextPath> => {
  const resolved = await resolveProjectPath(project, path);
  const mimeType = mimeTypeForPath(resolved.absolutePath);
  if (!textMime(mimeType)) {
    throw binaryContextError([resolved.relative]);
  }
  const snapshot = await readStableProjectFile(
    project,
    resolved.relative,
    HARD_BUDGET.maxServedTextBytes,
    afterOpen,
  );
  const content = snapshot.content;
  const text = content.toString("utf8");
  if (Buffer.from(text, "utf8").byteLength !== content.byteLength) {
    throw new ConsultError("INVALID_INPUT", "Selected context is not valid UTF-8 text");
  }
  const scan = scanSecrets(text);
  if (scan.decision === "block" || (scan.decision === "confirm" && !allowSensitive)) {
    throw new ConsultError("SENSITIVE_CONTENT", "Selected context requires a safer selection", {
      decision: scan.decision,
      findingKinds: [...new Set(scan.findings.map((finding) => finding.kind))],
    });
  }
  return {
    path: resolved.relative,
    bytes: content.byteLength,
    sha256: snapshot.sha256,
    mimeType,
    selectionReason,
    sensitivity: {
      decision: "allowed",
      reasons: [...new Set(scan.findings.map((finding) => finding.kind))].sort(bytewise),
    },
  };
};

const MAX_REPORTED_BINARY_PATHS = 5;

const binaryContextError = (paths: readonly string[]): ConsultError => {
  const shown = paths.slice(0, MAX_REPORTED_BINARY_PATHS);
  const remaining = paths.length - shown.length;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return new ConsultError(
    "INVALID_INPUT",
    `Binary project files must move from files to attachments: ${shown.join(", ")}${suffix}`,
  );
};

const explicitEntries = async (
  project: ResolvedProject,
  input: BuildContextInput,
  afterOpen?: (absolutePath: string) => Promise<void>,
): Promise<ContextPath[]> => {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const reasons = new Map<string, Set<string>>();
  for (const [selectorIndex, original] of input.files.entries()) {
    const selector = normalizeSelector(original);
    const expanded = await expandSelector(project, selector, budget.maxPaths + 1);
    if (expanded.overflow) {
      throw new ConsultError("BUDGET_EXCEEDED", "Selected context path budget exceeded", {
        limit: budget.maxPaths,
      });
    }
    for (const path of expanded.paths) {
      const resolved = await resolveProjectPath(project, path);
      const selectedReasons = reasons.get(resolved.relative) ?? new Set<string>();
      selectedReasons.add(`explicit:${selectorIndex}`);
      reasons.set(resolved.relative, selectedReasons);
      if (reasons.size > budget.maxPaths) {
        throw new ConsultError("BUDGET_EXCEEDED", "Selected context path budget exceeded", {
          limit: budget.maxPaths,
        });
      }
    }
  }
  const paths = [...reasons.keys()].sort(bytewise);
  const binary: string[] = [];
  for (const path of paths) {
    const resolved = await resolveProjectPath(project, path);
    if (!textMime(mimeTypeForPath(resolved.absolutePath))) binary.push(resolved.relative);
  }
  if (binary.length > 0) throw binaryContextError(binary);
  const entries = await Promise.all(paths.map((path) => inspectCandidate(
    project,
    path,
    [...reasons.get(path)!].sort(bytewise),
    input.allowSensitive,
    afterOpen,
  )));
  return entries;
};

const meaningfulTerms = (goal: string): string[] => [...new Set(
  goal.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [],
)]
  .filter((term) =>
    term.length >= 4
    && term.length <= 128
    && !STOP_WORDS.has(term)
    && !term.includes("/"))
  .sort(bytewise)
  .slice(0, 12);

const addScore = (
  scores: Map<string, ScoredCandidate>,
  path: string,
  score: number,
  reason: string,
): void => {
  const candidate = scores.get(path) ?? { score: 0, reasons: [] };
  if (!candidate.reasons.includes(reason)) {
    candidate.score += score;
    candidate.reasons.push(reason);
  }
  scores.set(path, candidate);
};

const gitPaths = async (project: ResolvedProject): Promise<string[]> => {
  const git = Bun.which("git");
  if (!git) return [];
  const [prefixResult, status, diff] = await Promise.all([
    runGitFixed(git, ["rev-parse", "--show-prefix"], project.root, 4_096),
    runGitFixed(
      git,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      project.root,
      131_072,
    ),
    runGitFixed(git, ["diff", "--name-only", "-z", "--", "."], project.root, 131_072),
  ]);
  if (prefixResult.exitCode !== 0 || prefixResult.truncated) return [];
  const rawPrefix = prefixResult.stdout.toString("utf8");
  const prefix = rawPrefix.endsWith("\n")
    ? rawPrefix.slice(0, -1).replace(/\r$/, "")
    : rawPrefix;
  if (
    prefix.includes("\0")
    || isAbsolute(prefix)
    || (prefix && (!prefix.endsWith("/") || prefix.startsWith("../")))
  ) return [];
  const localPath = (path: string): string | undefined => {
    const candidate = prefix
      ? (path.startsWith(prefix) ? path.slice(prefix.length) : "")
      : path;
    if (
      !candidate
      || candidate === ".."
      || candidate.startsWith("../")
      || isAbsolute(candidate)
    ) return undefined;
    return candidate;
  };
  const paths = new Set<string>();
  if (status.exitCode === 0) {
    const records = status.stdout.toString("utf8").split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) continue;
      const path = localPath(record.slice(3));
      if (
        path
        && classifyPath(path).kind === "allow"
      ) paths.add(path);
      if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
        index += 1;
      }
    }
  }
  if (diff.exitCode === 0) {
    for (const value of diff.stdout.toString("utf8").split("\0")) {
      const path = localPath(value);
      if (
        path
        && classifyPath(path).kind === "allow"
      ) paths.add(path);
    }
  }
  return [...paths].sort(bytewise);
};

const lexicalMatches = async (
  project: ResolvedProject,
  allFiles: string[],
  terms: string[],
  resolveExecutable: (name: string) => string | null,
  runCommand: typeof runFixed,
  beforeLexicalRead?: (absolutePath: string) => Promise<void>,
): Promise<Map<string, Set<string>>> => {
  const matches = new Map<string, Set<string>>();
  const maximumLexicalBytes = 1_048_576;
  const eligiblePaths: string[] = [];
  for (const path of allFiles.slice(0, 2_000)) {
    try {
      const inspected = await inspectBoundedProjectFile(project, path, maximumLexicalBytes);
      if (textMime(inspected.mimeType)) eligiblePaths.push(path);
    } catch {
      continue;
    }
  }

  const rg = resolveExecutable("rg");
  if (rg) {
    const batches: string[][] = [];
    let batch: string[] = [];
    let batchBytes = 0;
    for (const path of eligiblePaths) {
      const pathBytes = Buffer.byteLength(path, "utf8") + 1;
      if (pathBytes > 30_720) continue;
      if (batch.length >= 240 || (batch.length > 0 && batchBytes + pathBytes > 30_720)) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(path);
      batchBytes += pathBytes;
    }
    if (batch.length > 0) batches.push(batch);
    const eligible = new Set(eligiblePaths);
    for (const term of terms) {
      let remainingOutputBytes = 131_072;
      for (const paths of batches) {
        if (remainingOutputBytes <= 0) break;
        const result = await runCommand(
          [
            rg,
            "-l",
            "--null",
            "--fixed-strings",
            "--ignore-case",
            "--max-filesize",
            "1M",
            "--",
            term,
            ...paths,
          ],
          project.root,
          remainingOutputBytes,
        );
        if (result.exitCode !== 0 && result.exitCode !== 1 && !result.truncated) continue;
        const output = result.stdout.subarray(0, remainingOutputBytes);
        remainingOutputBytes -= output.byteLength;
        const values = output.toString("utf8").split("\0");
        if (output.at(-1) !== 0) values.pop();
        for (const value of values) {
          const path = value.replace(/^\.\//, "");
          if (!eligible.has(path) || classifyPath(path).kind === "deny") continue;
          const pathTerms = matches.get(path) ?? new Set<string>();
          pathTerms.add(term);
          matches.set(path, pathTerms);
        }
        if (result.truncated) break;
      }
    }
    return matches;
  }

  for (const path of eligiblePaths) {
    let snapshot;
    try {
      snapshot = await readStableProjectFile(
        project,
        path,
        maximumLexicalBytes,
        beforeLexicalRead,
      );
    } catch {
      continue;
    }
    const text = snapshot.content.toString("utf8").toLowerCase();
    if (Buffer.byteLength(text, "utf8") !== snapshot.content.byteLength) continue;
    for (const term of terms) {
      if (!text.includes(term)) continue;
      const pathTerms = matches.get(path) ?? new Set<string>();
      pathTerms.add(term);
      matches.set(path, pathTerms);
    }
  }
  return matches;
};

const hasHiddenComponent = (path: string): boolean =>
  path.split("/").some((component) => component.startsWith("."));

const smartEntries = async (
  project: ResolvedProject,
  input: BuildContextInput,
  afterOpen?: (absolutePath: string) => Promise<void>,
  resolveExecutable: (name: string) => string | null = Bun.which,
  runCommand: typeof runFixed = runFixed,
  beforeLexicalRead?: (absolutePath: string) => Promise<void>,
): Promise<ContextPath[]> => {
  const allFiles = (await walkDirectory(project, "", 2_000)).paths
    .filter((path) => !hasHiddenComponent(path))
    .sort(bytewise);
  const available = new Set(allFiles);
  const scores = new Map<string, ScoredCandidate>();
  for (const path of allFiles) {
    if (input.goal.includes(path)) addScore(scores, path, 100, "mentioned_path");
  }
  for (const path of await gitPaths(project)) {
    if (available.has(path)) addScore(scores, path, 80, "changed_path");
  }
  const terms = meaningfulTerms(input.goal);
  const termIndexes = new Map(terms.map((term, index) => [term, index]));
  for (const path of allFiles) {
    const stem = basename(path, extname(path)).toLowerCase().replace(/\.(?:test|spec)$/, "");
    for (const [termIndex, term] of terms.entries()) {
      if (stem === term || stem.includes(term)) {
        addScore(scores, path, 50, `stem_match:${termIndex}`);
      }
    }
  }
  for (const [path, matchedTerms] of await lexicalMatches(
    project,
    allFiles,
    terms,
    resolveExecutable,
    runCommand,
    beforeLexicalRead,
  )) {
    if (!available.has(path)) continue;
    for (const term of [...matchedTerms].sort(bytewise)) {
      const termIndex = termIndexes.get(term);
      if (termIndex !== undefined) addScore(scores, path, 20, `lexical_match:${termIndex}`);
    }
  }
  for (const path of allFiles) {
    if (!/\.(?:test|spec)\.[^.]+$/.test(path)) continue;
    const plain = path.replace(/\.(?:test|spec)(\.[^.]+)$/, "$1");
    if (scores.has(plain)) addScore(scores, path, 10, "adjacent_test");
  }
  const budget = input.budget ?? DEFAULT_BUDGET;
  const selected = [...scores.entries()]
    .sort(([leftPath, left], [rightPath, right]) =>
      right.score - left.score || bytewise(leftPath, rightPath));
  const entries: ContextPath[] = [];
  for (const [path, scored] of selected) {
    if (entries.length >= budget.maxPaths) break;
    try {
      entries.push(await inspectCandidate(
        project,
        path,
        scored.reasons,
        input.allowSensitive,
        afterOpen,
      ));
    } catch (error) {
      if (
        error instanceof ConsultError
        && (error.code === "SENSITIVE_CONTENT" || error.code === "INVALID_INPUT")
      ) continue;
      throw error;
    }
  }
  return entries;
};

export class ContextService {
  private readonly project: Readonly<ResolvedProject>;
  private readonly store: RequestStore;
  private readonly detectMime: MimeDetector;
  private readonly afterContextOpen: ((absolutePath: string) => Promise<void>) | undefined;
  private readonly afterAttachmentOpen: ((absolutePath: string) => Promise<void>) | undefined;
  private readonly beforeLexicalRead: ((absolutePath: string) => Promise<void>) | undefined;
  private readonly resolveExecutable: (name: string) => string | null;
  private readonly runCommand: typeof runFixed;

  constructor(project: ResolvedProject, store: RequestStore, options: ContextServiceOptions = {}) {
    this.project = Object.freeze({ ...project });
    this.store = store;
    this.detectMime = options.detectMime ?? detectMimeWithFile;
    this.afterContextOpen = options.afterContextOpen;
    this.afterAttachmentOpen = options.afterAttachmentOpen;
    this.beforeLexicalRead = options.beforeLexicalRead;
    this.resolveExecutable = options.resolveExecutable ?? Bun.which;
    this.runCommand = options.runCommand ?? runFixed;
  }

  async build(input: BuildContextInput): Promise<ContextBuild> {
    if (typeof input.goal !== "string" || !input.goal.trim()) {
      throw new ConsultError("INVALID_INPUT", "A context goal is required");
    }
    let budget: ContextBudget;
    try {
      budget = validateBudget(input.budget ?? DEFAULT_BUDGET);
    } catch {
      throw new ConsultError("INVALID_INPUT", "Context budget is invalid or exceeds a hard ceiling");
    }
    if (input.files.length > HARD_BUDGET.maxPaths) {
      throw new ConsultError("BUDGET_EXCEEDED", "Context selector count exceeds the hard ceiling", {
        limit: HARD_BUDGET.maxPaths,
      });
    }
    const selectors = [...new Set(input.files.map(normalizeSelector))];
    const normalizedInput = { ...input, files: selectors, budget };
    let entries: ContextPath[];
    if (!input.smart) {
      entries = await explicitEntries(this.project, normalizedInput, this.afterContextOpen);
    } else {
      const explicit = await explicitEntries(this.project, normalizedInput, this.afterContextOpen);
      entries = [...explicit];
      if (entries.length < budget.maxPaths) {
        const smart = await smartEntries(
          this.project,
          normalizedInput,
          this.afterContextOpen,
          this.resolveExecutable,
          this.runCommand,
          this.beforeLexicalRead,
        );
        const byPath = new Map(explicit.map((entry) => [entry.path, entry]));
        for (const smartEntry of smart) {
          const selected = byPath.get(smartEntry.path);
          if (selected) {
            selected.selectionReason = [
              ...selected.selectionReason,
              ...smartEntry.selectionReason.filter((reason) => !selected.selectionReason.includes(reason)),
            ];
            continue;
          }
          if (entries.length >= budget.maxPaths) break;
          entries.push(smartEntry);
          byPath.set(smartEntry.path, smartEntry);
        }
      }
    }
    return {
      entries,
      selectors,
      smartSelection: input.smart,
      exclusions: ["default-deny paths", "hidden paths in smart discovery"],
    };
  }

  async read(input: {
    requestId: string;
    claimToken: string;
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<BoundedChunk> {
    const request = await this.store.authorize(input.requestId, input.claimToken);
    const entry = approvedEntry(request, input.path);
    const content = await readApprovedBytes(this.project, entry);
    const limit = Math.min(input.limit ?? request.budget.maxReadBytes, request.budget.maxReadBytes);
    const chunk = utf8Chunk(entry.path, entry.sha256, content, input.offset ?? 0, limit);
    await this.store.consumeTextBudget(
      input.requestId,
      input.claimToken,
      Buffer.byteLength(chunk.text),
    );
    return chunk;
  }

  async search(input: {
    requestId: string;
    claimToken: string;
    query: string;
    paths?: string[];
  }): Promise<SearchHit[]> {
    return searchApprovedText(this.project, this.store, input);
  }

  async captureDiff(input: {
    kind: "working";
    maxBytes?: number;
    budget?: ContextBudget;
    allowSensitive?: boolean;
  }): Promise<CapturedDiff> {
    if (input.kind !== "working") {
      throw new ConsultError("INVALID_INPUT", "Only a working-tree diff can be captured");
    }
    let budget: ContextBudget | undefined;
    if (input.budget) {
      try {
        budget = validateBudget(input.budget);
      } catch {
        throw new ConsultError("INVALID_INPUT", "Diff budget is invalid or exceeds a hard ceiling");
      }
    }
    const maxBytes = input.maxBytes
      ?? budget?.maxServedTextBytes
      ?? DEFAULT_BUDGET.maxServedTextBytes;
    if (maxBytes > HARD_BUDGET.maxServedTextBytes) {
      throw new ConsultError("BUDGET_EXCEEDED", "Diff exceeds the hard text ceiling", {
        limit: HARD_BUDGET.maxServedTextBytes,
      });
    }
    return captureWorkingDiff(
      this.project,
      this.store,
      maxBytes,
      input.allowSensitive ?? false,
    );
  }

  async readDiff(input: {
    requestId: string;
    claimToken: string;
    offset?: number;
    limit?: number;
  }): Promise<BoundedChunk> {
    return readCapturedDiff(this.project, this.store, input);
  }

  async storeAttachments(input: {
    paths: string[];
    budget: ContextBudget;
    allowSensitive?: boolean;
  }): Promise<AttachmentDescriptor[]> {
    let budget: ContextBudget;
    try {
      budget = validateBudget(input.budget);
    } catch {
      throw new ConsultError("INVALID_INPUT", "Attachment budget is invalid or exceeds a hard ceiling");
    }
    if (input.paths.length > HARD_BUDGET.maxPaths) {
      throw new ConsultError("BUDGET_EXCEEDED", "Attachment path count exceeds the hard ceiling", {
        limit: HARD_BUDGET.maxPaths,
      });
    }
    return storeAttachmentFiles(
      this.project,
      this.store,
      { ...input, budget },
      this.detectMime,
      this.afterAttachmentOpen,
    );
  }

  async readAttachment(input: {
    requestId: string;
    claimToken: string;
    id: string;
  }): Promise<AttachmentDescriptor & { data: Buffer }> {
    const request = await this.store.authorize(input.requestId, input.claimToken);
    const descriptor = request.attachments.find((attachment) => attachment.id === input.id);
    if (!descriptor) throw new ConsultError("NOT_FOUND", "Attachment was not found");
    const data = await readStoredAttachment(this.project, this.store, descriptor);
    return { ...descriptor, data };
  }
}
