import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  DEVTOOLS_ACTIVE_PORT_MAX_BYTES,
  VERSION_RESPONSE_MAX_BYTES,
  classifyChrome,
  parseDevToolsActivePort,
  parseVersionResponse,
  resolveChromePaths,
  type ChromeObservation,
  type ChromePaths,
  type ActivePortObservation,
  type ListenerObservation,
  type OwnershipRecord,
  type PathObservation,
  type ProcessBirthIdentity,
  type ProcessObservation,
  type RecordObservation,
  type VersionObservation,
  type BrowserVisibility,
  type ManagedBrowserVisibility,
} from "./cdp";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OWNERSHIP_MAX_BYTES = 4_096;
const READINESS_TIMEOUT_MS = 10_000;
const MAX_READINESS_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;
const MAX_POLL_INTERVAL_MS = 1_000;
const CLOSE_TIMEOUT_MS = 2_000;
const LOCK_POLL_MS = 25;
const SUBPROCESS_TIMEOUT_MS = 1_000;
const DIAGNOSTIC_CLEANUP_TIMEOUT_MS = 1_000;
const SUBPROCESS_MAX_BYTES = 64 * 1_024;
const NONCE = /^[a-f0-9]{32,128}$/;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const ownershipRecordEqual = (a: OwnershipRecord, b: OwnershipRecord): boolean =>
  a.schemaVersion === b.schemaVersion
  && a.pid === b.pid
  && a.executable === b.executable
  && a.profileDir === b.profileDir
  && a.launchNonce === b.launchNonce
  && a.startedAt === b.startedAt
  && a.port === b.port
  && a.webSocketUrl === b.webSocketUrl
  && a.visibility === b.visibility
  && a.processBirth.kind === b.processBirth.kind
  && a.processBirth.value === b.processBirth.value;

export const canonicalUserDirValue = (arg: string): string | null => {
  const prefix = "--user-data-dir=";
  if (!arg.startsWith(prefix)) return null;
  const value = arg.slice(prefix.length);
  if (value.length === 0 || value.includes("\0") || !value.startsWith("/")) return null;
  return value;
};

const LEASE_WRITE_BUDGET_MS = 500;
const OBSERVATION_BUDGET_MS = MAX_READINESS_TIMEOUT_MS;
const LAUNCH_REPAIR_BUDGET_MS = 1_000;
const STALE_STATE_REMOVAL_BUDGET_MS = 500;
const FIND_CHROME_BUDGET_MS = 1_000;
const SPAWN_CHROME_BUDGET_MS = 1_000;
const READINESS_BUDGET_MS = MAX_READINESS_TIMEOUT_MS;
const CLOSE_SIGNAL_BUDGET_MS = 500;
const CHILD_CLEANUP_WAIT_BUDGET_MS = CLOSE_TIMEOUT_MS;
const NONCE_CLEANUP_BUDGET_MS = 500;
const CLOSE_STATE_REMOVAL_BUDGET_MS = 500;
const LOCK_MARGIN_MS = 1_000;

// Budget proof — maximum holder critical section:
//
// Launch/failure path:
//   lease write              500
//   initial observation    10_000
//   optional repair         1_000
//   stale-state removal      500
//   Chrome discovery        1_000
//   Chrome spawn            1_000
//   readiness              10_000
//   child-terminate signal   500  (CLOSE_SIGNAL_BUDGET_MS)
//   child cleanup wait      2_000
//   nonce cleanup            500
//   subtotal               27_000
//
// Close path:
//   lease write              500
//   first observation      10_000
//   second observation     10_000
//   close-signal             500  (CLOSE_SIGNAL_BUDGET_MS)
//   exit wait               2_000
//   close-state removal      500
//   subtotal               23_500
//
// Atomic headed switch (one lease and one uninterrupted lock hold):
//   lease write              500
//   selected-session proof 10_000
//   close without lease    23_000
//   launch without lease   26_500
//   bounded margin          1_000
//   subtotal               61_000
//
// Largest path:            61_000  (atomic headed switch)
// LOCK_ACQUISITION_TIMEOUT:62_000  (strictly exceeds)
//
// A timed-out/stuck mutation retains the lock fail-closed until its exact
// promise settles; this is an abnormal holder. Waiters still terminate with
// LOCK_TIMEOUT and never overlap its mutation. Exact-child exit failure
// changes retention to permanent: no later settlement may release.

const CLOSE_WITHOUT_LEASE_BUDGET_MS = (2 * OBSERVATION_BUDGET_MS)
  + CLOSE_SIGNAL_BUDGET_MS
  + CHILD_CLEANUP_WAIT_BUDGET_MS
  + CLOSE_STATE_REMOVAL_BUDGET_MS;

const LAUNCH_WITHOUT_LEASE_BUDGET_MS = OBSERVATION_BUDGET_MS
  + LAUNCH_REPAIR_BUDGET_MS
  + STALE_STATE_REMOVAL_BUDGET_MS
  + FIND_CHROME_BUDGET_MS
  + SPAWN_CHROME_BUDGET_MS
  + READINESS_BUDGET_MS
  + CLOSE_SIGNAL_BUDGET_MS
  + CHILD_CLEANUP_WAIT_BUDGET_MS
  + NONCE_CLEANUP_BUDGET_MS;

export const MAXIMUM_HOLDER_SUM_MS = LEASE_WRITE_BUDGET_MS
  + OBSERVATION_BUDGET_MS
  + CLOSE_WITHOUT_LEASE_BUDGET_MS
  + LAUNCH_WITHOUT_LEASE_BUDGET_MS
  + LOCK_MARGIN_MS;

export const LOCK_ACQUISITION_TIMEOUT_MS = MAXIMUM_HOLDER_SUM_MS + 1_000;

export interface ChromeSession {
  pid: number;
  port: number;
  webSocketUrl: string;
  profileDir: string | null;
  ownership: "owned" | "external";
  visibility: BrowserVisibility;
  reused: boolean;
}

export type ChromeControllerErrorCode =
  | "UNSAFE_CONFIG"
  | "PROFILE_CONFLICT"
  | "FOREIGN_LISTENER"
  | "UNSAFE_ENDPOINT"
  | "AMBIGUOUS_OWNERSHIP"
  | "CHROME_NOT_FOUND"
  | "LOCK_TIMEOUT"
  | "READINESS_TIMEOUT"
  | "CHILD_EXIT"
  | "CHILD_EXIT_TIMEOUT"
  | "CLOSE_TIMEOUT"
  | "IO_FAILURE";

const errorMessages: Record<ChromeControllerErrorCode, string> = {
  UNSAFE_CONFIG: "Chrome configuration is unsafe",
  PROFILE_CONFLICT: "The dedicated Chrome profile is already in conflict",
  FOREIGN_LISTENER: "The Chrome debugging endpoint has a foreign listener",
  UNSAFE_ENDPOINT: "The Chrome debugging endpoint is unsafe",
  AMBIGUOUS_OWNERSHIP: "Chrome process ownership cannot be proven",
  CHROME_NOT_FOUND: "A safe Chrome executable was not found",
  LOCK_TIMEOUT: "The Chrome launch lock is busy",
  READINESS_TIMEOUT: "Chrome debugging did not become ready in time",
  CHILD_EXIT: "Chrome exited before debugging became ready",
  CHILD_EXIT_TIMEOUT: "Chrome did not exit after bounded launch cleanup",
  CLOSE_TIMEOUT: "Owned Chrome did not exit after SIGTERM",
  IO_FAILURE: "Chrome lifecycle state could not be handled safely",
};

export class ChromeControllerError extends Error {
  constructor(public readonly code: ChromeControllerErrorCode) {
    super(errorMessages[code]);
    this.name = "ChromeControllerError";
  }
}

export interface SpawnedChrome {
  pid: number;
  hasExited(): boolean;
  terminate(signal: "SIGTERM"): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
  unref(): void;
}

export interface LaunchLock {
  release(): Promise<void>;
  retain(): Promise<void>;
}

export interface ChromeAdapter {
  preparePaths(): Promise<ChromePaths>;
  observePaths(paths: ChromePaths, budgetMs: number): Promise<Pick<ChromeObservation, "config" | "profile">>;
  readOwnership(paths: ChromePaths, budgetMs: number): Promise<RecordObservation>;
  readActivePort(paths: ChromePaths, budgetMs: number): Promise<ActivePortObservation | null>;
  inspectProcess(pid: number, budgetMs: number): Promise<ProcessObservation | null>;
  findProfileProcess(profileDir: string, excludingPid: number | undefined, budgetMs: number): Promise<ProcessObservation | null>;
  inspectListener(port: number, budgetMs: number): Promise<ListenerObservation | null>;
  fetchVersion(port: number, activePath: string, budgetMs: number): Promise<VersionObservation>;
  repairProfile(path: string, budgetMs: number): Promise<void>;
  acquireLock(paths: ChromePaths): Promise<LaunchLock>;
  removeStaleState(paths: ChromePaths, launchNonce: string | undefined, budgetMs: number): Promise<void>;
  findChrome(budgetMs: number): Promise<string>;
  spawnChrome(argv: string[], budgetMs: number): Promise<SpawnedChrome>;
  writeOwnership(paths: ChromePaths, record: OwnershipRecord, budgetMs: number): Promise<void>;
  signal(pid: number, signal: "SIGTERM", budgetMs: number): Promise<void>;
  isLive(pid: number, budgetMs: number): Promise<boolean>;
  monotonicNow(): number;
  wallNow(): number;
  sleep(milliseconds: number): Promise<void>;
  randomNonce(): string;
}

export interface ChromeControllerOptions {
  adapter?: ChromeAdapter;
  environment?: Readonly<Record<string, string | undefined>>;
  executablePath?: string;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

export const validateChromeTimingOptions = (
  options: Pick<ChromeControllerOptions, "readinessTimeoutMs" | "pollIntervalMs">,
): { readinessTimeoutMs: number; pollIntervalMs: number } => {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0
    || readinessTimeoutMs > MAX_READINESS_TIMEOUT_MS) {
    throw new RangeError("Chrome readiness timeout is invalid");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0
    || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new RangeError("Chrome poll interval is invalid");
  }
  return { readinessTimeoutMs, pollIntervalMs };
};

export const runBeforeChromeDeadline = async <T>(
  deadline: number,
  monotonicNow: () => number,
  operation: (budgetMs: number) => Promise<T>,
): Promise<T> => {
  const checkDeadline = (): number => {
    const value = deadline - monotonicNow();
    if (!Number.isFinite(value) || value <= 0) {
      throw new ChromeControllerError("READINESS_TIMEOUT");
    }
    return value;
  };
  try {
    const value = await operation(checkDeadline());
    checkDeadline();
    return value;
  } catch (error) {
    const value = deadline - monotonicNow();
    if (!Number.isFinite(value) || value <= 0) {
      throw new ChromeControllerError("READINESS_TIMEOUT");
    }
    throw error;
  }
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForExit = async (exited: Promise<number>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const errno = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException).code === code;

const ownerMatches = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

const observePath = async (path: string): Promise<PathObservation> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink" };
    if (info.isDirectory()) {
      return { kind: "directory", owned: ownerMatches(info.uid), mode: info.mode & 0o777 };
    }
    if (info.isFile()) return { kind: "file" };
    return { kind: "other" };
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
};

export interface SecureChromePathHooks {
  beforeCreate?(openParentPath: string, component: string): Promise<void>;
}

const directoryApi = dlopen(
  process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  {
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  },
).symbols;

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const retainedLockHandles = new Set<FileHandle>();

const ensureAnchoredDirectory = async (
  target: string,
  refusalCode: "UNSAFE_CONFIG" | "PROFILE_CONFLICT",
  requirePrivateExisting: boolean,
  hooks: SecureChromePathHooks,
): Promise<void> => {
  const missing: string[] = [];
  let ancestor = target;
  let ancestorInfo;
  while (true) {
    try {
      ancestorInfo = await lstat(ancestor);
      break;
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new ChromeControllerError(refusalCode);
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  if (ancestorInfo.isSymbolicLink() || !ancestorInfo.isDirectory() || !ownerMatches(ancestorInfo.uid)) {
    throw new ChromeControllerError(refusalCode);
  }
  if (await realpath(ancestor) !== ancestor) throw new ChromeControllerError(refusalCode);

  let directory = await open(
    ancestor,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let directoryFd = directory.fd;
  let directoryIsRaw = false;
  const closeDirectory = async (): Promise<void> => {
    if (directoryIsRaw) closeSync(directoryFd);
    else await directory.close();
  };
  let currentPath = ancestor;
  try {
    const openedInfo = await directory.stat();
    const currentInfo = await lstat(currentPath);
    if (!openedInfo.isDirectory() || !ownerMatches(openedInfo.uid)
      || currentInfo.isSymbolicLink() || !sameFile(openedInfo, currentInfo)) {
      throw new ChromeControllerError(refusalCode);
    }
    for (const component of missing) {
      await hooks.beforeCreate?.(currentPath, component);
      const name = Buffer.from(`${component}\0`);
      directoryApi.mkdirat(directoryFd, ptr(name), PRIVATE_DIRECTORY_MODE);
      const childFd = directoryApi.openat(
        directoryFd,
        ptr(name),
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        0,
      );
      if (childFd < 0) throw new ChromeControllerError(refusalCode);
      const childInfo = fstatSync(childFd);
      if (!childInfo.isDirectory() || !ownerMatches(childInfo.uid)
        || (childInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        closeSync(childFd);
        throw new ChromeControllerError(refusalCode);
      }
      await closeDirectory();
      directoryFd = childFd;
      directoryIsRaw = true;
      currentPath = join(currentPath, component);
    }

    const finalInfo = await lstat(target);
    const openedFinalInfo = directoryIsRaw ? fstatSync(directoryFd) : await directory.stat();
    if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory() || !ownerMatches(finalInfo.uid)
      || !sameFile(finalInfo, openedFinalInfo) || await realpath(target) !== target
      || ((requirePrivateExisting || missing.length > 0)
        && (finalInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)) {
      throw new ChromeControllerError(refusalCode);
    }
  } catch (error) {
    if (error instanceof ChromeControllerError) throw error;
    throw new ChromeControllerError(refusalCode);
  } finally {
    try { await closeDirectory(); } catch { /* already closed */ }
  }
};

export const prepareChromePathsSecure = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  hooks: SecureChromePathHooks = {},
): Promise<ChromePaths> => {
  const requested = resolveChromePaths(environment);
  await ensureAnchoredDirectory(requested.configRoot, "UNSAFE_CONFIG", true, hooks);
  await ensureAnchoredDirectory(requested.profileDir, "PROFILE_CONFLICT", false, hooks);
  return requested;
};

const boundedRegularRead = async (
  path: string,
  maximumBytes: number,
): Promise<{ text: string; owned: boolean; mode: number } | null> => {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errno(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TypeError("State is not a regular file");
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > maximumBytes) throw new RangeError("State exceeds its byte ceiling");
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      owned: ownerMatches(info.uid),
      mode: info.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
};

const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
};

const validRecord = (value: unknown): value is OwnershipRecord => {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const requiredKeys = [
    "schemaVersion", "pid", "executable", "profileDir", "launchNonce",
    "startedAt", "port", "webSocketUrl", "processBirth",
  ];
  const expectedKeys = item.visibility === undefined
    ? requiredKeys
    : [...requiredKeys, "visibility"];
  if (!exactKeys(item, expectedKeys)) return false;
  return item.schemaVersion === 1
    && Number.isSafeInteger(item.pid) && (item.pid as number) > 0
    && typeof item.executable === "string" && item.executable.startsWith("/") && !item.executable.includes("\0")
    && typeof item.profileDir === "string" && item.profileDir.startsWith("/") && !item.profileDir.includes("\0")
    && typeof item.launchNonce === "string" && NONCE.test(item.launchNonce)
    && typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt))
    && Number.isInteger(item.port) && (item.port as number) >= 1 && (item.port as number) <= 65_535
    && typeof item.webSocketUrl === "string"
    && (item.visibility === undefined || item.visibility === "headless" || item.visibility === "headed")
    && item.processBirth !== null && !Array.isArray(item.processBirth)
    && typeof item.processBirth === "object"
    && exactKeys(item.processBirth as Record<string, unknown>, ["kind", "value"])
    && ((item.processBirth as Record<string, unknown>).kind === "linux-proc-start-ticks"
      || (item.processBirth as Record<string, unknown>).kind === "darwin-ps-start")
    && typeof (item.processBirth as Record<string, unknown>).value === "string"
    && ((item.processBirth as Record<string, unknown>).value as string).length > 0
    && ((item.processBirth as Record<string, unknown>).value as string).length <= 128;
};

const readRecord = async (path: string): Promise<RecordObservation> => {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  if (info.isSymbolicLink()) return { kind: "symlink" };
  if (!info.isFile()) return { kind: "malformed" };
  if (!ownerMatches(info.uid) || (info.mode & 0o077) !== 0) return { kind: "wrong-owner" };
  let state;
  try {
    state = await boundedRegularRead(path, OWNERSHIP_MAX_BYTES);
  } catch (error) {
    return error instanceof RangeError ? { kind: "oversized" } : { kind: "malformed" };
  }
  if (state === null) return { kind: "absent" };
  if (!state.owned || (state.mode & 0o077) !== 0) return { kind: "wrong-owner" };
  let value: unknown;
  try {
    value = JSON.parse(state.text);
  } catch {
    return { kind: "malformed" };
  }
  if (!validRecord(value)) return { kind: "malformed" };
  try {
    if (await realpath(value.executable) !== value.executable
      || await realpath(value.profileDir) !== value.profileDir) return { kind: "malformed" };
    const executableInfo = await lstat(value.executable);
    const profileInfo = await lstat(value.profileDir);
    if (!executableInfo.isFile() || !profileInfo.isDirectory()) return { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
  return { kind: "valid", value };
};

const atomicPrivateWrite = async (path: string, text: string, budgetMs?: number): Promise<void> => {
  const deadline = budgetMs === undefined ? undefined : performance.now() + Math.max(1, budgetMs);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  let moved = false;
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    if (deadline !== undefined && performance.now() >= deadline) {
      throw new ChromeControllerError("READINESS_TIMEOUT");
    }
    await rename(temporary, path);
    moved = true;
  } finally {
    try { await handle.close(); } catch { /* already closed */ }
    if (!moved) await rm(temporary, { force: true });
  }
};

interface LaunchLockLease {
  schemaVersion: 1;
  pid: number;
  processBirth: ProcessBirthIdentity;
  nonce: string;
  createdAt: string;
}

export interface FileLaunchLockOptions {
  lockPath: string;
  pid: number;
  processBirth: ProcessBirthIdentity;
  nonce: string;
  createdAt: string;
  monotonicNow(): number;
  sleep(milliseconds: number): Promise<void>;
  acquisitionTimeoutMs?: number;
  writeLease?(fd: number, content: string): Promise<void>;
  beforeFlock?(): Promise<void>;
  afterDeferredUnlock?(): void;
  awaitDeadline?<T>(promise: Promise<T>, timeoutMs: number): Promise<T>;
}

const sameFile = (
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

export const acquireFileLaunchLock = async (
  options: FileLaunchLockOptions,
): Promise<LaunchLock> => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new ChromeControllerError("IO_FAILURE");
  }
  const acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? LOCK_ACQUISITION_TIMEOUT_MS;
  if (!Number.isFinite(acquisitionTimeoutMs) || acquisitionTimeoutMs <= 0) {
    throw new ChromeControllerError("IO_FAILURE");
  }

  const lease: LaunchLockLease = {
    schemaVersion: 1,
    pid: options.pid,
    processBirth: options.processBirth,
    nonce: options.nonce,
    createdAt: options.createdAt,
  };
  const leaseContent = `${JSON.stringify(lease)}\n`;

  let handle: FileHandle;
  try {
    handle = await open(
      options.lockPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch {
    throw new ChromeControllerError("IO_FAILURE");
  }
  const fd = handle.fd;

  const fdStat = fstatSync(fd);
  if (!fdStat.isFile() || !ownerMatches(fdStat.uid)
    || (fdStat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    try { await handle.close(); } catch { /* */ }
    throw new ChromeControllerError("IO_FAILURE");
  }
  try {
    const pathStat = await lstat(options.lockPath);
    if (pathStat.isSymbolicLink() || !sameFile(fdStat, pathStat)) {
      await handle.close();
      throw new ChromeControllerError("IO_FAILURE");
    }
  } catch (error) {
    if (error instanceof ChromeControllerError) throw error;
    try { await handle.close(); } catch { /* */ }
    throw new ChromeControllerError("IO_FAILURE");
  }

  let locked = false;
  let closed = false;
  const unlockAndClose = async () => {
    if (closed) return;
    closed = true;
    if (locked) {
      try { directoryApi.flock(fd, LOCK_UN); } catch { /* already unlocked */ }
      locked = false;
    }
    try { await handle.close(); } catch { /* already closed */ }
  };

  const deadline = options.monotonicNow() + acquisitionTimeoutMs;
  let leaseUnlockDeferred = false;
  try {
    if (options.beforeFlock) await options.beforeFlock();

    while (options.monotonicNow() < deadline) {
      const result = directoryApi.flock(fd, LOCK_EX | LOCK_NB);
      if (result === 0) {
        locked = true;
        break;
      }
      const remaining = deadline - options.monotonicNow();
      if (remaining > 0) await options.sleep(Math.min(LOCK_POLL_MS, remaining));
    }
    if (!locked) throw new ChromeControllerError("LOCK_TIMEOUT");

    try {
      const revalidated = await lstat(options.lockPath);
      if (revalidated.isSymbolicLink() || !sameFile(fdStat, revalidated)) {
        await unlockAndClose();
        throw new ChromeControllerError("IO_FAILURE");
      }
    } catch (error) {
      if (error instanceof ChromeControllerError) throw error;
      await unlockAndClose();
      throw new ChromeControllerError("IO_FAILURE");
    }

    const leaseWrite = async (): Promise<void> => {
      if (options.writeLease) {
        await options.writeLease(fd, leaseContent);
      } else {
        await handle.truncate(0);
        await handle.writeFile(leaseContent, "utf8");
        await handle.sync();
      }
    };

    const leaseDeadline = Math.min(deadline, options.monotonicNow() + LEASE_WRITE_BUDGET_MS);
    const leasePromise = leaseWrite();
    let leaseTimedOut = false;
    const awaitDeadlineFn = options.awaitDeadline ?? awaitWithTimeout;
    try {
      const remaining = leaseDeadline - options.monotonicNow();
      if (remaining <= 0) {
        leaseTimedOut = true;
        throw new ChromeControllerError("LOCK_TIMEOUT");
      }
      await awaitDeadlineFn(leasePromise, Math.max(1, remaining));
    } catch (error) {
      const isTimeout = (error instanceof Error && error.message === "timeout")
        || (error instanceof ChromeControllerError && error.code === "LOCK_TIMEOUT");
      if (isTimeout || leaseTimedOut) {
        leaseTimedOut = true;
        leaseUnlockDeferred = true;
        void (async () => {
          try { await leasePromise; } catch { /* deferred write settled */ }
          await unlockAndClose();
          options.afterDeferredUnlock?.();
        })();
        throw new ChromeControllerError("LOCK_TIMEOUT");
      }
      await unlockAndClose();
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    if (options.monotonicNow() >= leaseDeadline) {
      await unlockAndClose();
      throw new ChromeControllerError("LOCK_TIMEOUT");
    }

    let released = false;
    let retained = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        if (retained) retainedLockHandles.delete(handle);
        await unlockAndClose();
      },
      retain: async () => {
        if (released || retained) return;
        retained = true;
        retainedLockHandles.add(handle);
      },
    };
  } catch (error) {
    if (!leaseUnlockDeferred) await unlockAndClose();
    if (error instanceof ChromeControllerError) throw error;
    throw new ChromeControllerError("IO_FAILURE");
  }
};

const streamBounded = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) throw new RangeError("Output exceeds its byte ceiling");
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, bytes);
};

export interface BoundedDiagnosticChild {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

type AwaitDeadline = <T>(work: Promise<T>, timeoutMs: number) => Promise<T>;

export interface BoundedDiagnosticOptions {
  timeoutMs: number;
  maximumBytes: number;
  cleanupTimeoutMs: number;
  awaitDeadline?: AwaitDeadline;
}

const awaitWithTimeout: AwaitDeadline = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const runSystemProbe = <T>(
  budgetMs: number,
  operation: () => Promise<T>,
): Promise<T> => {
  const deadline = performance.now() + Math.max(1, budgetMs);
  return runBeforeChromeDeadline(
    deadline,
    () => performance.now(),
    (remaining) => awaitWithTimeout(operation(), remaining),
  );
};

const readDiagnosticOutput = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) return Buffer.concat(chunks, bytes);
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) throw new RangeError("Output exceeds its byte ceiling");
    chunks.push(next.value);
  }
};

export const runBoundedDiagnosticResult = async (
  child: BoundedDiagnosticChild,
  options: BoundedDiagnosticOptions,
): Promise<{ status: number; output: string }> => {
  const reader = child.stdout.getReader();
  const awaitDeadline = options.awaitDeadline ?? awaitWithTimeout;
  try {
    const [output, status] = await awaitDeadline(
      Promise.all([readDiagnosticOutput(reader, options.maximumBytes), child.exited]),
      options.timeoutMs,
    );
    return { status, output: output.toString("utf8") };
  } catch {
    const cancelPromise = reader.cancel().catch(() => undefined);
    const sigtermBudget = Math.max(1, Math.floor(options.cleanupTimeoutMs / 2));
    const sigkillBudget = Math.max(1, options.cleanupTimeoutMs - sigtermBudget);

    try { child.kill("SIGTERM"); } catch { /* continue cleanup */ }
    let reaped = false;
    try {
      await awaitDeadline(
        Promise.all([cancelPromise, child.exited]),
        sigtermBudget,
      );
      reaped = true;
    } catch { /* SIGTERM did not reap, escalate */ }

    if (!reaped) {
      try { child.kill("SIGKILL"); } catch { /* continue cleanup */ }
      try {
        await awaitDeadline(
          Promise.all([cancelPromise, child.exited]),
          sigkillBudget,
        );
      } catch { /* SIGKILL could not be proven */ }
    }

    throw new Error("Bounded subprocess failed");
  } finally {
    try { reader.releaseLock(); } catch { /* pending read is bounded/cancelled */ }
  }
};

const runBoundedResult = async (
  argv: string[],
  timeoutMs = SUBPROCESS_TIMEOUT_MS,
): Promise<{ status: number; output: string }> => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  return runBoundedDiagnosticResult({
    stdout: child.stdout,
    exited: child.exited,
    kill: (signal) => { child.kill(signal); },
  }, {
    timeoutMs,
    maximumBytes: SUBPROCESS_MAX_BYTES,
    cleanupTimeoutMs: DIAGNOSTIC_CLEANUP_TIMEOUT_MS,
  });
};

const runBounded = async (argv: string[], timeoutMs = SUBPROCESS_TIMEOUT_MS): Promise<string> => {
  try {
    const result = await runBoundedResult(argv, timeoutMs);
    return result.status === 0 ? result.output : "";
  } catch {
    return "";
  }
};

const splitCommand = (command: string): string[] => {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) { word += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== "") {
      if (character === quote) quote = "";
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) {
      if (word !== "") { words.push(word); word = ""; }
    } else word += character;
  }
  if (word !== "") words.push(word);
  return words;
};

export const parseLinuxProcessBirth = (stat: string) => {
  if (Buffer.byteLength(stat) > 4_096 || stat.includes("\0")) return null;
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd < 3) return null;
  const fields = stat.slice(commandEnd + 2).trim().split(/ +/);
  const ticks = fields[19];
  if (fields.length < 20 || ticks === undefined || !/^[1-9][0-9]*$/.test(ticks)) return null;
  return { kind: "linux-proc-start-ticks" as const, value: ticks };
};

export const parseDarwinProcessBirth = (text: string) => {
  const value = text.trim().replace(/ +/g, " ");
  if (Buffer.byteLength(text) > 256 || text.includes("\0")
    || !/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}$/.test(value)) {
    return null;
  }
  return { kind: "darwin-ps-start" as const, value };
};

export interface ProcessProbeDeps {
  platform: string;
  monotonicNow: () => number;
  signalKill: (pid: number) => void;
  readProcExe: (pid: number) => Promise<string | null>;
  readProcText: (pid: number, name: string, maxBytes: number) => Promise<{ text: string } | null>;
  canonicalize: (path: string) => Promise<string>;
  runProbe: (argv: string[], timeoutMs: number) => Promise<{ status: number; output: string }>;
}

export const runBoundedProcessProbe = async (
  pid: number,
  deadline: number,
  deps: ProcessProbeDeps,
): Promise<ProcessObservation> => {
  const remaining = (): number => {
    const value = deadline - deps.monotonicNow();
    if (value <= 0) throw new ChromeControllerError("READINESS_TIMEOUT");
    return value;
  };
  let live = true;
  try { deps.signalKill(pid); } catch (error) { live = errno(error, "EPERM"); }
  if (!live) return { live: false, pid, executable: "", argv: [], processBirth: null };
  if (deps.platform === "linux") {
    remaining();
    let hasProcExe = false;
    try {
      const exeTarget = await deps.readProcExe(pid);
      hasProcExe = exeTarget !== null;
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      hasProcExe = false;
    }
    remaining();
    if (!hasProcExe) throw new ChromeControllerError("IO_FAILURE");
    let executable: string;
    try {
      executable = await deps.canonicalize(`/proc/${pid}/exe`);
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    remaining();
    let command: { text: string } | null;
    try {
      command = await deps.readProcText(pid, "cmdline", SUBPROCESS_MAX_BYTES);
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    remaining();
    let statText: { text: string } | null;
    try {
      statText = await deps.readProcText(pid, "stat", 4_096);
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    remaining();
    if (command === null || statText === null) throw new ChromeControllerError("IO_FAILURE");
    const processBirth = parseLinuxProcessBirth(statText.text);
    if (processBirth === null) throw new ChromeControllerError("IO_FAILURE");
    remaining();
    return {
      live: true,
      pid,
      executable,
      argv: command.text.split("\0").filter(Boolean),
      processBirth,
    };
  }
  if (deps.platform === "darwin") {
    let commText: string;
    let commandText: string;
    let processStartText: string;
    remaining();
    try {
      const commProbe = await deps.runProbe(
        ["ps", "-p", String(pid), "-o", "comm="], remaining(),
      );
      remaining();
      if (commProbe.status !== 0) throw new ChromeControllerError("IO_FAILURE");
      commText = commProbe.output.trim();
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    remaining();
    try {
      const commandProbe = await deps.runProbe(
        ["ps", "-ww", "-p", String(pid), "-o", "command="], remaining(),
      );
      remaining();
      if (commandProbe.status !== 0) throw new ChromeControllerError("IO_FAILURE");
      commandText = commandProbe.output;
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    remaining();
    try {
      const lstartProbe = await deps.runProbe(
        ["ps", "-p", String(pid), "-o", "lstart="], remaining(),
      );
      remaining();
      if (lstartProbe.status !== 0) throw new ChromeControllerError("IO_FAILURE");
      processStartText = lstartProbe.output;
    } catch (error) {
      if (deps.monotonicNow() >= deadline) throw new ChromeControllerError("READINESS_TIMEOUT");
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("IO_FAILURE");
    }
    let executable = commText;
    try { executable = await deps.canonicalize(commText); } catch { /* mismatch remains safely visible */ }
    remaining();
    const processBirth = parseDarwinProcessBirth(processStartText);
    if (executable === "" || processBirth === null) {
      throw new ChromeControllerError("IO_FAILURE");
    }
    return {
      live: true,
      pid,
      executable,
      argv: splitCommand(commandText),
      processBirth,
    };
  }
  throw new ChromeControllerError("IO_FAILURE");
};

const inspectProcess = async (pid: number, budgetMs = SUBPROCESS_TIMEOUT_MS): Promise<ProcessObservation> => {
  const deadline = performance.now() + Math.max(1, budgetMs);
  return runBoundedProcessProbe(pid, deadline, {
    platform: process.platform,
    monotonicNow: () => performance.now(),
    signalKill: (target) => { process.kill(target, 0); },
    readProcExe: async (target) => {
      await lstat(`/proc/${target}/exe`);
      return "link";
    },
    readProcText: async (target, name, maxBytes) => boundedRegularRead(`/proc/${target}/${name}`, maxBytes),
    canonicalize: (path) => realpath(path),
    runProbe: (argv, timeoutMs) => runBoundedResult(argv, timeoutMs),
  });
};

export type ListenerDiscovery =
  | { kind: "found"; listener: ListenerObservation }
  | { kind: "ambiguous" };

const parsePositiveSafeInteger = (value: string): number | null => {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const parseLsofListenerOutput = (output: string, expectedPort: number): ListenerDiscovery => {
  if (Buffer.byteLength(output) > SUBPROCESS_MAX_BYTES || output.includes("\0")) {
    return { kind: "ambiguous" };
  }
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  if (lines.some((line) => line === "" || !/^[pfn]/.test(line))) return { kind: "ambiguous" };
  const pids = lines.filter((line) => line.startsWith("p"));
  const names = lines.filter((line) => line.startsWith("n"));
  const pid = pids.length === 1 ? parsePositiveSafeInteger(pids[0]!.slice(1)) : null;
  if (pid === null || names.length !== 1 || !pids[0]!.startsWith("p")) {
    return { kind: "ambiguous" };
  }
  const matched = /^n(?:TCP@?)?(.+):([0-9]+)$/.exec(names[0]!);
  if (matched === null || Number(matched[2]) !== expectedPort) return { kind: "ambiguous" };
  return {
    kind: "found",
    listener: { host: matched[1]!, port: expectedPort, pid },
  };
};

export type PgrepDiscovery =
  | { kind: "found"; pids: number[] }
  | { kind: "ambiguous" };

export const parsePgrepPidOutput = (output: string): PgrepDiscovery => {
  if (Buffer.byteLength(output) > SUBPROCESS_MAX_BYTES || output.includes("\0")) {
    return { kind: "ambiguous" };
  }
  const lines = output.trim().split(/\n/);
  if (output.trim() === "" || lines.length > 512) {
    return { kind: "ambiguous" };
  }
  const parsed = lines.map(parsePositiveSafeInteger);
  if (parsed.some((pid) => pid === null)) return { kind: "ambiguous" };
  const pids = parsed as number[];
  if (new Set(pids).size !== pids.length) return { kind: "ambiguous" };
  return { kind: "found", pids };
};

export type ProfileProcessDiscovery =
  | { kind: "absent" }
  | { kind: "found"; process: ProcessObservation }
  | { kind: "ambiguous" };

export const buildBroadPgrepArgv = (): string[] =>
  ["pgrep", "-f", "--", "--user-data-dir="];

export const runProfileProcessDiscovery = async (
  profileDir: string,
  excludingPid: number | undefined,
  runner: (argv: string[], timeoutMs: number) => Promise<{ status: number; output: string }>,
  inspect: (pid: number, budgetMs: number) => Promise<ProcessObservation | null>,
  canonicalize: (path: string, budgetMs: number) => Promise<string>,
  budgetMs: number,
): Promise<ProcessObservation | null> => {
  const deadline = performance.now() + Math.max(1, budgetMs);
  const remaining = (): number => {
    const value = deadline - performance.now();
    if (value <= 0) throw new ChromeControllerError("READINESS_TIMEOUT");
    return value;
  };
  const argv = buildBroadPgrepArgv();
  let result: { status: number; output: string };
  try {
    result = await runner(argv, Math.min(SUBPROCESS_TIMEOUT_MS, remaining()));
    remaining();
  } catch (error) {
    if (error instanceof ChromeControllerError && error.code === "READINESS_TIMEOUT") throw error;
    if (deadline - performance.now() <= 0) throw new ChromeControllerError("READINESS_TIMEOUT");
    throw new ChromeControllerError("IO_FAILURE");
  }
  if (result.status === 1) return null;
  if (result.status !== 0) throw new ChromeControllerError("IO_FAILURE");
  const parsed = parsePgrepPidOutput(result.output);
  if (parsed.kind === "ambiguous") throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
  let canonicalProfileDir: string;
  try {
    canonicalProfileDir = await canonicalize(profileDir, remaining());
    remaining();
  } catch (error) {
    if (error instanceof ChromeControllerError && error.code === "READINESS_TIMEOUT") throw error;
    if (deadline - performance.now() <= 0) throw new ChromeControllerError("READINESS_TIMEOUT");
    throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
  }
  const selected = await selectProfileProcess(
    parsed.pids,
    canonicalProfileDir,
    excludingPid,
    inspect,
    canonicalize,
    remaining,
  );
  if (selected.kind === "ambiguous") throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
  return selected.kind === "found" ? selected.process : null;
};

export const selectProfileProcess = async (
  pids: number[],
  canonicalProfileDir: string,
  excludingPid: number | undefined,
  inspect: (pid: number, budgetMs: number) => Promise<ProcessObservation | null>,
  canonicalize: (path: string, budgetMs: number) => Promise<string>,
  remaining: () => number,
): Promise<ProfileProcessDiscovery> => {
  const matches: ProcessObservation[] = [];
  for (const pid of pids) {
    if (pid === excludingPid) continue;
    let candidate: ProcessObservation | null;
    try {
      const budget = remaining();
      candidate = await inspect(pid, budget);
      remaining();
    } catch (error) {
      if (error instanceof ChromeControllerError && error.code === "READINESS_TIMEOUT") throw error;
      remaining();
      return { kind: "ambiguous" };
    }
    if (candidate === null) return { kind: "ambiguous" };
    if (!candidate.live) continue;
    if (candidate.processBirth === null || candidate.executable === "" || candidate.argv.length === 0) {
      return { kind: "ambiguous" };
    }
    if (candidate.argv.some((a) => a.startsWith("--type="))) continue;
    const userDirFlags = candidate.argv.filter((a) => a.startsWith("--user-data-dir="));
    if (userDirFlags.length !== 1) return { kind: "ambiguous" };
    const userDir = canonicalUserDirValue(userDirFlags[0]!);
    if (userDir === null) return { kind: "ambiguous" };
    let canonicalUserDir: string;
    try {
      canonicalUserDir = await canonicalize(userDir, remaining());
      remaining();
    } catch (error) {
      if (error instanceof ChromeControllerError && error.code === "READINESS_TIMEOUT") throw error;
      remaining();
      if (canonicalProfileDir.startsWith(userDir)) return { kind: "ambiguous" };
      continue;
    }
    if (canonicalUserDir !== canonicalProfileDir) continue;
    matches.push(candidate);
  }
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "found", process: matches[0]! };
};

const inspectListener = async (port: number, budgetMs = SUBPROCESS_TIMEOUT_MS): Promise<ChromeObservation["listener"]> => {
  const lsof = Bun.which("lsof") ?? "/usr/sbin/lsof";
  let result: { status: number; output: string };
  try {
    result = await runBoundedResult(
      [lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
      Math.min(SUBPROCESS_TIMEOUT_MS, budgetMs),
    );
  } catch {
    throw new ChromeControllerError("IO_FAILURE");
  }
  if (result.status === 1) return null;
  if (result.status !== 0) throw new ChromeControllerError("IO_FAILURE");
  const parsed = parseLsofListenerOutput(result.output, port);
  if (parsed.kind === "ambiguous") throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
  return parsed.listener;
};

const fetchVersion = async (
  port: number,
  path: string | undefined,
  budgetMs = SUBPROCESS_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(1_000, budgetMs)));
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok || response.body === null) return { kind: "malformed" as const };
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > VERSION_RESPONSE_MAX_BYTES)) {
      return { kind: "malformed" as const };
    }
    const body = await streamBounded(response.body, VERSION_RESPONSE_MAX_BYTES);
    return parseVersionResponse(body.toString("utf8"), port, path);
  } catch {
    return { kind: "malformed" as const };
  } finally {
    clearTimeout(timer);
  }
};

export const fetchExternalCdpVersion = (
  port: number,
  budgetMs = SUBPROCESS_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch,
): Promise<VersionObservation> => fetchVersion(port, undefined, budgetMs, fetchImpl);

class SystemChromeAdapter implements ChromeAdapter {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly executablePath: string | undefined;

  constructor(options: ChromeControllerOptions) {
    this.environment = options.environment ?? process.env;
    this.executablePath = options.executablePath;
  }

  async preparePaths(): Promise<ChromePaths> {
    return prepareChromePathsSecure(this.environment);
  }

  observePaths(paths: ChromePaths, budgetMs: number): Promise<Pick<ChromeObservation, "config" | "profile">> {
    return runSystemProbe(budgetMs, async () => {
      const config = await observePath(paths.configRoot);
      const profile = await observePath(paths.profileDir);
      return { config, profile };
    });
  }

  readOwnership(paths: ChromePaths, budgetMs: number): Promise<RecordObservation> {
    return runSystemProbe(budgetMs, () => readRecord(paths.ownershipPath));
  }

  readActivePort(paths: ChromePaths, budgetMs: number): Promise<ActivePortObservation | null> {
    return runSystemProbe(budgetMs, async () => {
      const activeState = await observePath(paths.activePortPath);
      if (activeState.kind === "absent") return null;
      try {
        const read = await boundedRegularRead(paths.activePortPath, DEVTOOLS_ACTIVE_PORT_MAX_BYTES);
        return read === null ? null : parseDevToolsActivePort(read.text);
      } catch {
        return { kind: "malformed" };
      }
    });
  }

  inspectProcess(pid: number, budgetMs: number): Promise<ProcessObservation> {
    return runSystemProbe(budgetMs, () => inspectProcess(pid, budgetMs));
  }
  async findProfileProcess(
    profileDir: string,
    excludingPid: number | undefined,
    budgetMs: number,
  ): Promise<ProcessObservation | null> {
    const boundedCanonicalize = async (path: string, budgetMs: number): Promise<string> => {
      const work = realpath(path);
      try {
        return await awaitWithTimeout(work, Math.max(1, budgetMs));
      } catch (error) {
        if (error instanceof Error && error.message === "timeout") {
          throw new ChromeControllerError("READINESS_TIMEOUT");
        }
        throw error;
      }
    };
    return runProfileProcessDiscovery(
      profileDir,
      excludingPid,
      runBoundedResult,
      (pid, budget) => inspectProcess(pid, budget),
      boundedCanonicalize,
      budgetMs,
    );
  }
  inspectListener(port: number, budgetMs: number): Promise<ListenerObservation | null> {
    return inspectListener(port, budgetMs);
  }
  fetchVersion(port: number, activePath: string, budgetMs: number): Promise<VersionObservation> {
    return fetchVersion(port, activePath, budgetMs);
  }

  async repairProfile(path: string, budgetMs: number): Promise<void> {
    const probeDeadline = performance.now() + Math.max(1, budgetMs);
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory() || !ownerMatches(info.uid)) throw new ChromeControllerError("PROFILE_CONFLICT");
      await handle.chmod(PRIVATE_DIRECTORY_MODE);
    } catch (error) {
      if (error instanceof ChromeControllerError) throw error;
      throw new ChromeControllerError("PROFILE_CONFLICT");
    } finally {
      await handle?.close();
    }
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
  }

  async acquireLock(paths: ChromePaths): Promise<LaunchLock> {
    const identity = await inspectProcess(process.pid, SUBPROCESS_TIMEOUT_MS);
    if (!identity.live || identity.processBirth === null) {
      throw new ChromeControllerError("IO_FAILURE");
    }
    return acquireFileLaunchLock({
      lockPath: paths.lockPath,
      pid: process.pid,
      processBirth: identity.processBirth,
      nonce: randomBytes(16).toString("hex"),
      createdAt: new Date(this.wallNow()).toISOString(),
      monotonicNow: () => this.monotonicNow(),
      sleep: (milliseconds) => this.sleep(milliseconds),
    });
  }

  async removeStaleState(paths: ChromePaths, launchNonce: string | undefined, budgetMs: number): Promise<void> {
    const probeDeadline = performance.now() + Math.max(1, budgetMs);
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
    if (launchNonce !== undefined) {
      const current = await readRecord(paths.ownershipPath);
      if (current.kind === "valid" && current.value.launchNonce !== launchNonce) return;
      if (current.kind !== "valid" && current.kind !== "absent") return;
    }
    await rm(paths.ownershipPath, { force: true });
    await rm(paths.activePortPath, { force: true });
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
  }

  async findChrome(budgetMs: number): Promise<string> {
    return runSystemProbe(budgetMs, async () => {
      const selected = this.executablePath ?? this.environment.BUN_CHROME_PATH;
      const candidates = selected !== undefined
        ? [selected]
        : [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            Bun.which("google-chrome"),
            Bun.which("chromium"),
            Bun.which("chrome"),
          ].filter((value): value is string => value !== null);
      for (const candidate of candidates) {
        if (candidate.length === 0 || candidate.includes("\0")) break;
        try {
          const canonical = await realpath(candidate);
          const info = await lstat(canonical);
          if (info.isFile()) return canonical;
        } catch {
          if (selected !== undefined) break;
        }
      }
      throw new ChromeControllerError("CHROME_NOT_FOUND");
    });
  }

  async spawnChrome(argv: string[], budgetMs: number): Promise<SpawnedChrome> {
    const probeDeadline = performance.now() + Math.max(1, budgetMs);
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    return {
      pid: child.pid,
      hasExited: () => child.exitCode !== null,
      terminate: async (signal: "SIGTERM") => { child.kill(signal); },
      waitForExit: (timeoutMs: number) => waitForExit(child.exited, timeoutMs),
      unref: () => { child.unref(); },
    };
  }

  async writeOwnership(paths: ChromePaths, record: OwnershipRecord, budgetMs: number): Promise<void> {
    await atomicPrivateWrite(paths.ownershipPath, `${JSON.stringify(record)}\n`, budgetMs);
  }

  async signal(pid: number, signal: "SIGTERM", budgetMs: number): Promise<void> {
    const probeDeadline = performance.now() + Math.max(1, budgetMs);
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
    process.kill(pid, signal);
    if (performance.now() >= probeDeadline) throw new ChromeControllerError("READINESS_TIMEOUT");
  }

  async isLive(pid: number, _budgetMs: number): Promise<boolean> {
    try { process.kill(pid, 0); return true; } catch (error) { return errno(error, "EPERM"); }
  }

  monotonicNow(): number { return performance.now(); }
  wallNow(): number { return Date.now(); }
  sleep(milliseconds: number): Promise<void> { return sleep(milliseconds); }
  randomNonce(): string { return randomBytes(16).toString("hex"); }
}

const refusal = (code: string): ChromeControllerError =>
  new ChromeControllerError(code as ChromeControllerErrorCode);

const compactError = (error: unknown): ChromeControllerError =>
  error instanceof ChromeControllerError ? error : new ChromeControllerError("IO_FAILURE");

const session = (
  value: {
    pid: number;
    port: number;
    webSocketUrl: string;
    profileDir: string;
    visibility: ManagedBrowserVisibility;
  },
  reused: boolean,
): ChromeSession => ({
  pid: value.pid,
  port: value.port,
  webSocketUrl: value.webSocketUrl,
  profileDir: value.profileDir,
  ownership: "owned",
  visibility: value.visibility,
  reused,
});

class ChromeLockGuard {
  private retentionState: "release" | "deferred" | "permanent" = "release";
  private retainCalled = false;
  private readonly settlements: Promise<void>[] = [];

  constructor(private readonly lock: LaunchLock) {}

  private ensureRetained(): void {
    if (this.retainCalled) return;
    this.retainCalled = true;
    void this.lock.retain();
  }

  defer(settlement: Promise<void>): void {
    if (this.retentionState === "permanent") return;
    this.ensureRetained();
    this.retentionState = "deferred";
    this.settlements.push(settlement);
  }

  makePermanent(): void {
    this.ensureRetained();
    this.retentionState = "permanent";
  }

  async finish(): Promise<void> {
    if (this.retentionState === "release") {
      await this.lock.release();
      return;
    }
    if (this.retentionState === "deferred") {
      void Promise.all(this.settlements.map((settlement) => settlement.catch(() => {}))).finally(() => {
        if (this.retentionState !== "permanent") void this.lock.release().catch(() => {});
      });
    }
  }
}

interface HeldChromeLock {
  paths: ChromePaths;
  guard: ChromeLockGuard;
}

export class ChromeController {
  private readonly adapter: ChromeAdapter;
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly ensurePromises: Partial<Record<ManagedBrowserVisibility, Promise<ChromeSession>>> = {};
  private switchPromise: Promise<ChromeSession> | undefined;

  constructor(options: ChromeControllerOptions = {}) {
    this.adapter = options.adapter ?? new SystemChromeAdapter(options);
    const timing = validateChromeTimingOptions(options);
    this.readinessTimeoutMs = timing.readinessTimeoutMs;
    this.pollIntervalMs = timing.pollIntervalMs;
  }

  ensureRunning(visibility: ManagedBrowserVisibility = "headless"): Promise<ChromeSession> {
    const existing = this.ensurePromises[visibility];
    if (existing !== undefined) return existing;
    let promise!: Promise<ChromeSession>;
    promise = this.ensureRunningOnce(visibility)
      .catch((error) => { throw compactError(error); })
      .finally(() => {
        if (this.ensurePromises[visibility] === promise) delete this.ensurePromises[visibility];
      });
    this.ensurePromises[visibility] = promise;
    return promise;
  }

  switchOwnedToHeaded(): Promise<ChromeSession> {
    this.switchPromise ??= this.switchOwnedToHeadedOnce()
      .catch((error) => { throw compactError(error); })
      .finally(() => { this.switchPromise = undefined; });
    return this.switchPromise;
  }

  private remaining(deadline: number): number {
    const value = deadline - this.adapter.monotonicNow();
    if (!Number.isFinite(value) || value <= 0) throw new ChromeControllerError("READINESS_TIMEOUT");
    return value;
  }

  private async raceMutation<T>(deadline: number, promise: Promise<T>): Promise<T> {
    const remaining = deadline - this.adapter.monotonicNow();
    if (remaining <= 0) {
      promise.catch(() => {});
      throw new ChromeControllerError("READINESS_TIMEOUT");
    }
    let value: T;
    try {
      value = await awaitWithTimeout(promise, remaining);
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        promise.catch(() => {});
        throw new ChromeControllerError("READINESS_TIMEOUT");
      }
      throw error;
    }
    if (this.adapter.monotonicNow() >= deadline) {
      throw new ChromeControllerError("READINESS_TIMEOUT");
    }
    return value;
  }

  private async beforeDeadline<T>(deadline: number, operation: (budgetMs: number) => Promise<T>): Promise<T> {
    return runBeforeChromeDeadline(deadline, () => this.adapter.monotonicNow(), operation);
  }

  private async observe(
    paths: ChromePaths,
    expected: OwnershipRecord | undefined,
    deadline: number,
  ): Promise<ChromeObservation> {
    const pathState = await this.beforeDeadline(deadline,
      (budget) => this.adapter.observePaths(paths, budget));
    const record = expected === undefined
      ? await this.beforeDeadline(deadline, (budget) => this.adapter.readOwnership(paths, budget))
      : { kind: "valid" as const, value: expected };
    const activePort = await this.beforeDeadline(deadline,
      (budget) => this.adapter.readActivePort(paths, budget));
    const identity = expected ?? (record.kind === "valid" ? record.value : undefined);
    const exactProcess = identity === undefined
      ? null
      : await this.beforeDeadline(deadline,
        (budget) => this.adapter.inspectProcess(identity.pid, budget));
    const conflictingProcess = await this.beforeDeadline(deadline,
      (budget) => this.adapter.findProfileProcess(paths.profileDir, identity?.pid, budget));
    const processObservation = conflictingProcess ?? exactProcess;
    const port = identity?.port ?? (activePort?.kind === "valid" ? activePort.port : undefined);
    const listener = port === undefined
      ? null
      : await this.beforeDeadline(deadline, (budget) => this.adapter.inspectListener(port, budget));
    const version = activePort?.kind === "valid"
      ? await this.beforeDeadline(deadline,
        (budget) => this.adapter.fetchVersion(activePort.port, activePort.path, budget))
      : null;
    return {
      ...pathState,
      profilePath: paths.profileDir,
      record,
      process: processObservation,
      listener,
      activePort,
      version,
    };
  }

  private async ensureRunningOnce(
    visibility: ManagedBrowserVisibility,
    held?: HeldChromeLock,
  ): Promise<ChromeSession> {
    const ownsLock = held === undefined;
    const paths = held?.paths ?? await this.adapter.preparePaths();
    const guard = held?.guard ?? new ChromeLockGuard(await this.adapter.acquireLock(paths));
    let child: SpawnedChrome | undefined;
    let nonce: string | undefined;

    const guardMutation = async <T>(deadline: number, promise: Promise<T>): Promise<T> => {
      try {
        return await this.raceMutation(deadline, promise);
      } catch (error) {
        if (error instanceof ChromeControllerError && error.code === "READINESS_TIMEOUT") {
          guard.defer(promise.then(() => {}, () => {}) as Promise<void>);
        }
        throw error;
      }
    };

    try {
      let observed = await this.observe(
        paths,
        undefined,
        this.adapter.monotonicNow() + OBSERVATION_BUDGET_MS,
      );
      if (observed.profile.kind === "directory" && observed.profile.owned
        && (observed.profile.mode & 0o077) !== 0) {
        const repairDeadline = this.adapter.monotonicNow() + LAUNCH_REPAIR_BUDGET_MS;
        await guardMutation(repairDeadline, this.adapter.repairProfile(paths.profileDir, LAUNCH_REPAIR_BUDGET_MS));
        observed = { ...observed, profile: { ...observed.profile, mode: PRIVATE_DIRECTORY_MODE } };
      }
      const initial = classifyChrome(observed);
      if (initial.kind === "refuse") throw refusal(initial.code);
      if (initial.kind === "reuse") return session(initial, true);

      const staleDeadline = this.adapter.monotonicNow() + STALE_STATE_REMOVAL_BUDGET_MS;
      await guardMutation(staleDeadline, this.adapter.removeStaleState(paths, undefined, STALE_STATE_REMOVAL_BUDGET_MS));
      const executable = await this.adapter.findChrome(FIND_CHROME_BUDGET_MS);
      nonce = this.adapter.randomNonce();

      const spawnDeadline = this.adapter.monotonicNow() + SPAWN_CHROME_BUDGET_MS;
      const spawnArgv = [
        executable,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${paths.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ];
      if (visibility === "headless") spawnArgv.push("--headless=new");
      const spawnPromise = this.adapter.spawnChrome(spawnArgv, SPAWN_CHROME_BUDGET_MS);

      let spawnPending = false;
      try {
        const spawnRemaining = spawnDeadline - this.adapter.monotonicNow();
        if (spawnRemaining <= 0) {
          spawnPending = true;
        } else {
          child = await awaitWithTimeout(spawnPromise, spawnRemaining);
        }
      } catch (error) {
        if (error instanceof Error && error.message === "timeout") {
          spawnPending = true;
        } else {
          throw error instanceof ChromeControllerError ? error : new ChromeControllerError("IO_FAILURE");
        }
      }

      if (spawnPending && child === undefined) {
        const spawnSettlement = (async () => {
          try {
            const lateChild = await spawnPromise;
            const terminatePromise = lateChild.terminate("SIGTERM").catch(() => {});
            try {
              await awaitWithTimeout(terminatePromise, CLOSE_SIGNAL_BUDGET_MS);
            } catch {
              await terminatePromise;
            }
            try {
              const exited = await lateChild.waitForExit(CHILD_CLEANUP_WAIT_BUDGET_MS);
              if (!exited) guard.makePermanent();
            } catch {
              guard.makePermanent();
            }
          } catch { /* spawn rejected — safe, no child */ }
        })();
        guard.defer(spawnSettlement);
        throw new ChromeControllerError("READINESS_TIMEOUT");
      }

      if (this.adapter.monotonicNow() >= spawnDeadline) {
        throw new ChromeControllerError("READINESS_TIMEOUT");
      }

      if (child === undefined) {
        throw new ChromeControllerError("IO_FAILURE");
      }

      const launchedPid = child.pid;
      const startedAt = new Date(this.adapter.wallNow()).toISOString();
      const deadline = this.adapter.monotonicNow() + Math.min(this.readinessTimeoutMs, READINESS_BUDGET_MS);
      while (this.adapter.monotonicNow() < deadline) {
        const childLive = child.hasExited()
          ? false
          : await this.beforeDeadline(deadline, (budget) => this.adapter.isLive(launchedPid, budget));
        if (!childLive) {
          throw new ChromeControllerError("CHILD_EXIT");
        }
        const probe = await this.observe(paths, undefined, deadline);
        if (probe.activePort?.kind === "valid" && probe.version?.kind === "valid") {
          if (!probe.process?.live || probe.process.processBirth === null) {
            throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
          }
          const candidate: OwnershipRecord = {
            schemaVersion: 1,
            pid: child.pid,
            executable,
            profileDir: paths.profileDir,
            launchNonce: nonce,
            startedAt,
            port: probe.activePort.port,
            webSocketUrl: probe.version.webSocketUrl,
            processBirth: probe.process.processBirth,
            visibility,
          };
          const verified = await this.observe(paths, candidate, deadline);
          const classified = classifyChrome({
            ...verified,
            profilePath: paths.profileDir,
            record: { kind: "valid", value: candidate },
          });
          if (classified.kind === "refuse") throw refusal(classified.code);
          if (classified.kind === "reuse") {
            await guardMutation(deadline,
              this.adapter.writeOwnership(paths, candidate, this.remaining(deadline)));
            this.remaining(deadline);
            child.unref();
            return session(classified, false);
          }
        }
        await this.adapter.sleep(Math.min(this.pollIntervalMs, this.remaining(deadline)));
      }
      throw new ChromeControllerError("READINESS_TIMEOUT");
    } catch (error) {
      let exitProven = child === undefined || child.hasExited();
      let deferredCleanup: Promise<void> | undefined;

      if (child !== undefined && !child.hasExited()) {
        const terminatePromise = child.terminate("SIGTERM");
        let terminateTimedOut = false;
        let terminateFailed = false;
        try {
          await awaitWithTimeout(terminatePromise, CLOSE_SIGNAL_BUDGET_MS);
        } catch (error) {
          if (error instanceof Error && error.message === "timeout") {
            terminateTimedOut = true;
          } else {
            terminateFailed = true;
          }
        }

        if (terminateTimedOut) {
          const boundedTerminate = terminatePromise.catch(() => {});
          deferredCleanup = (async () => {
            try {
              await boundedTerminate;
              const exited = await child!.waitForExit(CHILD_CLEANUP_WAIT_BUDGET_MS);
              if (!exited) guard.makePermanent();
            } catch {
              guard.makePermanent();
            }
          })();
          guard.defer(deferredCleanup);
          exitProven = false;
        } else if (terminateFailed) {
          exitProven = false;
        } else {
          exitProven = await child.waitForExit(CHILD_CLEANUP_WAIT_BUDGET_MS);
        }
      }

      if (!exitProven && deferredCleanup === undefined) {
        guard.makePermanent();
      }

      if (!exitProven) {
        throw new ChromeControllerError(
          error instanceof ChromeControllerError && error.code === "IO_FAILURE"
            ? "IO_FAILURE"
            : "CHILD_EXIT_TIMEOUT",
        );
      }

      if (nonce !== undefined) {
        const nonceDeadline = this.adapter.monotonicNow() + NONCE_CLEANUP_BUDGET_MS;
        await guardMutation(nonceDeadline, this.adapter.removeStaleState(paths, nonce, NONCE_CLEANUP_BUDGET_MS));
      }
      throw error instanceof ChromeControllerError ? error : new ChromeControllerError("IO_FAILURE");
    } finally {
      if (ownsLock) await guard.finish();
    }
  }

  private async switchOwnedToHeadedOnce(): Promise<ChromeSession> {
    const paths = await this.adapter.preparePaths();
    const guard = new ChromeLockGuard(await this.adapter.acquireLock(paths));
    const held = { paths, guard };
    try {
      const observed = await this.observe(
        paths,
        undefined,
        this.adapter.monotonicNow() + OBSERVATION_BUDGET_MS,
      );
      const classified = classifyChrome(observed);
      if (classified.kind === "refuse") throw refusal(classified.code);
      if (classified.kind === "reuse" && classified.visibility === "headed") {
        return session(classified, true);
      }
      if (classified.kind === "reuse") {
        const expected = observed.record.kind === "valid" ? observed.record.value : undefined;
        if (expected === undefined || (expected.visibility ?? "headed") !== "headless") {
          throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
        }
        await this.closeOwnedOnce(expected, held);
      }
      const headed = await this.ensureRunningOnce("headed", held);
      if (headed.ownership !== "owned" || headed.visibility !== "headed") {
        throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
      }
      return headed;
    } finally {
      await guard.finish();
    }
  }

  async closeOwned(): Promise<void> {
    try {
      await this.closeOwnedOnce();
    } catch (error) {
      throw compactError(error);
    }
  }

  private async closeOwnedOnce(
    expected?: OwnershipRecord,
    held?: HeldChromeLock,
  ): Promise<void> {
    const ownsLock = held === undefined;
    const paths = held?.paths ?? await this.adapter.preparePaths();
    const guard = held?.guard ?? new ChromeLockGuard(await this.adapter.acquireLock(paths));

    const guardMutation = async <T>(deadline: number, promise: Promise<T>): Promise<T> => {
      try {
        return await this.raceMutation(deadline, promise);
      } catch (error) {
        if (error instanceof ChromeControllerError && error.code === "READINESS_TIMEOUT") {
          guard.defer(promise.then(() => {}, () => {}) as Promise<void>);
        }
        throw error;
      }
    };

    try {
      const observed = await this.observe(
        paths,
        undefined,
        this.adapter.monotonicNow() + OBSERVATION_BUDGET_MS,
      );
      const classified = classifyChrome(observed);
      if (classified.kind === "launch") {
        if (expected !== undefined) throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
        return;
      }
      if (classified.kind === "refuse") throw refusal(classified.code);
      const owned = observed.record.kind === "valid" ? observed.record.value : undefined;
      if (owned === undefined) throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
      if (expected !== undefined && !ownershipRecordEqual(owned, expected)) {
        throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
      }
      const current = await this.observe(
        paths,
        undefined,
        this.adapter.monotonicNow() + OBSERVATION_BUDGET_MS,
      );
      const currentProof = classifyChrome(current);
      if (currentProof.kind !== "reuse"
        || currentProof.pid !== classified.pid
        || current.record.kind !== "valid"
        || !ownershipRecordEqual(current.record.value, owned)) {
        throw new ChromeControllerError("AMBIGUOUS_OWNERSHIP");
      }
      const signalDeadline = this.adapter.monotonicNow() + CLOSE_SIGNAL_BUDGET_MS;
      await guardMutation(signalDeadline, this.adapter.signal(classified.pid, "SIGTERM", CLOSE_SIGNAL_BUDGET_MS));
      const deadline = this.adapter.monotonicNow() + CHILD_CLEANUP_WAIT_BUDGET_MS;
      while (this.adapter.monotonicNow() < deadline
        && await this.adapter.isLive(classified.pid, deadline - this.adapter.monotonicNow())) {
        await this.adapter.sleep(Math.min(
          this.pollIntervalMs,
          Math.max(1, deadline - this.adapter.monotonicNow()),
        ));
      }
      if (await this.adapter.isLive(classified.pid, Math.max(1, deadline - this.adapter.monotonicNow()))) {
        throw new ChromeControllerError("CLOSE_TIMEOUT");
      }
      const closeStateDeadline = this.adapter.monotonicNow() + CLOSE_STATE_REMOVAL_BUDGET_MS;
      await guardMutation(closeStateDeadline, this.adapter.removeStaleState(paths, owned.launchNonce, CLOSE_STATE_REMOVAL_BUDGET_MS));
    } finally {
      if (ownsLock) await guard.finish();
    }
  }
}
