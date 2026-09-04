import { ConsultError } from "../core/errors";
import type { DiffMetadata } from "../core/schema";
import type { RequestStore } from "../core/store";
import { classifyPath } from "../security/policy";
import type { ResolvedProject } from "../security/project";
import { scanSecrets } from "../security/secrets";
import { readStoredAttachment, storeImmutableBlob } from "./attachments";
import { utf8Chunk, type BoundedChunk } from "./search";

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  truncated: boolean;
}

const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  stop: () => void,
): Promise<{ bytes: Buffer; truncated: boolean }> => {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    const remaining = limit - total;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      truncated = true;
      stop();
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
};

export const runFixed = async (
  argv: string[],
  cwd: string,
  stdoutLimit: number,
  stderrLimit = 8_192,
  env?: Record<string, string>,
): Promise<ProcessResult> => {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  const stop = () => child.kill();
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, stdoutLimit, stop),
    readBounded(child.stderr, stderrLimit, stop),
    child.exited,
  ]);
  return {
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    exitCode,
    truncated: stdout.truncated || stderr.truncated,
  };
};

const gitEnvironment = (cwd: string): Record<string, string> => ({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  HOME: cwd,
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
});

const GIT_CONFIG_PREFIX = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
  "-c", "status.relativePaths=true",
  "-c", "diff.external=",
];

export const runGitFixed = async (
  executable: string,
  args: string[],
  cwd: string,
  stdoutLimit: number,
  stderrLimit = 8_192,
): Promise<ProcessResult> => runFixed(
  [executable, ...GIT_CONFIG_PREFIX, ...args],
  cwd,
  stdoutLimit,
  stderrLimit,
  gitEnvironment(cwd),
);

const truncateUtf8 = (value: Buffer, maximum: number): Buffer => {
  if (value.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0 && (value[end] ?? 0) >> 6 === 0b10) end -= 1;
  return value.subarray(0, end);
};

export interface CapturedDiff {
  metadata: DiffMetadata;
  truncated: boolean;
}

const DIFF_PATH_OUTPUT_LIMIT = 1_048_576;

const secretScanText = (diff: string): string => diff
  .split("\n")
  .map((line) => line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line)
  .join("\n");

const validateChangedPaths = (result: ProcessResult): void => {
  if (result.exitCode !== 0 || result.truncated) {
    throw new ConsultError("BUDGET_EXCEEDED", "Changed-path discovery exceeded its safe boundary");
  }
  if (result.stdout.byteLength === 0) return;
  if (result.stdout.at(-1) !== 0) {
    throw new ConsultError("UNAVAILABLE", "Git changed-path output was malformed");
  }
  for (const record of result.stdout.subarray(0, -1).toString("binary").split("\0")) {
    const raw = Buffer.from(record, "binary");
    if (raw.byteLength < 4 || raw[2] !== 0x20) {
      throw new ConsultError("UNAVAILABLE", "Git changed-path output was malformed");
    }
    const bytes = raw.subarray(3);
    const path = bytes.toString("utf8");
    if (Buffer.from(path, "utf8").compare(bytes) !== 0 || !path) {
      throw new ConsultError("FORBIDDEN_PATH", "Changed path is not safe UTF-8 text");
    }
    if (classifyPath(path).kind === "deny") {
      throw new ConsultError("FORBIDDEN_PATH", "Working diff contains an excluded project path");
    }
  }
};

export const captureWorkingDiff = async (
  project: ResolvedProject,
  store: RequestStore,
  maxBytes: number,
  allowSensitive = false,
): Promise<CapturedDiff> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ConsultError("INVALID_INPUT", "Diff byte limit must be positive");
  }
  const git = Bun.which("git");
  if (!git) throw new ConsultError("UNAVAILABLE", "Git is required to capture a working diff");
  const check = await runGitFixed(git, ["rev-parse", "--is-inside-work-tree"], project.root, 64);
  if (check.exitCode !== 0 || check.stdout.toString("utf8").trim() !== "true") {
    throw new ConsultError("INVALID_INPUT", "Project is not a Git work tree");
  }
  const changedPaths = await runGitFixed(
    git,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames", "--", "."],
    project.root,
    DIFF_PATH_OUTPUT_LIMIT,
  );
  validateChangedPaths(changedPaths);

  const outputLimit = maxBytes + 1;
  const [working, staged] = await Promise.all([
    runGitFixed(
      git,
      ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--", "."],
      project.root,
      outputLimit,
    ),
    runGitFixed(
      git,
      ["diff", "--cached", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--", "."],
      project.root,
      outputLimit,
    ),
  ]);
  if ((working.exitCode !== 0 && !working.truncated) || (staged.exitCode !== 0 && !staged.truncated)) {
    throw new ConsultError("UNAVAILABLE", "Git diff capture failed");
  }
  const workingLabel = Buffer.from("=== WORKING TREE ===\n");
  const stagedLabel = Buffer.from("\n=== STAGED ===\n");
  const labelBytes = workingLabel.byteLength + stagedLabel.byteLength;
  if (maxBytes < labelBytes) {
    throw new ConsultError("INVALID_INPUT", "Diff byte limit is too small for section labels");
  }
  const available = maxBytes - labelBytes;
  let workingBytes = truncateUtf8(working.stdout, Math.ceil(available / 2));
  let stagedBytes = truncateUtf8(staged.stdout, Math.floor(available / 2));
  let remaining = available - workingBytes.byteLength - stagedBytes.byteLength;
  if (remaining > 0 && workingBytes.byteLength < working.stdout.byteLength) {
    workingBytes = truncateUtf8(working.stdout, workingBytes.byteLength + remaining);
    remaining = available - workingBytes.byteLength - stagedBytes.byteLength;
  }
  if (remaining > 0 && stagedBytes.byteLength < staged.stdout.byteLength) {
    stagedBytes = truncateUtf8(staged.stdout, stagedBytes.byteLength + remaining);
  }
  const combined = Buffer.concat([
    workingLabel,
    workingBytes,
    stagedLabel,
    stagedBytes,
  ]);
  const combinedText = combined.toString("utf8");
  if (Buffer.byteLength(combinedText, "utf8") !== combined.byteLength) {
    throw new ConsultError("SENSITIVE_CONTENT", "Working diff is not safe UTF-8 text");
  }
  const scan = scanSecrets(secretScanText(combinedText));
  if (scan.decision === "block" || (scan.decision === "confirm" && !allowSensitive)) {
    throw new ConsultError("SENSITIVE_CONTENT", "Working diff requires a safer selection", {
      decision: scan.decision,
      findingKinds: [...new Set(scan.findings.map((finding) => finding.kind))],
    });
  }
  const stored = await storeImmutableBlob(project, store, combined);
  return {
    metadata: {
      baseRef: "HEAD",
      headRef: "WORKTREE",
      sha256: stored.sha256,
      bytes: stored.bytes,
      truncated: working.truncated || staged.truncated
        || workingBytes.byteLength < working.stdout.byteLength
        || stagedBytes.byteLength < staged.stdout.byteLength,
    },
    truncated: working.truncated || staged.truncated
      || workingBytes.byteLength < working.stdout.byteLength
      || stagedBytes.byteLength < staged.stdout.byteLength,
  };
};

export const readCapturedDiff = async (
  project: ResolvedProject,
  store: RequestStore,
  input: { requestId: string; claimToken: string; offset?: number; limit?: number },
): Promise<BoundedChunk> => {
  const request = await store.authorize(input.requestId, input.claimToken);
  if (!request.diff) throw new ConsultError("NOT_FOUND", "No diff is approved for this request");
  const data = await readStoredAttachment(project, store, {
    id: request.diff.sha256,
    name: "working.diff",
    sha256: request.diff.sha256,
    bytes: request.diff.bytes,
    mimeType: "text/x-diff",
    sensitivity: { decision: "allowed", reasons: [] },
  });
  const limit = Math.min(input.limit ?? request.budget.maxReadBytes, request.budget.maxReadBytes);
  const chunk = utf8Chunk("working.diff", request.diff.sha256, data, input.offset ?? 0, limit);
  await store.consumeTextBudget(input.requestId, input.claimToken, Buffer.byteLength(chunk.text));
  return chunk;
};
