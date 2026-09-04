import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, extname } from "node:path";
import { ConsultError } from "../core/errors";
import { HARD_BUDGET } from "../core/schema";
import { classifyPath } from "./policy";

export interface ResolvedProject {
  readonly root: string;
  readonly stateDir: string;
  readonly projectId: string;
}

export interface ResolvedPath {
  absolutePath: string;
  relative: string;
  bytes: number;
  sha256: string;
  mimeType: string;
}

export interface ResolvedProjectPath {
  absolutePath: string;
  relative: string;
}

export interface BoundedProjectFile {
  absolutePath: string;
  relative: string;
  bytes: number;
  mimeType: string;
}

export interface StableProjectFile extends ResolvedPath {
  content: Buffer;
}

interface ProjectFileIdentity extends BoundedProjectFile {
  dev: number;
  ino: number;
  mtimeMs: number;
}

const forbidden = (detail?: string): never => {
  throw new ConsultError(
    "FORBIDDEN_PATH",
    detail === undefined
      ? "Context path is outside the permitted project boundary"
      : `Context path is not permitted: ${detail}`,
  );
};

const mimeTypes: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/javascript",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
};

export const mimeTypeForPath = (path: string): string =>
  mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream";

const hasWindowsAbsolutePrefix = (path: string): boolean => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");

export const resolveProject = async (root: string): Promise<ResolvedProject> => {
  const resolvedRoot = await realpath(root);
  const stat = await lstat(resolvedRoot);
  if (!stat.isDirectory()) {
    throw new ConsultError("INVALID_INPUT", "Project root is not a directory");
  }

  return {
    root: resolvedRoot,
    stateDir: join(resolvedRoot, ".chatgpt-consult"),
    projectId: createHash("sha256")
      .update(`${resolvedRoot}\0${basename(resolvedRoot)}`)
      .digest("hex")
      .slice(0, 24),
  };
};

export const resolveReadablePath = async (
  project: ResolvedProject,
  relativePath: string,
): Promise<ResolvedPath> => {
  const snapshot = await readStableProjectFile(
    project,
    relativePath,
    HARD_BUDGET.maxServedTextBytes,
  );
  const { content: _content, ...resolved } = snapshot;
  return resolved;
};

const inspectProjectFile = async (
  project: ResolvedProject,
  relativePath: string,
  maximumBytes: number,
): Promise<ProjectFileIdentity> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new ConsultError("INVALID_INPUT", "Project file byte limit must be non-negative");
  }
  const resolved = await resolveProjectPath(project, relativePath);
  const requested = normalize(relativePath).replaceAll("\\", "/");
  const requestedInfo = await lstat(join(project.root, requested));
  if (requestedInfo.isSymbolicLink()) {
    throw new ConsultError("FORBIDDEN_PATH", "Context path cannot be a symbolic link");
  }
  const info = await lstat(resolved.absolutePath);
  if (!requestedInfo.isFile() || !info.isFile() || info.isSymbolicLink()) {
    throw new ConsultError("INVALID_INPUT", "Context path is not a regular file");
  }
  if (
    requestedInfo.dev !== info.dev
    || requestedInfo.ino !== info.ino
  ) {
    throw new ConsultError("CONFLICT", "Context path changed during validation");
  }
  if (info.size > maximumBytes) {
    throw new ConsultError("BUDGET_EXCEEDED", "Context file exceeds its byte ceiling", {
      limit: maximumBytes,
    });
  }
  return {
    ...resolved,
    bytes: info.size,
    mimeType: mimeTypeForPath(resolved.absolutePath),
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
  };
};

export const inspectBoundedProjectFile = async (
  project: ResolvedProject,
  relativePath: string,
  maximumBytes: number,
): Promise<BoundedProjectFile> => inspectProjectFile(project, relativePath, maximumBytes);

export const readStableProjectFile = async (
  project: ResolvedProject,
  relativePath: string,
  maximumBytes: number,
  afterOpen?: (absolutePath: string) => Promise<void>,
): Promise<StableProjectFile> => {
  const inspected = await inspectProjectFile(project, relativePath, maximumBytes);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(inspected.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ConsultError("FORBIDDEN_PATH", "Context path cannot be a symbolic link");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== inspected.dev
      || before.ino !== inspected.ino
      || before.size !== inspected.bytes
      || before.size > maximumBytes
    ) {
      throw new ConsultError("CONFLICT", "Context path changed while it was opened");
    }
    if (afterOpen) await afterOpen(inspected.absolutePath);
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new ConsultError("CONFLICT", "Context file changed while it was read");
      }
      offset += bytesRead;
    }
    const growthProbe = Buffer.alloc(1);
    if ((await handle.read(growthProbe, 0, 1, before.size)).bytesRead !== 0) {
      throw new ConsultError("CONFLICT", "Context file grew while it was read");
    }
    const after = await handle.stat();
    if (
      after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || before.mtimeMs !== inspected.mtimeMs
    ) {
      throw new ConsultError("CONFLICT", "Context file changed while it was read");
    }
    return {
      absolutePath: inspected.absolutePath,
      relative: inspected.relative,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      mimeType: inspected.mimeType,
      content,
    };
  } finally {
    await handle.close();
  }
};

export const resolveProjectPath = async (
  project: ResolvedProject,
  relativePath: string,
): Promise<ResolvedProjectPath> => {
  if (relativePath.includes("\0") || isAbsolute(relativePath) || hasWindowsAbsolutePrefix(relativePath)) {
    forbidden();
  }

  const normalized = normalize(relativePath).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) forbidden();

  const pathDecision = classifyPath(normalized);
  if (pathDecision.kind === "deny") forbidden(pathDecision.reason);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(join(project.root, normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConsultError("NOT_FOUND", "Context path does not exist");
    }
    throw error;
  }

  const canonicalRelative = relative(project.root, canonicalPath).replaceAll("\\", "/");
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith("../") ||
    isAbsolute(canonicalRelative)
  ) {
    forbidden();
  }
  const canonicalDecision = classifyPath(canonicalRelative);
  if (canonicalDecision.kind === "deny") forbidden(canonicalDecision.reason);

  return {
    absolutePath: canonicalPath,
    relative: canonicalRelative,
  };
};
