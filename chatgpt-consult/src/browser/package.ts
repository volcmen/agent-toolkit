import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { readStoredAttachment } from "../context/attachments";
import { buildBoundedConsultationText } from "../core/bundle";
import { ConsultError } from "../core/errors";
import type { AttachmentDescriptor, ConsultationRequest } from "../core/schema";
import type { RequestStore } from "../core/store";
import type { ResolvedProject } from "../security/project";
import { formatBrowserPrompt } from "./protocol";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROMPT_MAX_BYTES = 65_536;
const SAFE_REQUEST_ID = /^[a-f0-9]{32}$/;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const MIME_EXTENSIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  "image/png": new Set([".png"]), "image/jpeg": new Set([".jpg", ".jpeg"]), "image/gif": new Set([".gif"]), "image/webp": new Set([".webp"]), "application/pdf": new Set([".pdf"]), "text/plain": new Set([".txt", ".md", ".csv", ".log"]), "application/json": new Set([".json"]), "audio/mpeg": new Set([".mp3"]), "audio/mp4": new Set([".m4a", ".mp4"]), "audio/wav": new Set([".wav"]), "audio/x-wav": new Set([".wav"]), "audio/ogg": new Set([".ogg", ".oga"]), "audio/webm": new Set([".webm"]), "audio/aac": new Set([".aac"]), "audio/flac": new Set([".flac"]), "video/mp4": new Set([".mp4", ".m4v"]), "video/webm": new Set([".webm"]), "video/quicktime": new Set([".mov"]), "video/mpeg": new Set([".mpeg", ".mpg"]),
};
export interface BrowserRequestPackage { requestId: string; expectedRevision: number; prompt: string; uploadPaths: readonly string[]; directory: string; }
export interface BrowserPackageHooks { beforeFileCreate?(directory: string, index: number): Promise<void>; beforeQuarantine?(directory: string): Promise<void>; beforeRecursiveCleanup?(directory: string): Promise<void>; }
export interface BrowserPackageOptions { hooks?: BrowserPackageHooks; }
interface Identity { path: string; dev: number | bigint; ino: number | bigint; }
interface RequestTreeIdentity { state: Identity; browser: Identity; request: Identity; uploads: Identity; }
interface Capability { requestId: string; expectedRevision: number; directory: string; uploadPaths: readonly string[]; ancestry: RequestTreeIdentity; hooks: BrowserPackageHooks; }
const capabilities = new WeakMap<BrowserRequestPackage, Capability>();
const forbidden = (message: string): never => { throw new ConsultError("FORBIDDEN_PATH", message); };
const same = (a: Identity, b: Identity): boolean => a.path === b.path && a.dev === b.dev && a.ino === b.ino;
const sameNode = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const inspect = async (path: string): Promise<Identity> => { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) forbidden("Browser staging directory is not canonical"); return { path, dev: info.dev, ino: info.ino }; };
const assert = async (values: readonly Identity[]): Promise<void> => { for (const value of values) if (!same(value, await inspect(value.path))) forbidden("Browser staging ancestry changed"); };
const treeValues = (value: RequestTreeIdentity): readonly Identity[] => [value.state, value.browser, value.request, value.uploads];
const sameTree = (a: RequestTreeIdentity, b: RequestTreeIdentity): boolean => treeValues(a).every((identity, index) => same(identity, treeValues(b)[index]!));
const child = (root: string, path: string): void => { const value = relative(root, path).replaceAll("\\", "/"); if (value === ".." || value.startsWith("../") || isAbsolute(value)) forbidden("Browser staging leaves private state"); };
const ensure = async (root: string, components: readonly string[]): Promise<Identity[]> => { const values = [await inspect(root)]; let path = root; for (const component of components) { path = join(path, component); child(root, path); try { await inspect(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await assert(values); try { await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; } } await chmod(path, PRIVATE_DIRECTORY_MODE); const value = await inspect(path); await assert(values); values.push(value); } return values; };
const extension = (attachment: AttachmentDescriptor): string => { if (attachment.name.includes("\0") || basename(attachment.name) !== attachment.name || !SAFE_BASENAME.test(attachment.name)) forbidden("Browser attachment name is unsafe"); const value = extname(attachment.name).toLowerCase(); if (!MIME_EXTENSIONS[attachment.mimeType]?.has(value)) forbidden("Browser attachment extension is not permitted"); return value; };
const budgets = (request: ConsultationRequest): void => { let total = 0; for (const attachment of request.attachments) { if (attachment.bytes > request.budget.maxAttachmentBytes) throw new ConsultError("BUDGET_EXCEEDED", "Browser attachment file budget exceeded", { limit: request.budget.maxAttachmentBytes }); total += attachment.bytes; if (!Number.isSafeInteger(total) || total > request.budget.maxAttachmentTotalBytes) throw new ConsultError("BUDGET_EXCEEDED", "Browser attachment budget exceeded", { limit: request.budget.maxAttachmentTotalBytes }); } };
const removeRequest = async (state: string, requestId: string, expected: RequestTreeIdentity | undefined, hooks: BrowserPackageHooks): Promise<void> => {
  const browser = join(state, "browser"); const request = join(browser, requestId); let requestIdentity: Identity;
  try { requestIdentity = await inspect(request); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let observed: RequestTreeIdentity;
  try {
    observed = {
      state: await inspect(state),
      browser: await inspect(browser),
      request: requestIdentity,
      uploads: await inspect(join(request, "uploads")),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") forbidden("Browser staging request tree is incomplete");
    throw error;
  }
  if (expected !== undefined && !sameTree(expected, observed)) forbidden("Browser package identity changed");
  await hooks.beforeQuarantine?.(request); await assert(treeValues(observed));
  const quarantine = join(browser, `.cleanup-${requestId}-${randomUUID()}`); await rename(request, quarantine);
  const stable: RequestTreeIdentity = {
    state: observed.state,
    browser: observed.browser,
    request: await inspect(quarantine),
    uploads: await inspect(join(quarantine, "uploads")),
  };
  if (!sameNode(observed.request, stable.request) || !sameNode(observed.uploads, stable.uploads)) forbidden("Browser package identity changed");
  await assert(treeValues(stable)); await hooks.beforeRecursiveCleanup?.(quarantine); await assert(treeValues(stable));
  await rm(quarantine, { recursive: true, force: false }); await assert([stable.state, stable.browser]);
};
const stage = async (project: ResolvedProject, store: RequestStore, attachment: AttachmentDescriptor, index: number, directory: string, ancestry: readonly Identity[], hooks: BrowserPackageHooks): Promise<string> => {
  const suffix = extension(attachment); const path = join(directory, `${String(index + 1).padStart(3, "0")}-${basename(attachment.name, suffix)}${suffix}`); const data = await readStoredAttachment(project, store, attachment);
  await hooks.beforeFileCreate?.(directory, index); await assert(ancestry); const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await assert(ancestry); await chmod(path, PRIVATE_FILE_MODE); const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || info.size !== attachment.bytes || await realpath(dirname(path)) !== directory) throw new ConsultError("CORRUPT_STATE", "Browser staged attachment changed during preparation"); return path;
};
export const prepareBrowserPackage = async (project: ResolvedProject, store: RequestStore, request: ConsultationRequest, options: BrowserPackageOptions = {}): Promise<BrowserRequestPackage> => {
  if (!SAFE_REQUEST_ID.test(request.id) || !Number.isSafeInteger(request.revision) || request.revision < 0) throw new ConsultError("INVALID_INPUT", "Browser request identity is invalid"); budgets(request); await store.init(); const state = await realpath(project.stateDir); if (state !== project.stateDir) forbidden("Private state directory is not canonical"); const hooks = options.hooks ?? {};
  await removeRequest(state, request.id, undefined, hooks); const empty = formatBrowserPrompt(request.id, request.revision, "", request.profile); const limit = PROMPT_MAX_BYTES - Buffer.byteLength(empty, "utf8"); if (limit < 2) throw new ConsultError("INTERNAL", "Browser prompt envelope exceeds its byte ceiling"); const prompt = formatBrowserPrompt(request.id, request.revision, await buildBoundedConsultationText(project, store, request, limit), request.profile); if (Buffer.byteLength(prompt, "utf8") > PROMPT_MAX_BYTES) throw new ConsultError("INTERNAL", "Browser prompt exceeded its byte ceiling");
  const ancestryValues = await ensure(state, ["browser", request.id, "uploads"]); const directory = ancestryValues[3]!.path;
  const ancestry: RequestTreeIdentity = { state: ancestryValues[0]!, browser: ancestryValues[1]!, request: ancestryValues[2]!, uploads: ancestryValues[3]! };
  try { const uploadPaths: string[] = []; for (const [index, attachment] of request.attachments.entries()) uploadPaths.push(await stage(project, store, attachment, index, directory, treeValues(ancestry), hooks)); const value: BrowserRequestPackage = { requestId: request.id, expectedRevision: request.revision, prompt, uploadPaths, directory }; capabilities.set(value, { requestId: request.id, expectedRevision: request.revision, directory, uploadPaths: [...uploadPaths], ancestry, hooks }); return value; } catch (error) { try { await removeRequest(state, request.id, ancestry, hooks); } catch { /* Fail closed after an ancestor swap. */ } throw error; }
};
export const cleanupBrowserPackage = async (value: BrowserRequestPackage): Promise<void> => { const cap = capabilities.get(value); if (!cap || value.requestId !== cap.requestId || value.expectedRevision !== cap.expectedRevision || value.directory !== cap.directory || value.uploadPaths.length !== cap.uploadPaths.length || value.uploadPaths.some((path, index) => path !== cap.uploadPaths[index])) forbidden("Browser package was not prepared locally"); const capability = cap!; const state = dirname(dirname(dirname(value.directory))); if (!isAbsolute(state) || basename(state) !== ".chatgpt-consult" || basename(value.directory) !== "uploads" || basename(dirname(value.directory)) !== value.requestId || basename(dirname(dirname(value.directory))) !== "browser") forbidden("Browser package ancestry is invalid"); await removeRequest(state, value.requestId, capability.ancestry, capability.hooks); };
