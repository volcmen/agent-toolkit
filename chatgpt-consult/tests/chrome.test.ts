import { describe, expect, test } from "bun:test";
import { closeSync, constants as fsConstants, ftruncateSync, fsyncSync, openSync, writeSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyChrome,
  parseDevToolsActivePort,
  parseVersionResponse,
  resolveChromePaths,
} from "../src/browser/cdp";
import {
  ChromeController,
  ChromeControllerError,
  LOCK_ACQUISITION_TIMEOUT_MS,
  MAXIMUM_HOLDER_SUM_MS,
  acquireFileLaunchLock,
  buildBroadPgrepArgv,
  canonicalUserDirValue,
  ownershipRecordEqual,
  parseDarwinProcessBirth,
  parseLinuxProcessBirth,
  parseLsofListenerOutput,
  parsePgrepPidOutput,
  prepareChromePathsSecure,
  runBoundedDiagnosticResult,
  runBoundedProcessProbe,
  runBeforeChromeDeadline,
  runProfileProcessDiscovery,
  selectProfileProcess,
  validateChromeTimingOptions,
  type ChromeAdapter,
} from "../src/browser/chrome";

const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = "/Users/test/.config/chatgpt-consult/chrome-profile";
const webSocketUrl = "ws://127.0.0.1:43210/devtools/browser/owned-browser";
const processBirth = { kind: "linux-proc-start-ticks" as const, value: "123456" };

const record = {
  schemaVersion: 1 as const,
  pid: 123,
  executable,
  profileDir,
  launchNonce: "0123456789abcdef0123456789abcdef",
  startedAt: "2026-08-30T08:00:00.000Z",
  port: 43210,
  webSocketUrl,
  processBirth,
  visibility: "headless" as const,
};

const directory = { kind: "directory" as const, owned: true, mode: 0o700 };

const healthy = {
  config: directory,
  profile: directory,
  record: { kind: "valid" as const, value: record },
  process: {
    live: true,
    pid: 123,
    executable,
    argv: [executable, `--user-data-dir=${profileDir}`, "--headless=new"],
    processBirth,
  },
  listener: { host: "127.0.0.1", port: 43210, pid: 123 },
  activePort: { kind: "valid" as const, port: 43210, path: "/devtools/browser/owned-browser" },
  version: { kind: "valid" as const, webSocketUrl },
  profilePath: profileDir,
};

const clean = {
  config: directory,
  profile: directory,
  record: { kind: "absent" as const },
  process: null,
  listener: null,
  activePort: null,
  version: null,
  profilePath: profileDir,
};

describe("Chrome ownership classifier", () => {
  test("launches only when no ownership evidence or listener can be confused with ours", () => {
    expect(classifyChrome(clean)).toEqual({ kind: "launch" });
  });

  test("reuses only when record, process, profile, listener, and endpoint all agree", () => {
    expect(classifyChrome(healthy)).toEqual({
      kind: "reuse",
      pid: 123,
      port: 43210,
      webSocketUrl,
      profileDir,
      visibility: "headless",
    });
  });

  test("treats a legacy record without visibility as headed and proves that from argv", () => {
    const { visibility: _visibility, ...legacyRecord } = record;
    const legacy = {
      ...healthy,
      record: { kind: "valid" as const, value: legacyRecord },
      process: {
        ...healthy.process,
        argv: [executable, `--user-data-dir=${profileDir}`],
      },
    };
    expect(classifyChrome(legacy)).toEqual({
      kind: "reuse",
      pid: 123,
      port: 43210,
      webSocketUrl,
      profileDir,
      visibility: "headed",
    });
  });

  test("requires exact headless argv proof for the recorded visibility", () => {
    for (const argv of [
      [executable, `--user-data-dir=${profileDir}`],
      [executable, `--user-data-dir=${profileDir}`, "--headless"],
      [executable, `--user-data-dir=${profileDir}`, "--headless=old"],
      [executable, `--user-data-dir=${profileDir}`, "--headless=new", "--headless=new"],
    ]) {
      expect(classifyChrome({ ...healthy, process: { ...healthy.process, argv } }))
        .toEqual({ kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" });
    }
  });

  test("headed records reject every headless process flag", () => {
    const headedRecord = { ...record, visibility: "headed" as const };
    const headed = {
      ...healthy,
      record: { kind: "valid" as const, value: headedRecord },
      process: { ...healthy.process, argv: [executable, `--user-data-dir=${profileDir}`] },
    };
    expect(classifyChrome(headed)).toMatchObject({ kind: "reuse", visibility: "headed" });
    expect(classifyChrome({
      ...headed,
      process: { ...headed.process, argv: [...headed.process.argv, "--headless=new"] },
    })).toEqual({ kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("refuses a foreign PID on the recorded loopback listener", () => {
    expect(classifyChrome({ ...healthy, listener: { ...healthy.listener, pid: 999 } }))
      .toEqual({ kind: "refuse", code: "FOREIGN_LISTENER" });
  });

  test("refuses a live Chrome using any profile other than the canonical dedicated profile", () => {
    expect(classifyChrome({
      ...healthy,
      process: { ...healthy.process, argv: [executable, "--user-data-dir=/tmp/other"] },
    })).toEqual({ kind: "refuse", code: "PROFILE_CONFLICT" });
  });

  test("refuses a non-loopback WebSocket even when it otherwise looks like Chrome", () => {
    expect(classifyChrome({
      ...healthy,
      version: { kind: "valid", webSocketUrl: "ws://192.0.2.1:43210/devtools/browser/owned-browser" },
    })).toEqual({ kind: "refuse", code: "UNSAFE_ENDPOINT" });
  });

  test("refuses symlinked config, profile, or ownership state before mutation", () => {
    expect(classifyChrome({ ...clean, config: { kind: "symlink" } }))
      .toEqual({ kind: "refuse", code: "UNSAFE_CONFIG" });
    expect(classifyChrome({ ...clean, profile: { kind: "symlink" } }))
      .toEqual({ kind: "refuse", code: "PROFILE_CONFLICT" });
    expect(classifyChrome({ ...clean, record: { kind: "symlink" } }))
      .toEqual({ kind: "launch" });
    expect(classifyChrome({ ...healthy, record: { kind: "symlink" }, version: null }))
      .toEqual({ kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("refuses wrong-owner config, profile, and live ownership state", () => {
    expect(classifyChrome({ ...clean, config: { ...directory, owned: false } }))
      .toEqual({ kind: "refuse", code: "UNSAFE_CONFIG" });
    expect(classifyChrome({ ...clean, profile: { ...directory, owned: false } }))
      .toEqual({ kind: "refuse", code: "PROFILE_CONFLICT" });
    expect(classifyChrome({ ...healthy, record: { kind: "wrong-owner" }, version: null }))
      .toEqual({ kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("refuses private-looking directories that omit required owner access", () => {
    expect(classifyChrome({ ...clean, config: { ...directory, mode: 0o600 } }))
      .toEqual({ kind: "refuse", code: "UNSAFE_CONFIG" });
    expect(classifyChrome({ ...clean, profile: { ...directory, mode: 0o600 } }))
      .toEqual({ kind: "refuse", code: "PROFILE_CONFLICT" });
  });

  test("allows a user-owned permissive profile to reach the dedicated repair path", () => {
    expect(classifyChrome({ ...clean, profile: { ...directory, mode: 0o755 } }))
      .toEqual({ kind: "launch" });
  });

  test("removes stale dead-PID evidence only when no listener remains", () => {
    const dead = {
      ...healthy,
      process: { ...healthy.process, live: false },
      listener: null,
      activePort: null,
      version: null,
    };
    expect(classifyChrome(dead)).toEqual({ kind: "launch" });
    expect(classifyChrome({ ...dead, listener: healthy.listener }))
      .toEqual({ kind: "refuse", code: "FOREIGN_LISTENER" });
  });

  test("treats malformed and oversized records as stale only without live ambiguity", () => {
    for (const kind of ["malformed", "oversized"] as const) {
      expect(classifyChrome({ ...clean, record: { kind } })).toEqual({ kind: "launch" });
      expect(classifyChrome({ ...healthy, record: { kind }, version: null }))
        .toEqual({ kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" });
    }
  });

  test("refuses PID, executable, argv, listener, active-port, and endpoint identity mismatches", () => {
    const mutations = [
      { ...healthy, process: { ...healthy.process, pid: 124 } },
      { ...healthy, process: { ...healthy.process, executable: "/usr/bin/chromium" } },
      { ...healthy, process: { ...healthy.process, argv: [executable] } },
      { ...healthy, listener: null },
      { ...healthy, activePort: { kind: "valid" as const, port: 43211, path: healthy.activePort.path } },
      { ...healthy, version: { kind: "valid" as const, webSocketUrl: "ws://127.0.0.1:43210/devtools/browser/other" } },
    ];
    for (const observation of mutations) {
      expect(classifyChrome(observation).kind).toBe("refuse");
    }
  });

  test("refuses malformed active-port and version endpoint observations for a live record", () => {
    expect(classifyChrome({ ...healthy, activePort: { kind: "malformed" } }))
      .toEqual({ kind: "refuse", code: "UNSAFE_ENDPOINT" });
    expect(classifyChrome({ ...healthy, version: { kind: "malformed" } }))
      .toEqual({ kind: "refuse", code: "UNSAFE_ENDPOINT" });
  });

  test("refuses PID reuse when the OS process-birth identity changed", () => {
    expect(classifyChrome({
      ...healthy,
      process: {
        ...healthy.process,
        processBirth: { kind: "linux-proc-start-ticks", value: "654321" },
      },
    })).toEqual({ kind: "refuse", code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("requires the controller canonical profile even when record and process agree", () => {
    expect(classifyChrome({ ...healthy, profilePath: null }))
      .toEqual({ kind: "refuse", code: "PROFILE_CONFLICT" });
    const foreignProfile = "/tmp/foreign-profile";
    expect(classifyChrome({
      ...healthy,
      profilePath: profileDir,
      record: { kind: "valid", value: { ...record, profileDir: foreignProfile } },
      process: {
        ...healthy.process,
        argv: [executable, `--user-data-dir=${foreignProfile}`],
      },
    })).toEqual({ kind: "refuse", code: "PROFILE_CONFLICT" });
  });

  test("refuses a responding version endpoint without matching live ownership evidence", () => {
    expect(classifyChrome({
      ...clean,
      version: { kind: "valid", webSocketUrl },
    })).toEqual({ kind: "refuse", code: "UNSAFE_ENDPOINT" });
    expect(classifyChrome({
      ...healthy,
      process: { ...healthy.process, live: false },
      listener: null,
    })).toEqual({ kind: "refuse", code: "UNSAFE_ENDPOINT" });
  });
});

describe("bounded CDP parsing", () => {
  test("accepts one decimal port and one matching browser path", () => {
    expect(parseDevToolsActivePort("43210\n/devtools/browser/owned-browser\n")).toEqual({
      kind: "valid",
      port: 43210,
      path: "/devtools/browser/owned-browser",
    });
  });

  test("rejects extra lines, NUL, invalid ports, and non-browser paths", () => {
    for (const value of [
      "43210\n/devtools/browser/id\nextra\n",
      "43210\n/devtools/browser/id\0\n",
      "0\n/devtools/browser/id\n",
      "65536\n/devtools/browser/id\n",
      "43210\n/devtools/page/id\n",
      "43210\n/devtools/browser/\n",
    ]) expect(parseDevToolsActivePort(value)).toEqual({ kind: "malformed" });
  });

  test("accepts only a strict loopback WebSocket matching the active endpoint", () => {
    expect(parseVersionResponse(JSON.stringify({ webSocketDebuggerUrl: webSocketUrl }), 43210,
      "/devtools/browser/owned-browser")).toEqual({ kind: "valid", webSocketUrl });
    for (const value of [
      "not json",
      JSON.stringify({ webSocketDebuggerUrl: "wss://127.0.0.1:43210/devtools/browser/owned-browser" }),
      JSON.stringify({ webSocketDebuggerUrl: "ws://localhost:43210/devtools/browser/owned-browser" }),
      JSON.stringify({ webSocketDebuggerUrl: "ws://user@127.0.0.1:43210/devtools/browser/owned-browser" }),
      JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:43211/devtools/browser/owned-browser" }),
      JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:43210/devtools/browser/other" }),
      JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:43210/devtools/browser/owned-browser#fragment" }),
    ]) expect(parseVersionResponse(value, 43210, "/devtools/browser/owned-browser"))
      .toEqual({ kind: "malformed" });
  });

  test("treats an omitted ws port as effective port 80 only", () => {
    const value = JSON.stringify({
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/owned-browser",
    });
    expect(parseVersionResponse(value, 80, "/devtools/browser/owned-browser"))
      .toEqual({
        kind: "valid",
        webSocketUrl: "ws://127.0.0.1/devtools/browser/owned-browser",
      });
    expect(parseVersionResponse(value, 81, "/devtools/browser/owned-browser"))
      .toEqual({ kind: "malformed" });
  });
});

describe("production discovery parsing", () => {
  test("strictly parses bounded Linux and macOS process-birth proofs", () => {
    const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "987654", "0"];
    expect(parseLinuxProcessBirth(`123 (Google Chrome) ${fields.join(" ")}\n`)).toEqual({
      kind: "linux-proc-start-ticks",
      value: "987654",
    });
    expect(parseLinuxProcessBirth("123 (broken) S 0 0\n")).toBeNull();
    expect(parseDarwinProcessBirth("Sun Aug 30 19:30:45 2026\n")).toEqual({
      kind: "darwin-ps-start",
      value: "Sun Aug 30 19:30:45 2026",
    });
    expect(parseDarwinProcessBirth("locale-dependent-or-truncated")).toBeNull();
  });

  test("returns found only for one strict lsof listener record", () => {
    expect(parseLsofListenerOutput("p123\nn127.0.0.1:43210\n", 43210)).toEqual({
      kind: "found",
      listener: { host: "127.0.0.1", port: 43210, pid: 123 },
    });
    expect(parseLsofListenerOutput("p123\nf3\nn127.0.0.1:43210\n", 43210)).toEqual({
      kind: "found",
      listener: { host: "127.0.0.1", port: 43210, pid: 123 },
    });
    for (const output of [
      "",
      "p123\np999\nn127.0.0.1:43210\n",
      "pwat\nn127.0.0.1:43210\n",
      "p99999999999999999999\nn127.0.0.1:43210\n",
      "p123\nntruncated\n",
      "p123\nn127.0.0.1:43211\n",
      "x".repeat(70_000),
    ]) expect(parseLsofListenerOutput(output, 43210)).toEqual({ kind: "ambiguous" });
  });

  test("strictly parses pgrep PIDs and rejects empty, duplicate, malformed, and overflow output", () => {
    expect(parsePgrepPidOutput("123\n456\n")).toEqual({ kind: "found", pids: [123, 456] });
    for (const output of [
      "", "123\n123\n", "0\n", "123 extra\n", "99999999999999999999\n", "9".repeat(70_000),
    ]) {
      expect(parsePgrepPidOutput(output)).toEqual({ kind: "ambiguous" });
    }
  });

  test("accepts a machine-wide crowd of matches and bounds only at the line cap", () => {
    const crowd = Array.from({ length: 200 }, (_, index) => String(index + 2)).join("\n");
    const parsed = parsePgrepPidOutput(`${crowd}\n`);
    expect(parsed.kind).toBe("found");
    if (parsed.kind === "found") expect(parsed.pids).toHaveLength(200);
    const overflow = Array.from({ length: 513 }, (_, index) => String(index + 2)).join("\n");
    expect(parsePgrepPidOutput(`${overflow}\n`)).toEqual({ kind: "ambiguous" });
  });

  test("fails closed when a discovered profile-process candidate cannot be inspected", async () => {
    const passthrough = async (p: string, _b: number) => p;
    const remaining = () => 10_000;
    expect(await selectProfileProcess([123], profileDir, undefined, async () => null, passthrough, remaining))
      .toEqual({ kind: "ambiguous" });
    expect(await selectProfileProcess([123, 456], profileDir, undefined, async (pid) => ({
      ...healthy.process,
      pid,
    }), passthrough, remaining)).toEqual({ kind: "ambiguous" });
  });
});

describe("ownership record equality", () => {
  test("returns true for the exact same record by every declared field", () => {
    expect(ownershipRecordEqual(record, record)).toBe(true);
    expect(ownershipRecordEqual(record, { ...record })).toBe(true);
    expect(ownershipRecordEqual(record, { ...record, processBirth: { ...processBirth } })).toBe(true);
  });

  test("each individual declared field difference is unequal", () => {
    expect(ownershipRecordEqual(record, { ...record, schemaVersion: 0 as any })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, pid: 124 })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, executable: "/other" })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, profileDir: "/other" })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, launchNonce: "ffffffffffffffffffffffffffffffff" })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, startedAt: "2026-08-30T09:00:00.000Z" })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, port: 43211 })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, webSocketUrl: "ws://127.0.0.1:43211/devtools/browser/other" })).toBe(false);
    expect(ownershipRecordEqual(record, { ...record, visibility: "headed" })).toBe(false);
    expect(ownershipRecordEqual(record, {
      ...record,
      processBirth: { kind: "darwin-ps-start", value: processBirth.value },
    })).toBe(false);
    expect(ownershipRecordEqual(record, {
      ...record,
      processBirth: { kind: processBirth.kind, value: "654321" },
    })).toBe(false);
  });
});

describe("canonical user-data-dir value", () => {
  test("extracts absolute values and rejects empty, NUL, and relative", () => {
    expect(canonicalUserDirValue("--user-data-dir=/abs/path")).toBe("/abs/path");
    expect(canonicalUserDirValue("--user-data-dir=")).toBeNull();
    expect(canonicalUserDirValue("--user-data-dir=relative/path")).toBeNull();
    expect(canonicalUserDirValue("--other-flag=/abs")).toBeNull();
    expect(canonicalUserDirValue("--user-data-dir=/path\0hidden")).toBeNull();
  });
});

describe("alias-aware profile process discovery", () => {
  const passthrough = async (p: string, _b: number) => p;
  const remaining = () => 10_000;

  test("matches /./, /../, and trailing-slash aliases via canonicalization", async () => {
    for (const alias of [
      `${profileDir}/./sub/..`,
      `${profileDir}/extra/../`,
      `${profileDir}/`,
    ]) {
      const canonicalizer = async (p: string, _b: number) => p === alias ? profileDir : p;
      const candidate = {
        ...healthy.process,
        argv: [executable, `--user-data-dir=${alias}`],
      };
      expect(await selectProfileProcess(
        [123], profileDir, undefined,
        async () => candidate, canonicalizer, remaining,
      )).toEqual({ kind: "found", process: candidate });
    }
  });

  test("ignores a canonical other profile", async () => {
    const otherProfile = "/Users/test/.config/chatgpt-consult/other-profile";
    const candidate = {
      ...healthy.process,
      argv: [executable, `--user-data-dir=${otherProfile}`],
    };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, passthrough, remaining,
    )).toEqual({ kind: "absent" });
  });

  test("two matching aliases are ambiguous", async () => {
    const alias1 = `${profileDir}/alias1`;
    const alias2 = `${profileDir}/alias2`;
    const canonicalizer = async (p: string, _b: number) =>
      (p === alias1 || p === alias2) ? profileDir : p;
    const c1 = { ...healthy.process, pid: 123, argv: [executable, `--user-data-dir=${alias1}`] };
    const c2 = { ...healthy.process, pid: 456, argv: [executable, `--user-data-dir=${alias2}`] };
    expect(await selectProfileProcess(
      [123, 456], profileDir, undefined,
      async (pid) => pid === 123 ? c1 : c2, canonicalizer, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("zero --user-data-dir flags is ambiguous", async () => {
    const candidate = { ...healthy.process, argv: [executable] };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("multiple --user-data-dir flags is ambiguous", async () => {
    const candidate = {
      ...healthy.process,
      argv: [executable, `--user-data-dir=${profileDir}`, `--user-data-dir=${profileDir}`],
    };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("empty --user-data-dir value is ambiguous", async () => {
    const candidate = { ...healthy.process, argv: [executable, "--user-data-dir="] };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("relative --user-data-dir value is ambiguous", async () => {
    const candidate = { ...healthy.process, argv: [executable, "--user-data-dir=relative/path"] };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("canonicalization failure is ambiguous", async () => {
    const failing = async (_p: string, _b: number) => { throw new Error("ENOENT"); };
    const candidate = {
      ...healthy.process,
      argv: [executable, `--user-data-dir=${profileDir}`],
    };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, failing, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("skips a foreign candidate whose user-data-dir cannot be canonicalized", async () => {
    const foreign = "/Users/test/Library/Application";
    const canonicalizer = async (p: string, _b: number) => {
      if (p === foreign) throw new Error("ENOENT");
      return p;
    };
    const candidate = { ...healthy.process, argv: [executable, `--user-data-dir=${foreign}`] };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, canonicalizer, remaining,
    )).toEqual({ kind: "absent" });
  });

  test("finds the owner beside a foreign candidate that fails canonicalization", async () => {
    const foreign = "/Users/test/Library/Application";
    const canonicalizer = async (p: string, _b: number) => {
      if (p === foreign) throw new Error("ENOENT");
      return p;
    };
    const owner = { ...healthy.process, pid: 456 };
    const foreignCandidate = { ...healthy.process, pid: 123, argv: [executable, `--user-data-dir=${foreign}`] };
    expect(await selectProfileProcess(
      [123, 456], profileDir, undefined,
      async (pid) => pid === 123 ? foreignCandidate : owner, canonicalizer, remaining,
    )).toEqual({ kind: "found", process: owner });
  });

  test("a failed canonicalization that prefixes the target profile is ambiguous", async () => {
    const truncated = profileDir.slice(0, 20);
    const canonicalizer = async (p: string, _b: number) => {
      if (p === truncated) throw new Error("ENOENT");
      return p;
    };
    const candidate = { ...healthy.process, argv: [executable, `--user-data-dir=${truncated}`] };
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => candidate, canonicalizer, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("skips chromium helper processes carrying a --type flag", async () => {
    const helper = {
      ...healthy.process,
      pid: 456,
      argv: [executable, "--type=gpu-process", `--user-data-dir=${profileDir}`],
    };
    expect(await selectProfileProcess(
      [456], profileDir, undefined,
      async () => helper, passthrough, remaining,
    )).toEqual({ kind: "absent" });
    const main = { ...healthy.process, pid: 123 };
    expect(await selectProfileProcess(
      [123, 456], profileDir, undefined,
      async (pid) => pid === 123 ? main : helper, passthrough, remaining,
    )).toEqual({ kind: "found", process: main });
  });

  test("uninspectable candidate is ambiguous", async () => {
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => null, passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => ({ ...healthy.process, processBirth: null }), passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
    expect(await selectProfileProcess(
      [123], profileDir, undefined,
      async () => ({ ...healthy.process, executable: "" }), passthrough, remaining,
    )).toEqual({ kind: "ambiguous" });
  });

  test("canonicalization READINESS_TIMEOUT propagates through discovery", async () => {
    const timeoutCanonicalizer = async (_p: string, _b: number) => {
      throw new ChromeControllerError("READINESS_TIMEOUT");
    };
    const candidate = {
      ...healthy.process,
      argv: [executable, `--user-data-dir=${profileDir}`],
    };
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => ({ status: 0, output: "123\n" }),
      async () => candidate,
      timeoutCanonicalizer,
      1000,
    )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });
});

describe("production discovery runner argv", () => {
  test("uses only the broad fixed --user-data-dir= pattern without the expected profile path", async () => {
    let capturedArgv: string[] = [];
    await runProfileProcessDiscovery(
      profileDir, undefined,
      async (argv) => { capturedArgv = argv; return { status: 1, output: "" }; },
      async () => null,
      async (p) => p,
      1000,
    );
    expect(capturedArgv).toEqual(["pgrep", "-f", "--", "--user-data-dir="]);
    expect(capturedArgv.join(" ")).not.toContain(profileDir);
    expect(capturedArgv).toEqual(buildBroadPgrepArgv());
  });

  test("runner READINESS_TIMEOUT propagates unchanged", async () => {
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => { throw new ChromeControllerError("READINESS_TIMEOUT"); },
      async () => null,
      async (p) => p,
      1000,
    )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("inspection READINESS_TIMEOUT propagates through discovery", async () => {
    const candidate = {
      ...healthy.process,
      argv: [executable, `--user-data-dir=${profileDir}`],
    };
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => ({ status: 0, output: "123\n" }),
      async () => { throw new ChromeControllerError("READINESS_TIMEOUT"); },
      async (p) => p,
      1000,
    )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("runner reaching the exact shared deadline yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    const origNow = performance.now;
    performance.now = () => clock;
    try {
      await expect(runProfileProcessDiscovery(
        profileDir, undefined,
        async (_argv, budget) => { clock += budget; return { status: 0, output: "" }; },
        async () => null,
        async (p) => p,
        100,
      )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    } finally {
      performance.now = origNow;
    }
  });

  test("inspection reaching the exact shared deadline yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    const origNow = performance.now;
    performance.now = () => clock;
    try {
      await expect(runProfileProcessDiscovery(
        profileDir, undefined,
        async () => { clock += 10; return { status: 0, output: "123\n" }; },
        async (_pid, budget) => { clock += budget; return healthy.process; },
        async (p, _b) => { return p; },
        100,
      )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    } finally {
      performance.now = origNow;
    }
  });

  test("canonicalization reaching the exact shared deadline yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    const origNow = performance.now;
    performance.now = () => clock;
    try {
      await expect(runProfileProcessDiscovery(
        profileDir, undefined,
        async () => { clock += 10; return { status: 0, output: "123\n" }; },
        async () => healthy.process,
        async (_p, budget) => { clock += budget; return profileDir; },
        100,
      )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    } finally {
      performance.now = origNow;
    }
  });

  test("expected-profile early canonicalization failure yields AMBIGUOUS_OWNERSHIP", async () => {
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => ({ status: 0, output: "123\n" }),
      async () => healthy.process,
      async () => { throw new Error("ENOENT"); },
      1000,
    )).rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("generic runner rejection exactly at shared expiry yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    const origNow = performance.now;
    performance.now = () => clock;
    try {
      await expect(runProfileProcessDiscovery(
        profileDir, undefined,
        async (_argv, budget) => { clock += budget; throw new Error("boom"); },
        async () => null,
        async (p) => p,
        100,
      )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    } finally {
      performance.now = origNow;
    }
  });

  test("generic inspection rejection exactly at shared expiry yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    const origNow = performance.now;
    performance.now = () => clock;
    try {
      await expect(runProfileProcessDiscovery(
        profileDir, undefined,
        async () => { clock += 10; return { status: 0, output: "123\n" }; },
        async (_pid, budget) => { clock += budget; throw new Error("boom"); },
        async (p, _b) => p,
        100,
      )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    } finally {
      performance.now = origNow;
    }
  });

  test("generic candidate-canonicalization rejection exactly at shared expiry yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    const origNow = performance.now;
    performance.now = () => clock;
    try {
      await expect(runProfileProcessDiscovery(
        profileDir, undefined,
        async () => { clock += 10; return { status: 0, output: "123\n" }; },
        async () => healthy.process,
        async (_p, budget) => { clock += budget; throw new Error("boom"); },
        100,
      )).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    } finally {
      performance.now = origNow;
    }
  });

  test("early generic runner rejection keeps IO_FAILURE", async () => {
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => { throw new Error("boom"); },
      async () => null,
      async (p) => p,
      1000,
    )).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test("early generic inspection rejection keeps AMBIGUOUS_OWNERSHIP", async () => {
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => ({ status: 0, output: "123\n" }),
      async () => { throw new Error("boom"); },
      async (p) => p,
      1000,
    )).rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("early generic candidate-canonicalization rejection keeps AMBIGUOUS_OWNERSHIP", async () => {
    await expect(runProfileProcessDiscovery(
      profileDir, undefined,
      async () => ({ status: 0, output: "123\n" }),
      async () => healthy.process,
      async () => { throw new Error("boom"); },
      1000,
    )).rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
  });

  test("canonicalizer budgets shrink across two candidates", async () => {
    let clock = 1000;
    const origNow = performance.now;
    performance.now = () => clock;
    const budgets: number[] = [];
    const c1 = { ...healthy.process, pid: 100, argv: [executable, `--user-data-dir=/other`] };
    const c2 = { ...healthy.process, pid: 200, argv: [executable, `--user-data-dir=${profileDir}`] };
    try {
      await selectProfileProcess(
        [100, 200], profileDir, undefined,
        async (pid) => pid === 100 ? c1 : c2,
        async (p, b) => { budgets.push(b); clock += 1; return p; },
        () => { const v = 10_000 - (clock - 1000); return v > 0 ? v : 0; },
      );
    } finally {
      performance.now = origNow;
    }
    expect(budgets.length).toBe(2);
    expect(budgets[0]!).toBeGreaterThan(budgets[1]!);
    expect(budgets[1]!).toBeGreaterThan(0);
  });
});

describe("bounded diagnostic child cleanup", () => {
  const childFixture = (
    stream: ReadableStream<Uint8Array>,
    options: { exitOnSignal?: "SIGTERM" | "SIGKILL" } = {},
  ) => {
    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    let reaped = false;
    let resolveExit!: (status: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const exitOnSignal = options.exitOnSignal ?? "SIGTERM";
    return {
      child: {
        stdout: stream,
        exited: exited.then((status) => { reaped = true; return status; }),
        kill: (signal: "SIGTERM" | "SIGKILL") => {
          signals.push(signal);
          if (signal === exitOnSignal) resolveExit(0);
        },
      },
      state: () => ({ signals, reaped }),
    };
  };

  test("terminates, cancels stdout, and reaps after deterministic timeout", async () => {
    let cancelled = false;
    const fixture = childFixture(new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
    }));
    let deadlineCalls = 0;
    await expect(runBoundedDiagnosticResult(fixture.child, {
      timeoutMs: 100,
      maximumBytes: 16,
      cleanupTimeoutMs: 100,
      awaitDeadline: async (work) => {
        deadlineCalls++;
        if (deadlineCalls === 1) throw new Error("injected timeout");
        return work;
      },
    })).rejects.toThrow("Bounded subprocess failed");
    expect({ ...fixture.state(), cancelled }).toEqual({
      signals: ["SIGTERM"],
      reaped: true,
      cancelled: true,
    });
  });

  test("terminates, cancels stdout, and reaps after output overflow", async () => {
    let cancelled = false;
    const fixture = childFixture(new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(17)),
      cancel: () => { cancelled = true; },
    }));
    await expect(runBoundedDiagnosticResult(fixture.child, {
      timeoutMs: 100,
      maximumBytes: 16,
      cleanupTimeoutMs: 100,
    })).rejects.toThrow("Bounded subprocess failed");
    expect({ ...fixture.state(), cancelled }).toEqual({
      signals: ["SIGTERM"],
      reaped: true,
      cancelled: true,
    });
  });

  test("escalates to SIGKILL when child ignores SIGTERM, then reaps", async () => {
    let cancelled = false;
    const fixture = childFixture(new ReadableStream<Uint8Array>({
      cancel: () => { cancelled = true; },
    }), { exitOnSignal: "SIGKILL" });
    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    const origKill = fixture.child.kill;
    fixture.child.kill = (signal) => { signals.push(signal); origKill(signal); };
    await expect(runBoundedDiagnosticResult(fixture.child, {
      timeoutMs: 50,
      maximumBytes: 16,
      cleanupTimeoutMs: 400,
    })).rejects.toThrow("Bounded subprocess failed");
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(fixture.state().reaped).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("overflow escalates to SIGKILL when child ignores SIGTERM", async () => {
    let cancelled = false;
    const fixture = childFixture(new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(17)),
      cancel: () => { cancelled = true; },
    }), { exitOnSignal: "SIGKILL" });
    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    const origKill = fixture.child.kill;
    fixture.child.kill = (signal) => { signals.push(signal); origKill(signal); };
    await expect(runBoundedDiagnosticResult(fixture.child, {
      timeoutMs: 50,
      maximumBytes: 16,
      cleanupTimeoutMs: 400,
    })).rejects.toThrow("Bounded subprocess failed");
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(fixture.state().reaped).toBe(true);
    expect(cancelled).toBe(true);
  });
});

describe("production launch lock", () => {
  const withLockRoot = async (run: (root: string) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-lock-"));
    try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
  };

  const lockOptions = (lockPath: string, nonce: string, overrides: Record<string, unknown> = {}) => {
    let clock = 0;
    return {
      lockPath,
      pid: 700,
      processBirth,
      nonce,
      createdAt: "2026-08-30T19:00:00.000Z",
      monotonicNow: () => clock,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
      acquisitionTimeoutMs: 500,
      ...overrides,
    };
  };

  test("kernel flock never allows two holders and has no pathname unlink surface", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      let clock = 0;
      let active = 0;
      let maximumActive = 0;
      const yieldSleep = async (ms: number) => {
        clock += ms;
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      const worker = async (nonce: string) => {
        const lock = await acquireFileLaunchLock(lockOptions(lockPath, nonce, {
          monotonicNow: () => clock,
          sleep: yieldSleep,
          acquisitionTimeoutMs: 5_000,
        }));
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        await lock.release();
      };
      await Promise.all([
        worker("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        worker("cccccccccccccccccccccccccccccccc"),
      ]);
      expect(maximumActive).toBe(1);
      const entries = await readdir(root);
      expect(entries).toEqual(["chrome-launch.lock"]);
    });
  });

  test("active holder paused after partial lease excludes second contender", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      let resumeWrite!: () => void;
      const writePaused = new Promise<void>((resolve) => { resumeWrite = resolve; });
      let writeStarted = false;

      const firstPromise = acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        acquisitionTimeoutMs: 5_000,
        writeLease: async (fd: number, content: string) => {
          writeStarted = true;
          writeSync(fd, content.slice(0, 3));
          await writePaused;
          ftruncateSync(fd, 0);
          writeSync(fd, content);
          fsyncSync(fd);
        },
      }));

      while (!writeStarted) await new Promise((resolve) => setTimeout(resolve, 2));

      let clock = 0;
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
        monotonicNow: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        acquisitionTimeoutMs: 100,
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      resumeWrite();
      const firstLock = await firstPromise;
      await firstLock.release();
    });
  });

  test("closing partial holder descriptor allows next contender to acquire and replace partial lease", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        writeLease: async (fd: number, content: string) => {
          writeSync(fd, content.slice(0, 3));
          throw new Error("crash");
        },
      }))).rejects.toMatchObject({ code: "IO_FAILURE" });

      const lock = await acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      const content = await (await import("node:fs/promises")).readFile(lockPath, "utf8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.nonce).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      await lock.release();
    });
  });

  test("waits beyond two seconds for a holder; unknown lease metadata does not authorize a second holder; release and retain are idempotent", async () => {
    await withLockRoot(async (root) => {
      expect(LOCK_ACQUISITION_TIMEOUT_MS).toBeGreaterThan(12_000);
      const lockPath = join(root, "chrome-launch.lock");

      const first = await acquireFileLaunchLock(lockOptions(lockPath, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", {
        acquisitionTimeoutMs: 10_000,
      }));

      let clock = 0;
      let released = false;
      const second = await acquireFileLaunchLock(lockOptions(lockPath, "ffffffffffffffffffffffffffffffff", {
        monotonicNow: () => clock,
        sleep: async (milliseconds: number) => {
          clock += milliseconds;
          if (!released && clock >= 2_500) {
            released = true;
            await first.release();
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        acquisitionTimeoutMs: 10_000,
      }));
      expect(clock).toBeGreaterThanOrEqual(2_500);

      await second.release();
      await second.release();
      await second.retain();
      await second.retain();

      await first.release();
      await first.release();
    });
  });

  test("lease write failure closes/unlocks without leaving candidate artifacts", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        writeLease: async () => { throw new Error("disk full"); },
      }))).rejects.toMatchObject({ code: "IO_FAILURE" });

      const entries = await readdir(root);
      expect(entries.sort()).toEqual(["chrome-launch.lock"]);

      const lock = await acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      await lock.release();
    });
  });

  test("rejects a permissive-mode lock file that is not 0600", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      await writeFile(lockPath, "", { mode: 0o644 });
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")))
        .rejects.toMatchObject({ code: "IO_FAILURE" });
    });
  });

  test("rejects a directory at the lock pathname", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      await mkdir(lockPath, { mode: 0o700 });
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")))
        .rejects.toMatchObject({ code: "IO_FAILURE" });
    });
  });

  test("rejects a symlinked lock pathname", async () => {
    await withLockRoot(async (root) => {
      const realPath = join(root, "real.lock");
      const linkPath = join(root, "chrome-launch.lock");
      await writeFile(realPath, "", { mode: 0o600 });
      await symlink(realPath, linkPath);
      await expect(acquireFileLaunchLock(lockOptions(linkPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")))
        .rejects.toMatchObject({ code: "IO_FAILURE" });
    });
  });

  test("rejects a lock namespace swap between open and flock", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      const swappedPath = join(root, "swapped.lock");
      let beforeFlockCalled = false;
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        beforeFlock: async () => {
          beforeFlockCalled = true;
          await rename(lockPath, swappedPath);
          await writeFile(lockPath, "different-file", { mode: 0o600 });
        },
      }))).rejects.toMatchObject({ code: "IO_FAILURE" });
      expect(beforeFlockCalled).toBe(true);
    });
  });

  test("retained lock blocks a contender until explicit release", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      const first = await acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        acquisitionTimeoutMs: 5_000,
      }));
      await first.retain();
      await first.retain();

      let clock = 0;
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
        monotonicNow: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        acquisitionTimeoutMs: 100,
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      await first.release();
      await first.release();
      await first.retain();

      const second = await acquireFileLaunchLock(lockOptions(lockPath, "cccccccccccccccccccccccccccccccc"));
      await second.release();
    });
  });

  test("late lease write releases the flock for a following contender", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      let clock = 0;
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        monotonicNow: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        acquisitionTimeoutMs: 500,
        writeLease: async (fd: number, content: string) => {
          clock = 600;
          writeSync(fd, content);
          fsyncSync(fd);
        },
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      const lock = await acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      const content = await (await import("node:fs/promises")).readFile(lockPath, "utf8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.nonce).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      await lock.release();
    });
  });

  test("pending lease write holds flock until settled; successor waits then acquires", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      let resolveA!: () => void;
      const aPending = new Promise<void>((resolve) => { resolveA = resolve; });
      let aClock = 0;
      let deferredUnlockResolve!: () => void;
      const deferredUnlock = new Promise<void>((resolve) => { deferredUnlockResolve = resolve; });

      // Contender A: lease write remains pending, A returns LOCK_TIMEOUT at its deadline
      const aPromise = acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        monotonicNow: () => aClock,
        sleep: async (ms: number) => { aClock += ms; },
        acquisitionTimeoutMs: 200,
        writeLease: async (fd: number, content: string) => {
          await aPending;
          writeSync(fd, content);
          fsyncSync(fd);
        },
        afterDeferredUnlock: () => { deferredUnlockResolve(); },
      }));

      await expect(aPromise).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      // Contender B: times out while A's late write is still pending (flock still held)
      let bClock = 0;
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
        monotonicNow: () => bClock,
        sleep: async (ms: number) => { bClock += ms; },
        acquisitionTimeoutMs: 100,
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      // Settle A's write, wait for deterministic deferred-unlock signal
      resolveA();
      await deferredUnlock;

      // Contender C acquires; C's nonce is the final lease content
      const c = await acquireFileLaunchLock(lockOptions(lockPath, "cccccccccccccccccccccccccccccccc"));
      const content = await (await import("node:fs/promises")).readFile(lockPath, "utf8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.nonce).toBe("cccccccccccccccccccccccccccccccc");
      await c.release();
    });
  });

  const virtualAwaitDeadline = (clock: { value: number }) =>
    async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
      let settled = false;
      let result: T;
      let rejection: unknown;
      promise.then(
        (value) => { settled = true; result = value; },
        (error) => { settled = true; rejection = error; },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (settled) {
        if (rejection !== undefined) throw rejection;
        return result!;
      }
      clock.value += timeoutMs;
      throw new Error("timeout");
    };

  test("lease write that resolves exactly at the 500 ms lease boundary is rejected", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      const clock = { value: 0 };
      let deferredUnlockResolve!: () => void;
      const deferredUnlock = new Promise<void>((resolve) => { deferredUnlockResolve = resolve; });

      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        monotonicNow: () => clock.value,
        sleep: async (ms: number) => { clock.value += ms; },
        acquisitionTimeoutMs: 5_000,
        writeLease: async (fd: number, content: string) => {
          clock.value = 500;
          writeSync(fd, content);
          fsyncSync(fd);
        },
        awaitDeadline: virtualAwaitDeadline(clock),
        afterDeferredUnlock: () => { deferredUnlockResolve(); },
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      await deferredUnlock;
    });
  });

  test("never-resolving lease write receives exactly 500 ms from await seam and remains locked", async () => {
    await withLockRoot(async (root) => {
      const lockPath = join(root, "chrome-launch.lock");
      const clock = { value: 0 };
      let deferredUnlockResolve!: () => void;
      const deferredUnlock = new Promise<void>((resolve) => { deferredUnlockResolve = resolve; });
      let resolveLease!: () => void;
      const leasePending = new Promise<void>((resolve) => { resolveLease = resolve; });

      await expect(acquireFileLaunchLock(lockOptions(lockPath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        monotonicNow: () => clock.value,
        sleep: async (ms: number) => { clock.value += ms; },
        acquisitionTimeoutMs: 5_000,
        writeLease: async () => { await leasePending; },
        awaitDeadline: virtualAwaitDeadline(clock),
        afterDeferredUnlock: () => { deferredUnlockResolve(); },
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      expect(clock.value).toBe(500);

      let bClock = 0;
      await expect(acquireFileLaunchLock(lockOptions(lockPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
        monotonicNow: () => bClock,
        sleep: async (ms: number) => { bClock += ms; },
        acquisitionTimeoutMs: 50,
      }))).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

      resolveLease();
      await deferredUnlock;
    });
  });
});

describe("production Chrome filesystem preparation", () => {
  const withPathRoot = async (run: (root: string) => Promise<void>) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chatgpt-consult-paths-")));
    try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
  };
  const isAbsent = async (path: string) => {
    try { await access(path); return false; } catch { return true; }
  };

  test("creates each missing config/profile component privately", async () => {
    await withPathRoot(async (root) => {
      const configRoot = join(root, "nested", "config");
      const paths = await prepareChromePathsSecure({ CHATGPT_CONSULT_CONFIG_HOME: configRoot });
      expect(paths.configRoot).toBe(configRoot);
      expect((await stat(paths.configRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.profileDir)).mode & 0o777).toBe(0o700);
    });
  });

  test("never creates the config root through a symlinked ancestor", async () => {
    await withPathRoot(async (root) => {
      const outside = join(root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(root, "redirect"));
      await expect(prepareChromePathsSecure({
        CHATGPT_CONSULT_CONFIG_HOME: join(root, "redirect", "nested"),
      })).rejects.toMatchObject({ code: "UNSAFE_CONFIG" });
      expect(await isAbsent(join(outside, "nested"))).toBe(true);
    });
  });

  test("fails closed on an ancestor swap without mutating the replacement target", async () => {
    await withPathRoot(async (root) => {
      const parent = join(root, "parent");
      const moved = join(root, "original-parent");
      const outside = join(root, "outside");
      await mkdir(parent, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      let swapped = false;
      await expect(prepareChromePathsSecure(
        { CHATGPT_CONSULT_CONFIG_HOME: join(parent, "config") },
        {
          beforeCreate: async (openParent, component) => {
            if (!swapped && openParent === parent && component === "config") {
              swapped = true;
              await rename(parent, moved);
              await symlink(outside, parent);
            }
          },
        },
      )).rejects.toMatchObject({ code: "UNSAFE_CONFIG" });
      expect(swapped).toBe(true);
      expect(await isAbsent(join(outside, "config"))).toBe(true);
    });
  });
});

describe("Chrome controller", () => {
  class FakeAdapter implements ChromeAdapter {
    observations: any[] = [clean];
    spawned = 0;
    signals: Array<[number, "SIGTERM"]> = [];
    repairs: string[] = [];
    removals: Array<string | undefined> = [];
    writes: any[] = [];
    launchArgv: string[][] = [];
    lockCount = 0;
    releaseCount = 0;
    retainCount = 0;
    live = true;
    prepareError: Error | undefined;
    signalError: Error | undefined;
    writeError: Error | undefined;
    serialLock = false;
    persisted = false;
    private locked = false;
    private lockWaiters: Array<() => void> = [];
    nowValue = 0;
    wallNowValue = 0;
    waits = 0;
    fetchAdvanceMs = 0;
    writeAdvanceMs = 0;
    isLiveAdvanceMs = 0;
    spawnAdvanceMs = 0;
    findChromeAdvanceMs = 0;
    exitWaitResult = true;
    terminateLeavesLive = false;
    exitWaits: number[] = [];
    childUnrefs = 0;
    cleanupEvents: string[] = [];
    operationBudgets: number[] = [];
    repairBudgets: number[] = [];
    staleStateBudgets: number[] = [];
    findChromeBudgets: number[] = [];
    spawnChromeBudgets: number[] = [];
    signalBudgets: number[] = [];
    pendingRepair: Promise<void> | undefined;
    pendingStaleState: Promise<void> | undefined;
    pendingSpawn: Promise<import("../src/browser/chrome").SpawnedChrome> | undefined;
    pendingSignal: Promise<void> | undefined;
    pendingWriteOwnership: Promise<void> | undefined;
    childPid = 123;
    persistedObservation: any = healthy;

    async preparePaths() {
      if (this.prepareError) throw this.prepareError;
      return resolveChromePaths({ CHATGPT_CONSULT_CONFIG_HOME: "/Users/test/.config/chatgpt-consult" });
    }
    private observation() {
      if (this.persisted) return this.persistedObservation;
      return this.observations[Math.min(this.waits, this.observations.length - 1)];
    }
    async observePaths(_paths?: unknown, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      const value = this.observation();
      return { config: value.config, profile: value.profile };
    }
    async readOwnership(_paths?: unknown, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      return this.observation().record;
    }
    async readActivePort(_paths?: unknown, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      return this.observation().activePort;
    }
    async inspectProcess(_pid?: number, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      return this.observation().process;
    }
    async findProfileProcess(_profile?: string, _excluding?: number, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      return this.observation().process;
    }
    async inspectListener(_port?: number, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      return this.observation().listener;
    }
    async fetchVersion(_port?: number, _path?: string, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      this.nowValue += this.fetchAdvanceMs;
      return this.observation().version;
    }
    async repairProfile(path: string, budgetMs: number) {
      this.repairs.push(path);
      this.repairBudgets.push(budgetMs);
      if (this.pendingRepair) return this.pendingRepair;
    }
    async acquireLock() {
      this.lockCount++;
      if (this.serialLock) {
        while (this.locked) await new Promise<void>((resolve) => this.lockWaiters.push(resolve));
        this.locked = true;
      }
      return {
        release: async () => {
          this.cleanupEvents.push("release");
          this.releaseCount++;
          if (this.serialLock) {
            this.locked = false;
            this.lockWaiters.shift()?.();
          }
        },
        retain: async () => {
          this.cleanupEvents.push("retain");
          this.retainCount++;
        },
      };
    }
    async removeStaleState(_paths: unknown, nonce: string | undefined, budgetMs: number) {
      this.removals.push(nonce);
      this.staleStateBudgets.push(budgetMs);
      if (this.pendingStaleState) return this.pendingStaleState;
    }
    async findChrome(budgetMs: number) {
      this.findChromeBudgets.push(budgetMs);
      if (this.findChromeAdvanceMs >= budgetMs) {
        throw new ChromeControllerError("READINESS_TIMEOUT");
      }
      this.nowValue += this.findChromeAdvanceMs;
      return executable;
    }
    async spawnChrome(argv: string[], budgetMs: number) {
      this.spawned++;
      this.launchArgv.push(argv);
      this.spawnChromeBudgets.push(budgetMs);
      this.nowValue += this.spawnAdvanceMs;
      const child = {
        pid: this.childPid,
        hasExited: () => !this.live,
        terminate: (signal: "SIGTERM") => this.signal(this.childPid, signal, 500),
        waitForExit: async (timeoutMs: number) => {
          this.cleanupEvents.push("wait-exit");
          this.exitWaits.push(timeoutMs);
          if (this.exitWaitResult) this.live = false;
          return this.exitWaitResult;
        },
        unref: () => { this.childUnrefs += 1; },
      };
      if (this.pendingSpawn) return this.pendingSpawn;
      return child;
    }
    async writeOwnership(_paths: unknown, value: unknown, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      this.nowValue += this.writeAdvanceMs;
      this.writes.push(value);
      if (this.writeError) throw this.writeError;
      this.persisted = true;
      if (this.pendingWriteOwnership) return this.pendingWriteOwnership;
    }
    async signal(pid: number, signal: "SIGTERM", budgetMs: number) {
      this.signals.push([pid, signal]);
      this.signalBudgets.push(budgetMs);
      if (this.signalError) throw this.signalError;
      if (!this.terminateLeavesLive) this.live = false;
      if (this.pendingSignal) return this.pendingSignal;
    }
    async isLive(_pid?: number, budgetMs?: number) {
      if (budgetMs !== undefined) this.operationBudgets.push(budgetMs);
      this.nowValue += this.isLiveAdvanceMs;
      return this.live;
    }
    monotonicNow() { return this.nowValue; }
    wallNow() { return this.wallNowValue; }
    async sleep(milliseconds: number) { this.waits++; this.nowValue += milliseconds; }
    randomNonce() { return "0123456789abcdef0123456789abcdef"; }
  }

  test("resolves config precedence without rewriting HOME", () => {
    const source = { HOME: "/Users/home", XDG_CONFIG_HOME: "/Users/xdg", CHATGPT_CONSULT_CONFIG_HOME: "/Users/custom" };
    expect(resolveChromePaths(source).configRoot).toBe("/Users/custom");
    expect(resolveChromePaths({ HOME: source.HOME, XDG_CONFIG_HOME: source.XDG_CONFIG_HOME }).configRoot)
      .toBe("/Users/xdg/chatgpt-consult");
    expect(resolveChromePaths({ HOME: source.HOME }).configRoot)
      .toBe("/Users/home/.config/chatgpt-consult");
    expect(source.HOME).toBe("/Users/home");
    expect(() => resolveChromePaths({ HOME: "" })).toThrow();
    expect(() => resolveChromePaths({ CHATGPT_CONSULT_CONFIG_HOME: "bad\0root" })).toThrow();
  });

  test("rejects non-finite, non-positive, and over-ceiling readiness timing", () => {
    for (const options of [
      { readinessTimeoutMs: Infinity },
      { readinessTimeoutMs: 10_001 },
      { readinessTimeoutMs: 0 },
      { pollIntervalMs: Infinity },
      { pollIntervalMs: 0 },
      { pollIntervalMs: 1_001 },
    ]) expect(() => validateChromeTimingOptions(options)).toThrow(RangeError);
    expect(validateChromeTimingOptions({ readinessTimeoutMs: 10_000, pollIntervalMs: 200 }))
      .toEqual({ readinessTimeoutMs: 10_000, pollIntervalMs: 200 });
  });

  test("production deadline primitive passes remaining monotonic time and rejects post-expiry results", async () => {
    let now = 100;
    let receivedBudget = 0;
    await expect(runBeforeChromeDeadline(150, () => now, async (budget) => {
      receivedBudget = budget;
      now = 151;
      return "late";
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(receivedBudget).toBe(50);
    let called = false;
    await expect(runBeforeChromeDeadline(151, () => now, async () => {
      called = true;
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(called).toBe(false);
  });

  test("does not persist or return when a probe begun before readiness expiry finishes after it", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    adapter.fetchAdvanceMs = 200;
    await expect(new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 })
      .ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(adapter.writes).toHaveLength(0);
    expect(adapter.operationBudgets.every((budget) => budget > 0 && budget <= 10_000)).toBe(true);
    expect(adapter.operationBudgets.some((budget) => budget <= 400)).toBe(true);
  });

  test("passes the remaining readiness budget to the spawned-child liveness probe", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    adapter.isLiveAdvanceMs = 401;
    await expect(new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 })
      .ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(adapter.operationBudgets).toContain(400);
    expect(adapter.writes).toHaveLength(0);
  });

  test("process-probe seam passes the remaining budget and succeeds within it", async () => {
    let clock = 10;
    const budgets: number[] = [];
    const result = await runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async (_argv, budget) => {
        budgets.push(budget);
        clock += 10;
        if (budgets.length === 1) return { status: 0, output: "/usr/bin/chrome\n" };
        if (budgets.length === 2) return { status: 0, output: "/usr/bin/chrome --flag\n" };
        return { status: 0, output: "Sun Aug 30 19:30:45 2026\n" };
      },
    });
    expect(result.live).toBe(true);
    expect(result.pid).toBe(42);
    expect(budgets).toEqual([90, 80, 70]);
  });

  test("process-probe seam refuses a result that completes exactly at expiry", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => {
        clock = 100;
        return { status: 0, output: "ok\n" };
      },
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("process-probe seam propagates IO_FAILURE without converting to timeout", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => { throw new Error("subprocess boom"); },
    })).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test("Darwin sequential probes receive shrinking budgets", async () => {
    let clock = 0;
    const budgets: number[] = [];
    const result = await runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async (_argv, budget) => {
        budgets.push(budget);
        clock += 30;
        if (budgets.length === 1) return { status: 0, output: "/usr/bin/chrome\n" };
        if (budgets.length === 2) return { status: 0, output: "/usr/bin/chrome --flag\n" };
        return { status: 0, output: "Sun Aug 30 19:30:45 2026\n" };
      },
    });
    expect(budgets).toEqual([100, 70, 40]);
    expect(result.live).toBe(true);
    expect(result.executable).toBe("/usr/bin/chrome");
    expect(result.processBirth).toEqual({ kind: "darwin-ps-start", value: "Sun Aug 30 19:30:45 2026" });
  });

  test("Darwin probe at/after expiry yields READINESS_TIMEOUT and no later subprocess starts", async () => {
    let clock = 0;
    let probeCount = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => {
        probeCount++;
        clock += 100;
        return { status: 0, output: "/usr/bin/chrome\n" };
      },
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(probeCount).toBe(1);
  });

  test("Darwin diagnostic failure before expiry yields IO_FAILURE not timeout", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => {
        clock += 10;
        throw new Error("spawn failed");
      },
    })).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test("Darwin nonzero ps status refuses before accepting output", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => {
        clock += 5;
        return { status: 1, output: "" };
      },
    })).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test("Linux /proc missing evidence never invokes the Darwin runner", async () => {
    let clock = 0;
    let darwinProbeCalled = false;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "linux",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => {
        darwinProbeCalled = true;
        return { status: 0, output: "" };
      },
    })).rejects.toMatchObject({ code: "IO_FAILURE" });
    expect(darwinProbeCalled).toBe(false);
  });

  test("Linux filesystem step completing after expiry yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "linux",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => "link",
      readProcText: async () => null,
      canonicalize: async (_p) => {
        clock += 100;
        return "/usr/bin/chrome";
      },
      runProbe: async () => ({ status: 0, output: "" }),
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("Linux exhausted deadline starts no readProcExe call", async () => {
    let readProcExeCalled = false;
    await expect(runBoundedProcessProbe(42, 0, {
      platform: "linux",
      monotonicNow: () => 0,
      signalKill: () => undefined,
      readProcExe: async () => { readProcExeCalled = true; return "link"; },
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => ({ status: 0, output: "" }),
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(readProcExeCalled).toBe(false);
  });

  test("Linux readProcExe that advances to expiry then throws maps to READINESS_TIMEOUT", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "linux",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => { clock = 100; throw new Error("proc read timed out"); },
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => ({ status: 0, output: "" }),
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("Linux readProcExe null at deadline maps to READINESS_TIMEOUT not IO_FAILURE", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "linux",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => { clock = 100; return null; },
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => ({ status: 0, output: "" }),
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("Linux early raw readProcExe failure maps to IO_FAILURE", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "linux",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => { clock = 5; throw new Error("early boom"); },
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async () => ({ status: 0, output: "" }),
    })).rejects.toMatchObject({ code: "IO_FAILURE" });
  });

  test("Linux final identity cannot return if injected clock expires after last read boundary", async () => {
    let clock = 0;
    const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "987654", "0"];
    const statLine = `42 (Google Chrome) ${fields.join(" ")}\n`;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "linux",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => { clock = 10; return "link"; },
      readProcText: async (_pid, name) => {
        clock += 5;
        if (name === "cmdline") return { text: "/usr/bin/chrome\0--flag\0" };
        if (name === "stat") return { text: statLine };
        return null;
      },
      canonicalize: async (_p) => { clock = 90; return "/usr/bin/chrome"; },
      runProbe: async () => ({ status: 0, output: "" }),
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("Darwin diagnostic that advances clock to deadline then throws yields READINESS_TIMEOUT", async () => {
    let clock = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => p,
      runProbe: async (_argv, budget) => {
        clock += budget;
        throw new Error("subprocess timed out");
      },
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("Darwin canonicalization completing at the deadline cannot return identity", async () => {
    let clock = 0;
    let probeCalls = 0;
    await expect(runBoundedProcessProbe(42, 100, {
      platform: "darwin",
      monotonicNow: () => clock,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (_p) => {
        clock = 100;
        return "/usr/bin/chrome";
      },
      runProbe: async () => {
        probeCalls++;
        clock += 30;
        if (probeCalls === 1) return { status: 0, output: "/usr/bin/chrome\n" };
        if (probeCalls === 2) return { status: 0, output: "/usr/bin/chrome --flag\n" };
        return { status: 0, output: "Sun Aug 30 19:30:45 2026\n" };
      },
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("exhausted deadline does not start the first awaited operation", async () => {
    let probeCalled = false;
    let canonicalizeCalled = false;
    await expect(runBoundedProcessProbe(42, 0, {
      platform: "darwin",
      monotonicNow: () => 0,
      signalKill: () => undefined,
      readProcExe: async () => null,
      readProcText: async () => null,
      canonicalize: async (p) => { canonicalizeCalled = true; return p; },
      runProbe: async () => { probeCalled = true; return { status: 0, output: "" }; },
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(probeCalled).toBe(false);
  });

  test("removes a just-persisted attempt instead of returning after the deadline", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    adapter.writeAdvanceMs = 500;
    await expect(new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 })
      .ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(adapter.writes).toHaveLength(1);
    expect(adapter.removals.filter((value) => value !== undefined)).toEqual([record.launchNonce]);
  });

  test("reuses a fully proven session without spawning", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [healthy];
    const result = await new ChromeController({ adapter }).ensureRunning();
    expect(result).toEqual({
      pid: 123, port: 43210, webSocketUrl, profileDir, ownership: "owned",
      visibility: "headless", reused: true,
    });
    expect(adapter.spawned).toBe(0);
  });

  test("maps unexpected adapter failures to a compact error without leaking paths", async () => {
    const adapter = new FakeAdapter();
    adapter.prepareError = new Error("secret /Users/test/private/chrome-profile");
    const controller = new ChromeController({ adapter });
    await expect(controller.ensureRunning()).rejects.toMatchObject({
      code: "IO_FAILURE",
      message: "Chrome lifecycle state could not be handled safely",
    });
    await expect(controller.closeOwned()).rejects.toMatchObject({
      code: "IO_FAILURE",
      message: "Chrome lifecycle state could not be handled safely",
    });
  });

  test("repairs only a user-owned permissive profile before one owned launch", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [
      { ...clean, profile: { ...directory, mode: 0o755 } },
      { ...healthy, record: { kind: "absent" } },
    ];
    const result = await new ChromeController({ adapter }).ensureRunning();
    expect(result.reused).toBe(false);
    expect(adapter.repairs).toEqual([profileDir]);
    expect(adapter.spawned).toBe(1);
    expect(adapter.childUnrefs).toBe(1);
    expect(adapter.writes).toHaveLength(1);
    expect(adapter.writes[0]).toEqual({
      schemaVersion: 1,
      pid: 123,
      executable,
      profileDir,
      launchNonce: "0123456789abcdef0123456789abcdef",
      startedAt: "1970-01-01T00:00:00.000Z",
      port: 43210,
      webSocketUrl,
      processBirth,
      visibility: "headless",
    });
    expect(adapter.launchArgv).toEqual([[
      executable,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
    ]]);
  });

  test("headed launch adds no headless flag and persists headed visibility", async () => {
    const adapter = new FakeAdapter();
    const headedRecord = { ...record, visibility: "headed" as const };
    const headedHealthy = {
      ...healthy,
      record: { kind: "valid" as const, value: headedRecord },
      process: {
        ...healthy.process,
        argv: [executable, `--user-data-dir=${profileDir}`],
      },
    };
    adapter.observations = [clean, { ...headedHealthy, record: { kind: "absent" as const } }];

    const result = await new ChromeController({ adapter }).ensureRunning("headed");

    expect(result.visibility).toBe("headed");
    expect(adapter.launchArgv[0]?.some((argument) => argument.startsWith("--headless"))).toBe(false);
    expect(adapter.writes[0]).toMatchObject({ visibility: "headed" });
  });

  test("atomic headed switch refuses a valid replacement without signalling it", async () => {
    const adapter = new FakeAdapter();
    const replacementRecord = {
      ...record,
      pid: 999,
      launchNonce: "ffffffffffffffffffffffffffffffff",
      processBirth: { ...processBirth, value: "replacement-birth" },
      visibility: "headed" as const,
    };
    const replacement = {
      ...healthy,
      record: { kind: "valid" as const, value: replacementRecord },
      process: {
        ...healthy.process,
        pid: 999,
        processBirth: replacementRecord.processBirth,
        argv: [executable, `--user-data-dir=${profileDir}`],
      },
      listener: { ...healthy.listener, pid: 999 },
    };
    adapter.observations = [healthy];
    let pathObservations = 0;
    const observePaths = adapter.observePaths.bind(adapter);
    adapter.observePaths = async (...args: Parameters<typeof observePaths>) => {
      pathObservations++;
      if (pathObservations === 2) adapter.observations = [replacement];
      return observePaths(...args);
    };

    await expect(new ChromeController({ adapter }).switchOwnedToHeaded())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });

    expect(adapter.signals).toEqual([]);
    expect(adapter.spawned).toBe(0);
  });

  test("atomic headed switch excludes a competing headless launch until headed ownership is established", async () => {
    const adapter = new FakeAdapter();
    adapter.serialLock = true;
    adapter.observations = [healthy];
    adapter.childPid = 456;
    const headedRecord = {
      ...record,
      pid: 456,
      port: 43211,
      webSocketUrl: "ws://127.0.0.1:43211/devtools/browser/headed-browser",
      processBirth: { ...processBirth, value: "headed-birth" },
      visibility: "headed" as const,
    };
    const headed = {
      ...healthy,
      record: { kind: "valid" as const, value: headedRecord },
      process: {
        ...healthy.process,
        pid: 456,
        processBirth: headedRecord.processBirth,
        argv: [executable, `--user-data-dir=${profileDir}`],
      },
      listener: { host: "127.0.0.1", port: 43211, pid: 456 },
      activePort: {
        kind: "valid" as const,
        port: 43211,
        path: "/devtools/browser/headed-browser",
      },
      version: { kind: "valid" as const, webSocketUrl: headedRecord.webSocketUrl },
    };
    adapter.persistedObservation = headed;
    const switching = new ChromeController({ adapter });
    const competitor = new ChromeController({ adapter });
    let competitorResult: Promise<import("../src/browser/chrome").ChromeSession> | undefined;
    const removeStaleState = adapter.removeStaleState.bind(adapter);
    adapter.removeStaleState = async (...args: Parameters<typeof removeStaleState>) => {
      await removeStaleState(...args);
      if (args[1] === record.launchNonce) {
        adapter.persisted = false;
        adapter.observations = [clean, { ...headed, record: { kind: "absent" as const } }];
        adapter.waits = 0;
        adapter.live = true;
        competitorResult = competitor.ensureRunning("headless");
      }
    };

    const result = await switching.switchOwnedToHeaded();
    const competing = await competitorResult!;

    expect(adapter.signals).toEqual([[123, "SIGTERM"]]);
    expect(adapter.spawned).toBe(1);
    expect(adapter.launchArgv).toEqual([[
      executable,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ]]);
    expect(result).toMatchObject({ pid: 456, ownership: "owned", visibility: "headed" });
    expect(competing).toMatchObject({ pid: 456, ownership: "owned", visibility: "headed" });
  });

  test("atomic headed switch preserves close timeout and never starts a second profile owner", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [healthy];
    adapter.terminateLeavesLive = true;

    await expect(new ChromeController({ adapter }).switchOwnedToHeaded())
      .rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });

    expect(adapter.signals).toEqual([[123, "SIGTERM"]]);
    expect(adapter.spawned).toBe(0);
    expect(adapter.removals).toEqual([]);
  });

  test("in-process ensure promises are distinct across requested visibility", async () => {
    const adapter = new FakeAdapter();
    adapter.serialLock = true;
    adapter.observations = [healthy];
    const controller = new ChromeController({ adapter });

    const headless = controller.ensureRunning("headless");
    const headed = controller.ensureRunning("headed");

    expect(headless).not.toBe(headed);
    await Promise.all([headless, headed]);
  });

  test("times out readiness, terminates only the spawned child, and removes only its nonce state", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    const controller = new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(adapter.signals).toEqual([[123, "SIGTERM"]]);
    expect(adapter.removals.filter((value) => value !== undefined))
      .toEqual(["0123456789abcdef0123456789abcdef"]);
    expect(adapter.releaseCount).toBe(1);
  });

  test("retains blocking evidence when terminating a failed launch cannot be proven", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    adapter.writeError = new Error("disk failure");
    adapter.signalError = new Error("signal failure");
    await expect(new ChromeController({ adapter }).ensureRunning())
      .rejects.toMatchObject({ code: "CHILD_EXIT_TIMEOUT" });
    expect(adapter.signals).toEqual([[123, "SIGTERM"]]);
    expect(adapter.removals.filter((value) => value !== undefined)).toEqual([]);
    expect(adapter.retainCount).toBe(1);
    expect(adapter.releaseCount).toBe(0);
  });

  test("waits for exact delayed child exit before removing state and releasing the lock", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    adapter.terminateLeavesLive = true;
    await expect(new ChromeController({ adapter, readinessTimeoutMs: 200, pollIntervalMs: 100 })
      .ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(adapter.exitWaits).toEqual([2_000]);
    expect(adapter.childUnrefs).toBe(0);
    expect(adapter.cleanupEvents).toEqual(["wait-exit", "release"]);
    expect(adapter.removals.filter((value) => value !== undefined)).toEqual([record.launchNonce]);
  });

  test("keeps lock and endpoint state when the exact child does not exit", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    adapter.terminateLeavesLive = true;
    adapter.exitWaitResult = false;
    await expect(new ChromeController({ adapter, readinessTimeoutMs: 200, pollIntervalMs: 100 })
      .ensureRunning()).rejects.toMatchObject({ code: "CHILD_EXIT_TIMEOUT" });
    expect(adapter.removals.filter((value) => value !== undefined)).toEqual([]);
    expect(adapter.cleanupEvents).toEqual(["wait-exit", "retain"]);
    expect(adapter.releaseCount).toBe(0);
  });

  test("reports child exit without signaling an unrelated PID", async () => {
    const adapter = new FakeAdapter();
    adapter.live = false;
    await expect(new ChromeController({ adapter }).ensureRunning())
      .rejects.toMatchObject({ code: "CHILD_EXIT" });
    expect(adapter.signals).toEqual([]);
  });

  test("refuses a live dedicated-profile process when its ownership record is malformed", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [{
      ...healthy,
      record: { kind: "malformed" },
      listener: null,
      activePort: null,
      version: null,
    }];
    await expect(new ChromeController({ adapter }).ensureRunning())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
    expect(adapter.spawned).toBe(0);
    expect(adapter.signals).toEqual([]);
  });

  test("refuses another live profile owner when the recorded PID is dead", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [{
      ...healthy,
      process: { ...healthy.process, live: false },
      listener: null,
      activePort: null,
      version: null,
    }];
    adapter.inspectProcess = async () => ({ ...healthy.process, live: false });
    adapter.findProfileProcess = async () => ({ ...healthy.process, pid: 999 });
    await expect(new ChromeController({ adapter }).ensureRunning())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
    expect(adapter.spawned).toBe(0);
  });

  test("concurrent ensure calls converge on one launch", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    const controller = new ChromeController({ adapter });
    const [left, right] = await Promise.all([controller.ensureRunning(), controller.ensureRunning()]);
    expect(left).toEqual(right);
    expect(adapter.spawned).toBe(1);
    expect(adapter.lockCount).toBe(1);
  });

  test("two controllers serialize on the launch lock and reuse the first owned launch", async () => {
    const adapter = new FakeAdapter();
    adapter.serialLock = true;
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    const left = new ChromeController({ adapter });
    const right = new ChromeController({ adapter });
    const results = await Promise.all([left.ensureRunning(), right.ensureRunning()]);
    expect(results.map((value) => value.reused).sort()).toEqual([false, true]);
    expect(adapter.spawned).toBe(1);
    expect(adapter.lockCount).toBe(2);
    expect(adapter.releaseCount).toBe(2);
  });

  test("never signals any process whose current ownership proof mismatches", async () => {
    for (const observation of [
      clean,
      { ...healthy, process: { ...healthy.process, pid: 124 } },
      { ...healthy, process: { ...healthy.process, executable: "/usr/bin/chromium" } },
      { ...healthy, process: { ...healthy.process, argv: [executable] } },
      { ...healthy, listener: null },
      { ...healthy, listener: { ...healthy.listener, pid: 999 } },
      { ...healthy, activePort: { kind: "valid", port: 43211, path: healthy.activePort.path } },
      { ...healthy, version: { kind: "malformed" } },
      { ...healthy, version: { kind: "valid", webSocketUrl: "ws://192.0.2.1:43210/devtools/browser/owned-browser" } },
    ]) {
      const adapter = new FakeAdapter();
      adapter.observations = [observation];
      const controller = new ChromeController({ adapter });
      try { await controller.closeOwned(); } catch { /* compact refusal is permitted */ }
      expect(adapter.signals).toEqual([]);
    }
  });

  test("revalidates OS process birth immediately before SIGTERM", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [healthy];
    let inspections = 0;
    adapter.findProfileProcess = async () => null;
    adapter.inspectProcess = async () => {
      inspections++;
      return inspections === 1
        ? healthy.process
        : { ...healthy.process, processBirth: { ...processBirth, value: "reused-pid" } };
    };
    await expect(new ChromeController({ adapter }).closeOwned())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
    expect(adapter.signals).toEqual([]);
  });

  test("sends exactly one SIGTERM for proven ownership and makes repeated close safe", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [healthy];
    const controller = new ChromeController({ adapter });
    await controller.closeOwned();
    adapter.observations = [clean];
    await controller.closeOwned();
    expect(adapter.signals).toEqual([[123, "SIGTERM"]]);
    expect(adapter.removals).toEqual([record.launchNonce]);
  });

  test("zero SIGTERM and zero removal when second observation replaces the record with different fields", async () => {
    const mutatedRecord = {
      schemaVersion: 1 as const,
      pid: 123,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Canary",
      profileDir,
      launchNonce: record.launchNonce,
      startedAt: "2026-08-30T09:00:00.000Z",
      port: 43211,
      webSocketUrl: "ws://127.0.0.1:43211/devtools/browser/mutated-browser",
      processBirth: { kind: "darwin-ps-start" as const, value: "Sun Aug 30 19:00:00 2026" },
    };
    const mutatedProcess = {
      ...healthy.process,
      executable: mutatedRecord.executable,
      processBirth: mutatedRecord.processBirth,
      argv: [mutatedRecord.executable, `--user-data-dir=${profileDir}`],
    };
    const mutatedObservation = {
      config: directory,
      profile: directory,
      profilePath: profileDir,
      record: { kind: "valid" as const, value: mutatedRecord },
      process: mutatedProcess,
      listener: { host: "127.0.0.1", port: mutatedRecord.port, pid: 123 },
      activePort: { kind: "valid" as const, port: mutatedRecord.port, path: "/devtools/browser/mutated-browser" },
      version: { kind: "valid" as const, webSocketUrl: mutatedRecord.webSocketUrl },
    };
    expect(classifyChrome(mutatedObservation)).toEqual({
      kind: "reuse",
      pid: 123,
      port: 43211,
      webSocketUrl: mutatedRecord.webSocketUrl,
      profileDir,
      visibility: "headed",
    });
    const adapter = new FakeAdapter();
    adapter.findProfileProcess = async () => null;
    let observationPhase = 0;
    adapter.observations = [healthy];
    (adapter as any).observation = () => {
      if (observationPhase < 2) return healthy;
      return mutatedObservation;
    };
    const origObservePaths = adapter.observePaths.bind(adapter);
    adapter.observePaths = async (...args: Parameters<typeof origObservePaths>) => {
      const result = await origObservePaths(...args);
      observationPhase++;
      return result;
    };
    await expect(new ChromeController({ adapter }).closeOwned())
      .rejects.toMatchObject({ code: "AMBIGUOUS_OWNERSHIP" });
    expect(adapter.signals).toEqual([]);
    expect(adapter.removals).toEqual([]);
  });

  test("generic operation that advances to the deadline then rejects maps to READINESS_TIMEOUT", async () => {
    let now = 0;
    await expect(runBeforeChromeDeadline(100, () => now, async (budget) => {
      expect(budget).toBe(100);
      now = 100;
      throw new Error("operation exhausted time");
    })).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("early rejection with positive time remaining preserves its original typed error", async () => {
    let now = 0;
    await expect(runBeforeChromeDeadline(100, () => now, async () => {
      now = 50;
      throw new ChromeControllerError("IO_FAILURE");
    })).rejects.toMatchObject({ code: "IO_FAILURE" });

    let now2 = 0;
    await expect(runBeforeChromeDeadline(100, () => now2, async () => {
      now2 = 10;
      throw new Error("raw failure");
    })).rejects.toThrow("raw failure");
  });

  const withReleaseSignal = (adapter: FakeAdapter) => {
    let releaseSignal!: () => void;
    const releaseWait = new Promise<void>((resolve) => { releaseSignal = resolve; });
    const origAcquireLock = adapter.acquireLock.bind(adapter);
    adapter.acquireLock = async () => {
      const lock = await origAcquireLock();
      const origRelease = lock.release;
      lock.release = async () => {
        await origRelease();
        releaseSignal();
      };
      return lock;
    };
    return releaseWait;
  };

  test("each launch-path mutation and discovery receives a finite positive capped budget", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [
      { ...clean, profile: { ...directory, mode: 0o755 } },
      { ...healthy, record: { kind: "absent" } },
    ];
    await new ChromeController({ adapter }).ensureRunning();

    expect(adapter.repairBudgets).toEqual([1_000]);
    expect(adapter.staleStateBudgets[0]).toBe(500);
    expect(adapter.findChromeBudgets).toEqual([1_000]);
    expect(adapter.spawnChromeBudgets).toEqual([1_000]);

    for (const budgets of [adapter.repairBudgets, adapter.staleStateBudgets,
      adapter.findChromeBudgets, adapter.spawnChromeBudgets]) {
      for (const budget of budgets) {
        expect(Number.isFinite(budget)).toBe(true);
        expect(budget).toBeGreaterThan(0);
      }
    }
  });

  test("close-path signal and state removal receive finite positive capped budgets", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [healthy];
    await new ChromeController({ adapter }).closeOwned();

    expect(adapter.signalBudgets).toEqual([500]);
    const nonceStateBudgets = adapter.staleStateBudgets.filter((b) => b > 0);
    expect(nonceStateBudgets.length).toBeGreaterThanOrEqual(1);
    for (const budget of adapter.signalBudgets) {
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(500);
    }
    for (const budget of nonceStateBudgets) {
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(500);
    }
  });

  test("timed-out filesystem-state mutation retains lock fail-closed until settled, then releases once", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    let resolveStale!: () => void;
    adapter.pendingStaleState = new Promise<void>((resolve) => { resolveStale = resolve; });
    const releaseWait = withReleaseSignal(adapter);

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 10_000, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.retainCount).toBe(1);
    expect(adapter.releaseCount).toBe(0);

    resolveStale();
    await releaseWait;
    expect(adapter.releaseCount).toBe(1);
  });

  test("permanent child-exit retain wins over timed-out mutation settlement; release count stays zero", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    adapter.exitWaitResult = false;
    adapter.terminateLeavesLive = true;
    let resolveWrite!: () => void;
    adapter.pendingWriteOwnership = new Promise<void>((resolve) => { resolveWrite = resolve; });

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "CHILD_EXIT_TIMEOUT" });

    expect(adapter.retainCount).toBe(1);
    expect(adapter.releaseCount).toBe(0);

    resolveWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.releaseCount).toBe(0);
  });

  test("exact budget formula covers one atomic close-and-headed-launch holder", () => {
    const launchPath = 500 + 10_000 + 1_000 + 500 + 1_000 + 1_000 + 10_000 + 500 + 2_000 + 500;
    const closePath = 500 + 10_000 + 10_000 + 500 + 2_000 + 500;
    const margin = 1_000;
    const atomicSwitch = 500 + 10_000 + (closePath - 500) + (launchPath - 500) + margin;

    expect(launchPath).toBe(27_000);
    expect(closePath).toBe(23_500);
    expect(atomicSwitch).toBe(61_000);
    expect(MAXIMUM_HOLDER_SUM_MS).toBe(atomicSwitch);
    expect(LOCK_ACQUISITION_TIMEOUT_MS).toBe(MAXIMUM_HOLDER_SUM_MS + 1_000);
    expect(LOCK_ACQUISITION_TIMEOUT_MS).toBe(62_000);
    expect(LOCK_ACQUISITION_TIMEOUT_MS).toBeGreaterThan(MAXIMUM_HOLDER_SUM_MS);
  });

  test("repair phase at its declared cap cannot silently continue to stale-state removal", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [{ ...clean, profile: { ...directory, mode: 0o755 } }];
    let resolveRepair!: () => void;
    adapter.pendingRepair = new Promise<void>((resolve) => { resolveRepair = resolve; });

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 10_000, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.repairs).toEqual([profileDir]);
    expect(adapter.staleStateBudgets).toEqual([]);
    expect(adapter.spawned).toBe(0);

    resolveRepair();
  });

  test("stale-state removal at its declared cap cannot silently continue to Chrome discovery", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    let resolveStale!: () => void;
    adapter.pendingStaleState = new Promise<void>((resolve) => { resolveStale = resolve; });

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 10_000, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.removals).toEqual([undefined]);
    expect(adapter.findChromeBudgets).toEqual([]);
    expect(adapter.spawned).toBe(0);

    resolveStale();
  });

  test("close-path observation windows are exactly two at OBSERVATION_BUDGET_MS each", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [healthy];
    await new ChromeController({ adapter }).closeOwned();

    const observeBudgets = adapter.operationBudgets.filter((b) => b === 10_000);
    expect(observeBudgets.length).toBeGreaterThanOrEqual(4);
  });

  test("raceMutation rejects a promise that resolves exactly at the deadline", async () => {
    const adapter = new FakeAdapter();
    const controller = new ChromeController({ adapter });
    const deadline = 100;
    await expect((controller as any).raceMutation(deadline, (async () => {
      adapter.nowValue = 100;
      return "late-value";
    })())).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
  });

  test("Chrome discovery at its declared cap cannot silently continue to spawn", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    adapter.findChromeAdvanceMs = 1_000;

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 10_000, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.findChromeBudgets).toEqual([1_000]);
    expect(adapter.spawned).toBe(0);
    expect(adapter.writes).toHaveLength(0);
  });

  test("spawn at its exact cap returns a child that is SIGTERMed and awaited before one release", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    adapter.spawnAdvanceMs = 1_000;
    const releaseWait = withReleaseSignal(adapter);

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 10_000, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.spawned).toBe(1);
    expect(adapter.writes).toHaveLength(0);
    expect(adapter.signals).toEqual([[123, "SIGTERM"]]);
    expect(adapter.cleanupEvents).toContain("wait-exit");

    await releaseWait;
    expect(adapter.releaseCount).toBe(1);
  });

  test("pending spawn that later yields a child SIGTERMs exactly that child and awaits exit before one release", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    let resolveSpawn!: (child: any) => void;
    adapter.pendingSpawn = new Promise<any>((resolve) => { resolveSpawn = resolve; });
    const releaseWait = withReleaseSignal(adapter);

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.retainCount).toBe(1);
    expect(adapter.releaseCount).toBe(0);
    expect(adapter.signals).toEqual([]);

    const lateChild = {
      pid: 456,
      hasExited: () => false,
      terminate: async (signal: "SIGTERM") => { adapter.signals.push([456, signal]); },
      waitForExit: async (timeoutMs: number) => {
        adapter.cleanupEvents.push("wait-exit");
        adapter.exitWaits.push(timeoutMs);
        return true;
      },
    };
    resolveSpawn(lateChild);
    await releaseWait;

    expect(adapter.signals).toEqual([[456, "SIGTERM"]]);
    expect(adapter.exitWaits).toEqual([2_000]);
    expect(adapter.releaseCount).toBe(1);
  });

  test("pending spawn with unproven late-child exit leaves release count zero", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean, { ...healthy, record: { kind: "absent" } }];
    let resolveSpawn!: (child: any) => void;
    adapter.pendingSpawn = new Promise<any>((resolve) => { resolveSpawn = resolve; });

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 400, pollIntervalMs: 200 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(adapter.retainCount).toBe(1);
    expect(adapter.releaseCount).toBe(0);

    const lateChild = {
      pid: 789,
      hasExited: () => false,
      terminate: async (signal: "SIGTERM") => { adapter.signals.push([789, signal]); },
      waitForExit: async () => {
        adapter.cleanupEvents.push("wait-exit");
        return false;
      },
    };
    resolveSpawn(lateChild);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.signals).toEqual([[789, "SIGTERM"]]);
    expect(adapter.releaseCount).toBe(0);
    expect(adapter.retainCount).toBe(1);
  });

  test("pending child terminate never permits release before settlement and exact exit proof", async () => {
    const adapter = new FakeAdapter();
    adapter.observations = [clean];
    adapter.terminateLeavesLive = true;
    let resolveSignal!: () => void;
    adapter.pendingSignal = new Promise<void>((resolve) => { resolveSignal = resolve; });
    const releaseWait = withReleaseSignal(adapter);

    const controller = new ChromeController({ adapter, readinessTimeoutMs: 200, pollIntervalMs: 100 });
    await expect(controller.ensureRunning()).rejects.toMatchObject({ code: "CHILD_EXIT_TIMEOUT" });

    expect(adapter.retainCount).toBe(1);
    expect(adapter.releaseCount).toBe(0);

    resolveSignal();
    await releaseWait;
    expect(adapter.releaseCount).toBe(1);
  });
});
