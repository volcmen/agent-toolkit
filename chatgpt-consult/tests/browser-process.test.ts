import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

const terminate = async (pid: number | undefined): Promise<void> => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await Bun.sleep(10);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
};

test("a successful managed Chrome launch does not retain the launching process", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-chrome-process-"));
  temporaryPaths.push(root);
  const marker = join(root, "managed-child.pid");
  const helper = join(root, "launch-managed.ts");
  const chromeModule = pathToFileURL(join(import.meta.dir, "..", "src", "browser", "chrome.ts")).href;
  await writeFile(helper, `
import { ChromeController } from ${JSON.stringify(chromeModule)};

const marker = process.argv[2];
const executable = "/private/fake-chrome";
const profileDir = "/private/chatgpt-consult-test-profile";
const webSocketUrl = "ws://127.0.0.1:43123/devtools/browser/managed";
const processBirth = { kind: "linux-proc-start-ticks", value: "987654" };
const directory = { kind: "directory", owned: true, mode: 0o700 };
let rawChild;
let ownership;

const processObservation = () => ({
  live: rawChild !== undefined && rawChild.exitCode === null,
  pid: rawChild?.pid ?? 0,
  executable,
  argv: [executable, \`--user-data-dir=\${profileDir}\`, "--headless=new"],
  processBirth,
});

const adapter = {
  preparePaths: async () => ({
    configRoot: "/private/chatgpt-consult-test",
    profileDir,
    ownershipPath: "/private/chatgpt-consult-test/chrome-owner.json",
    activePortPath: "/private/chatgpt-consult-test-profile/DevToolsActivePort",
    lockPath: "/private/chatgpt-consult-test/chrome.lock",
  }),
  observePaths: async () => ({ config: directory, profile: directory }),
  readOwnership: async () => ownership === undefined
    ? ({ kind: "absent" })
    : ({ kind: "valid", value: ownership }),
  readActivePort: async () => rawChild === undefined
    ? null
    : ({ kind: "valid", port: 43123, path: "/devtools/browser/managed" }),
  inspectProcess: async () => rawChild === undefined ? null : processObservation(),
  findProfileProcess: async (_profile, excludingPid) =>
    rawChild === undefined || excludingPid === rawChild.pid ? null : processObservation(),
  inspectListener: async () => rawChild === undefined
    ? null
    : ({ host: "127.0.0.1", port: 43123, pid: rawChild.pid }),
  fetchVersion: async () => rawChild === undefined
    ? ({ kind: "malformed" })
    : ({ kind: "valid", webSocketUrl }),
  repairProfile: async () => {},
  acquireLock: async () => ({ release: async () => {}, retain: async () => {} }),
  removeStaleState: async () => { ownership = undefined; },
  findChrome: async () => executable,
  spawnChrome: async () => {
    rawChild = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.write(marker, String(rawChild.pid));
    return {
      pid: rawChild.pid,
      hasExited: () => rawChild.exitCode !== null,
      terminate: async (signal) => { rawChild.kill(signal); },
      waitForExit: async (timeoutMs) => (await Promise.race([
        rawChild.exited.then(() => true),
        Bun.sleep(timeoutMs).then(() => false),
      ])),
      unref: () => { rawChild.unref(); },
    };
  },
  writeOwnership: async (_paths, value) => { ownership = value; },
  signal: async (pid, signal) => { process.kill(pid, signal); },
  isLive: async (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  randomNonce: () => "0123456789abcdef0123456789abcdef",
};

await new ChromeController({
  adapter,
  readinessTimeoutMs: 1000,
  pollIntervalMs: 10,
}).ensureRunning("headless");
`, "utf8");

  const launcher = Bun.spawn([process.execPath, "run", helper, marker], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let managedPid: number | undefined;
  try {
    const outcome = await Promise.race([
      launcher.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(1_200).then(() => ({ kind: "retained" as const })),
    ]);
    try { managedPid = Number((await readFile(marker, "utf8")).trim()); } catch { /* diagnostic below */ }

    expect(outcome).toEqual({ kind: "exit", exitCode: 0 });
    expect(managedPid).toBeInteger();
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGTERM");
    await terminate(managedPid);
  }
});
