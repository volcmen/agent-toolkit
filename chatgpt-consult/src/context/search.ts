import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { ConsultError } from "../core/errors";
import { HARD_BUDGET, type ConsultationRequest, type ContextPath } from "../core/schema";
import type { RequestStore } from "../core/store";
import { resolveProjectPath, type ResolvedProject } from "../security/project";

export interface BoundedChunk {
  path: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  text: string;
  sha256: string;
}

export interface SearchHit {
  path: string;
  line: number;
  snippet: string;
}

const isContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

export const utf8Chunk = (
  path: string,
  sha256: string,
  content: Uint8Array,
  offset: number,
  limit: number,
): BoundedChunk => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.byteLength) {
    throw new ConsultError("INVALID_INPUT", "Read offset is outside the file");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ConsultError("INVALID_INPUT", "Read limit must be positive");
  }
  let start = offset;
  while (start < content.byteLength && isContinuationByte(content[start])) start += 1;
  let end = Math.min(content.byteLength, start + limit);
  while (end > start && end < content.byteLength && isContinuationByte(content[end])) end -= 1;
  if (end === start && start < content.byteLength) {
    throw new ConsultError("INVALID_INPUT", "Read limit is too small for the next UTF-8 character");
  }
  const bytes = content.subarray(start, end);
  const text = Buffer.from(bytes).toString("utf8");
  if (Buffer.from(text, "utf8").byteLength !== bytes.byteLength) {
    throw new ConsultError("INVALID_INPUT", "Approved context is not valid UTF-8 text");
  }
  return {
    path,
    offset: start,
    nextOffset: end,
    eof: end >= content.byteLength,
    text,
    sha256,
  };
};

export const approvedEntry = (
  request: ConsultationRequest,
  path: string,
): ContextPath => {
  const entry = request.contextManifest.paths.find((candidate) => candidate.path === path);
  if (!entry) {
    throw new ConsultError("FORBIDDEN_PATH", "Context path is not approved for this request");
  }
  return entry;
};

export const readApprovedBytes = async (
  project: ResolvedProject,
  entry: ContextPath,
): Promise<Buffer> => {
  if (entry.bytes > HARD_BUDGET.maxServedTextBytes) {
    throw new ConsultError("BUDGET_EXCEEDED", "Approved context exceeds the hard text ceiling", {
      limit: HARD_BUDGET.maxServedTextBytes,
    });
  }
  const resolved = await resolveProjectPath(project, entry.path);
  const pathInfo = await lstat(resolved.absolutePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size !== entry.bytes) {
    throw new ConsultError("CONFLICT", "Approved context changed after selection");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ConsultError("FORBIDDEN_PATH", "Approved context cannot be a symbolic link");
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== pathInfo.dev
      || before.ino !== pathInfo.ino
      || before.size !== entry.bytes
    ) {
      throw new ConsultError("CONFLICT", "Approved context changed after selection");
    }
    const content = Buffer.alloc(entry.bytes);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) {
        throw new ConsultError("CONFLICT", "Approved context changed after selection");
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    const digest = createHash("sha256").update(content).digest("hex");
    if (
      after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || digest !== entry.sha256
    ) {
      throw new ConsultError("CONFLICT", "Approved context changed after selection");
    }
    return content;
  } finally {
    await handle.close();
  }
};

const isTextEntry = (entry: ContextPath): boolean => {
  const mimeType = entry.mimeType ?? "";
  return mimeType.startsWith("text/") || [
    "application/json",
    "application/xml",
    "application/yaml",
  ].includes(mimeType);
};

export const searchApprovedText = async (
  project: ResolvedProject,
  store: RequestStore,
  input: {
    requestId: string;
    claimToken: string;
    query: string;
    paths?: string[];
  },
): Promise<SearchHit[]> => {
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 512) {
    throw new ConsultError("INVALID_INPUT", "Search query must contain 1 to 512 characters");
  }
  let request = await store.authorize(input.requestId, input.claimToken);
  const requested = input.paths ?? request.contextManifest.paths.map((entry) => entry.path);
  const entries = requested.map((path) => approvedEntry(request, path)).filter(isTextEntry);
  const allHits: SearchHit[] = [];
  for (const entry of entries) {
    const content = await readApprovedBytes(project, entry);
    const text = content.toString("utf8");
    if (Buffer.from(text, "utf8").byteLength !== content.byteLength) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.includes(input.query)) continue;
      allHits.push({ path: entry.path, line: index + 1, snippet: line.slice(0, 240) });
      if (allHits.length >= request.budget.maxSearchHits) break;
    }
    if (allHits.length >= request.budget.maxSearchHits) break;
  }

  while (true) {
    const remainingHits = request.budget.maxSearchHits - request.servedSearchHits;
    const remainingTextBytes = request.budget.maxServedTextBytes - request.servedTextBytes;
    if (remainingHits <= 0 || remainingTextBytes <= 0 || allHits.length === 0) return [];
    const selected: SearchHit[] = [];
    let textBytes = 0;
    for (const hit of allHits) {
      if (selected.length >= remainingHits) break;
      const snippetBytes = Buffer.byteLength(hit.snippet, "utf8");
      if (snippetBytes > remainingTextBytes - textBytes) continue;
      selected.push(hit);
      textBytes += snippetBytes;
    }
    if (selected.length === 0) return [];
    try {
      await store.consumeRetrievalBudget(
        input.requestId,
        input.claimToken,
        textBytes,
        selected.length,
      );
      return selected;
    } catch (error) {
      if (!(error instanceof ConsultError) || error.code !== "BUDGET_EXCEEDED") throw error;
      request = await store.authorize(input.requestId, input.claimToken);
    }
  }
};
