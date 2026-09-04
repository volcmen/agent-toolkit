import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { ConsultError } from "../core/errors";
import { HARD_BUDGET, type AttachmentDescriptor, type ContextBudget } from "../core/schema";
import type { RequestStore } from "../core/store";
import { resolveProjectPath, type ResolvedProject } from "../security/project";
import { scanSecrets } from "../security/secrets";

export type MimeDetector = (absolutePath: string) => Promise<string>;

const SAFE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/json",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
]);

const SAFE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  "image/png": new Set([".png"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/gif": new Set([".gif"]),
  "image/webp": new Set([".webp"]),
  "application/pdf": new Set([".pdf"]),
  "text/plain": new Set([".txt", ".md", ".csv", ".log"]),
  "application/json": new Set([".json"]),
  "audio/mpeg": new Set([".mp3"]),
  "audio/mp4": new Set([".m4a", ".mp4"]),
  "audio/wav": new Set([".wav"]),
  "audio/x-wav": new Set([".wav"]),
  "audio/ogg": new Set([".ogg", ".oga"]),
  "audio/webm": new Set([".webm"]),
  "audio/aac": new Set([".aac"]),
  "audio/flac": new Set([".flac"]),
  "video/mp4": new Set([".mp4", ".m4v"]),
  "video/webm": new Set([".webm"]),
  "video/quicktime": new Set([".mov"]),
  "video/mpeg": new Set([".mpeg", ".mpg"]),
};

const ACTIVE_OR_EXECUTABLE_EXTENSIONS = new Set([
  ".html", ".htm", ".svg", ".js", ".mjs", ".cjs", ".exe", ".dll", ".so",
  ".dylib", ".sh", ".bat", ".cmd", ".ps1", ".zip", ".tar", ".gz", ".tgz",
  ".bz2", ".xz", ".7z", ".rar", ".jar",
]);

const invalidAttachment = (): never => {
  throw new ConsultError("INVALID_INPUT", "Attachment type is not permitted");
};

const readLimitedStream = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  stop: () => void,
): Promise<{ data: Buffer; overflow: boolean }> => {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { data: Buffer.concat(chunks), overflow: false };
    const chunk = Buffer.from(value);
    if (total + chunk.byteLength > limit) {
      const remaining = limit - total;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      stop();
      return { data: Buffer.concat(chunks), overflow: true };
    }
    total += chunk.byteLength;
    chunks.push(chunk);
  }
};

const runMimeCommand = async (executable: string, absolutePath: string): Promise<string> => {
  const process = Bun.spawn([executable, "-b", "--mime-type", "--", absolutePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readLimitedStream(process.stdout, 1_024, () => process.kill()),
    readLimitedStream(process.stderr, 4_096, () => process.kill()),
    process.exited,
  ]);
  if (stdout.overflow || stderr.overflow || exitCode !== 0) {
    throw new ConsultError("UNAVAILABLE", "Attachment MIME detection failed");
  }
  const mimeType = stdout.data.toString("utf8").trim();
  if (!mimeType) throw new ConsultError("UNAVAILABLE", "Attachment MIME detection failed");
  return mimeType;
};

export const detectMimeWithFile: MimeDetector = async (absolutePath) => {
  const executable = Bun.which("file");
  if (!executable) {
    throw new ConsultError("UNAVAILABLE", "The file utility is required for attachments");
  }
  return runMimeCommand(executable, absolutePath);
};

const canonicalAttachmentDirectory = async (
  project: ResolvedProject,
  store: RequestStore,
): Promise<string> => {
  await store.init();
  const stateDir = await realpath(project.stateDir);
  if (stateDir !== project.stateDir) {
    throw new ConsultError("FORBIDDEN_PATH", "Private state directory is not canonical");
  }
  const directory = await realpath(join(stateDir, "attachments"));
  if (relative(stateDir, directory) !== "attachments") {
    throw new ConsultError("FORBIDDEN_PATH", "Attachment storage is outside private state");
  }
  return directory;
};

const inspectBlob = async (
  path: string,
  bytes: number,
  sha256: string,
  collect: boolean,
): Promise<Buffer | null> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ConsultError("CORRUPT_STATE", "Stored attachment cannot be a symbolic link");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== bytes) {
      throw new ConsultError("CORRUPT_STATE", "Stored attachment size does not match its digest");
    }
    const content = collect ? Buffer.alloc(bytes) : null;
    const chunk = collect ? content! : Buffer.alloc(64 * 1_024);
    const hash = createHash("sha256");
    let total = 0;
    while (true) {
      const maximum = collect ? bytes - total : chunk.byteLength;
      if (maximum === 0) {
        const probe = Buffer.alloc(1);
        if ((await handle.read(probe, 0, 1, null)).bytesRead !== 0) {
          throw new ConsultError("CORRUPT_STATE", "Stored attachment grew during validation");
        }
        break;
      }
      const { bytesRead } = await handle.read(chunk, collect ? total : 0, maximum, null);
      if (bytesRead === 0) break;
      const data = collect ? chunk.subarray(total, total + bytesRead) : chunk.subarray(0, bytesRead);
      total += bytesRead;
      if (total > bytes) {
        throw new ConsultError("CORRUPT_STATE", "Stored attachment grew during validation");
      }
      hash.update(data);
    }
    const after = await handle.stat();
    if (
      total !== bytes
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || hash.digest("hex") !== sha256
    ) {
      throw new ConsultError("CORRUPT_STATE", "Stored attachment failed integrity validation");
    }
    return content;
  } finally {
    await handle.close();
  }
};

const verifyBlob = async (path: string, bytes: number, sha256: string): Promise<void> => {
  await inspectBlob(path, bytes, sha256, false);
};

export const storeImmutableBlob = async (
  project: ResolvedProject,
  store: RequestStore,
  content: Uint8Array,
): Promise<{ sha256: string; bytes: number; path: string }> => {
  const directory = await canonicalAttachmentDirectory(project, store);
  const bytes = Buffer.from(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const destination = join(directory, sha256);
  const temporary = join(directory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await verifyBlob(destination, bytes.byteLength, sha256);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rename(temporary, destination);
      renamed = true;
    }
    await chmod(destination, 0o600);
  } finally {
    try {
      await handle.close();
    } catch {
      // The handle may already be closed after a successful fsync.
    }
    if (!renamed) await rm(temporary, { force: true });
  }
  return { sha256, bytes: bytes.byteLength, path: destination };
};

interface AttachmentSnapshot {
  path: string;
  relative: string;
  bytes: number;
  sha256: string;
}

const snapshotAttachment = async (
  project: ResolvedProject,
  store: RequestStore,
  relativePath: string,
  maximumBytes: number,
  afterOpen?: (absolutePath: string) => Promise<void>,
): Promise<AttachmentSnapshot> => {
  const source = await resolveProjectPath(project, relativePath);
  const pathInfo = await lstat(source.absolutePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new ConsultError("INVALID_INPUT", "Attachment source is not a regular file");
  }
  if (pathInfo.size <= 0) {
    throw new ConsultError("INVALID_INPUT", "Attachment source cannot be empty");
  }
  if (pathInfo.size > maximumBytes) {
    throw new ConsultError("BUDGET_EXCEEDED", "Attachment file budget exceeded", {
      limit: maximumBytes,
    });
  }
  const directory = await canonicalAttachmentDirectory(project, store);
  const temporary = join(directory, `.attachment.${process.pid}.${randomUUID()}.tmp`);
  let sourceHandle: Awaited<ReturnType<typeof open>>;
  try {
    sourceHandle = await open(
      source.absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ConsultError("FORBIDDEN_PATH", "Attachment source cannot be a symbolic link");
    }
    throw error;
  }
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let bytes = 0;
  let completed = false;
  try {
    temporaryHandle = await open(temporary, "wx", 0o600);
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino) {
      throw new ConsultError("CONFLICT", "Attachment source changed while it was opened");
    }
    if (before.size > maximumBytes) {
      throw new ConsultError("BUDGET_EXCEEDED", "Attachment file budget exceeded", {
        limit: maximumBytes,
      });
    }
    if (afterOpen) await afterOpen(source.absolutePath);
    const chunk = Buffer.alloc(64 * 1_024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      if (bytes + bytesRead > maximumBytes) {
        throw new ConsultError("BUDGET_EXCEEDED", "Attachment file budget exceeded", {
          limit: maximumBytes,
        });
      }
      const data = chunk.subarray(0, bytesRead);
      bytes += bytesRead;
      hash.update(data);
      await temporaryHandle.write(data);
    }
    const after = await sourceHandle.stat();
    if (
      bytes !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) {
      throw new ConsultError("CONFLICT", "Attachment source changed while it was copied");
    }
    await temporaryHandle.sync();
    const sha256 = hash.digest("hex");
    completed = true;
    return { path: temporary, relative: source.relative, sha256, bytes };
  } finally {
    await Promise.allSettled([
      sourceHandle.close(),
      ...(temporaryHandle ? [temporaryHandle.close()] : []),
    ]);
    if (!completed) await rm(temporary, { force: true });
  }
};

const publishSnapshot = async (
  directory: string,
  snapshot: AttachmentSnapshot,
): Promise<void> => {
  const destination = join(directory, snapshot.sha256);
  try {
    try {
      await verifyBlob(destination, snapshot.bytes, snapshot.sha256);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rename(snapshot.path, destination);
    }
    await chmod(destination, 0o600);
  } finally {
    await rm(snapshot.path, { force: true });
  }
};

export const storeAttachmentFiles = async (
  project: ResolvedProject,
  store: RequestStore,
  input: { paths: string[]; budget: ContextBudget; allowSensitive?: boolean },
  detectMime: MimeDetector,
  afterOpen?: (absolutePath: string) => Promise<void>,
): Promise<AttachmentDescriptor[]> => {
  const descriptors: AttachmentDescriptor[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const directory = await canonicalAttachmentDirectory(project, store);

  for (const path of input.paths) {
    const snapshot = await snapshotAttachment(
      project,
      store,
      path,
      input.budget.maxAttachmentBytes,
      afterOpen,
    );
    const extension = extname(snapshot.relative).toLowerCase();
    if (ACTIVE_OR_EXECUTABLE_EXTENSIONS.has(extension)) {
      await rm(snapshot.path, { force: true });
      invalidAttachment();
    }
    let mimeType: string;
    try {
      mimeType = (await detectMime(snapshot.path)).toLowerCase().split(";", 1)[0]!.trim();
    } catch (error) {
      await rm(snapshot.path, { force: true });
      throw error;
    }
    if (!SAFE_MIME_TYPES.has(mimeType) || !SAFE_EXTENSIONS[mimeType]?.has(extension)) {
      await rm(snapshot.path, { force: true });
      invalidAttachment();
    }

    let sensitivity: AttachmentDescriptor["sensitivity"] = { decision: "allowed", reasons: [] };
    if (mimeType === "text/plain" || mimeType === "application/json") {
      const content = await readFile(snapshot.path);
      if (content.byteLength !== snapshot.bytes) {
        await rm(snapshot.path, { force: true });
        throw new ConsultError("CORRUPT_STATE", "Attachment snapshot changed before validation");
      }
      const text = content.toString("utf8");
      if (Buffer.byteLength(text, "utf8") !== content.byteLength) {
        await rm(snapshot.path, { force: true });
        invalidAttachment();
      }
      const scan = scanSecrets(text);
      const reasons = [...new Set(scan.findings.map((finding) => finding.kind))].sort();
      if (scan.decision === "block" || (scan.decision === "confirm" && !input.allowSensitive)) {
        await rm(snapshot.path, { force: true });
        throw new ConsultError("SENSITIVE_CONTENT", "Attachment requires a safer selection", {
          decision: scan.decision,
          findingKinds: reasons,
        });
      }
      sensitivity = { decision: "allowed", reasons };
    }

    if (seen.has(snapshot.sha256)) {
      await rm(snapshot.path, { force: true });
      continue;
    }
    const nextTotal = totalBytes + snapshot.bytes;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > input.budget.maxAttachmentTotalBytes) {
      await rm(snapshot.path, { force: true });
      throw new ConsultError("BUDGET_EXCEEDED", "Total attachment budget exceeded", {
        limit: input.budget.maxAttachmentTotalBytes,
      });
    }

    await verifyBlob(snapshot.path, snapshot.bytes, snapshot.sha256);
    await publishSnapshot(directory, snapshot);
    seen.add(snapshot.sha256);
    totalBytes = nextTotal;
    descriptors.push({
      id: snapshot.sha256,
      name: basename(snapshot.relative),
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      mimeType,
      sensitivity,
    });
  }
  return descriptors;
};

export const readStoredAttachment = async (
  project: ResolvedProject,
  store: RequestStore,
  descriptor: AttachmentDescriptor,
): Promise<Buffer> => {
  if (descriptor.id !== descriptor.sha256 || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
    throw new ConsultError("CORRUPT_STATE", "Attachment descriptor is invalid");
  }
  if (descriptor.bytes > HARD_BUDGET.maxAttachmentBytes) {
    throw new ConsultError("BUDGET_EXCEEDED", "Attachment exceeds the hard media ceiling", {
      limit: HARD_BUDGET.maxAttachmentBytes,
    });
  }
  const directory = await canonicalAttachmentDirectory(project, store);
  const path = join(directory, descriptor.sha256);
  try {
    return (await inspectBlob(path, descriptor.bytes, descriptor.sha256, true))!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConsultError("NOT_FOUND", "Attachment content was not found");
    }
    throw error;
  }
};
