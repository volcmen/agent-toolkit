import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBoundedDiagnosticResult } from "../src/browser/chrome";

const OPT_IN = process.env.CHATGPT_CONSULT_BROWSER_SMOKE === "1";

const POLL_INTERVAL_MS = 200;
const READINESS_TIMEOUT_MS = 15_000;
const ACTIVE_PORT_MAX_BYTES = 1_024;
const VERSION_MAX_BYTES = 64 * 1024;
const STDOUT_MAX_BYTES = 64 * 1024;
const CHROME_EXIT_TIMEOUT_MS = 5_000;
const CHROME_KILL_TIMEOUT_MS = 2_000;
const CDP_TIMEOUT_MS = 10_000;
const AB_CLEANUP_TIMEOUT_MS = 1_000;
const AB_CLOSE_RETRY_MS = 5_000;
const FIXTURE_HTML =
  "<!DOCTYPE html><html><head><title>Smoke</title></head>"
  + "<body><h1>Smoke</h1><textarea></textarea></body></html>";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

const monotonicNow = (): number => performance.now();

interface MinimalView {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

async function findChrome(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = Bun.which(name);
    if (found !== null) candidates.push(found);
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* not found */ }
  }
  return null;
}

async function pollDevToolsActivePort(
  profileDir: string,
  deadline: number,
): Promise<{ port: number; path: string }> {
  const filePath = join(profileDir, "DevToolsActivePort");
  while (monotonicNow() < deadline) {
    let handle;
    try {
      handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) break;
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      continue;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        const remaining = deadline - monotonicNow();
        if (remaining <= 0) break;
        await sleep(Math.min(POLL_INTERVAL_MS, remaining));
        continue;
      }
      const buf = Buffer.allocUnsafe(ACTIVE_PORT_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buf, 0, ACTIVE_PORT_MAX_BYTES + 1, 0);
      if (bytesRead > ACTIVE_PORT_MAX_BYTES) {
        throw new RangeError("DevToolsActivePort exceeds byte ceiling");
      }
      const text = buf.subarray(0, bytesRead).toString("utf8");
      if (!text.includes("\0")) {
        const lines = text.endsWith("\n")
          ? text.slice(0, -1).split("\n")
          : text.split("\n");
        if (lines.length === 2) {
          const portStr = lines[0];
          const pathStr = lines[1];
          if (
            portStr !== undefined
            && pathStr !== undefined
            && /^[1-9][0-9]{0,4}$/.test(portStr)
          ) {
            const port = Number(portStr);
            if (
              port >= 1
              && port <= 65_535
              && /^\/devtools\/browser\/[^/?#\s]+$/.test(pathStr)
            ) {
              return { port, path: pathStr };
            }
          }
        }
      }
    } finally {
      await handle.close();
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
  throw new Error("DevToolsActivePort did not appear before deadline");
}

async function readBodyBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  deadline: number,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let perReadTimer: ReturnType<typeof setTimeout> | undefined;
  let perReadTimeout: Promise<never> | undefined;
  try {
    while (true) {
      if (monotonicNow() >= deadline) {
        await reader.cancel().catch(() => {});
        throw new Error("read deadline exceeded");
      }
      const remaining = deadline - monotonicNow();
      perReadTimeout = new Promise<never>((_, reject) => {
        perReadTimer = setTimeout(() => reject(new Error("read deadline exceeded")), remaining);
      });
      void perReadTimeout.catch(() => {});
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await Promise.race([reader.read(), perReadTimeout]);
      } catch {
        await reader.cancel().catch(() => {});
        throw new Error("read deadline exceeded");
      } finally {
        if (perReadTimer) { clearTimeout(perReadTimer); perReadTimer = undefined; }
        perReadTimeout = undefined;
      }
      if (result.done) break;
      if (result.value) {
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new RangeError("response exceeds byte ceiling");
        }
        chunks.push(result.value);
      }
    }
  } finally {
    if (perReadTimer) { clearTimeout(perReadTimer); perReadTimer = undefined; }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks, bytes);
}

async function fetchVersionJson(
  port: number,
  deadline: number,
): Promise<Record<string, unknown>> {
  if (monotonicNow() >= deadline) throw new Error("deadline exceeded");
  const remaining = deadline - monotonicNow();
  const controller = new AbortController();
  const fetchTimer = setTimeout(() => { controller.abort(); }, remaining);
  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(fetchTimer);
  }
  if (!resp.ok) throw new Error("version fetch failed");
  if (!resp.body) throw new Error("version response has no body");
  const buffer = await readBodyBounded(resp.body, VERSION_MAX_BYTES, deadline);
  const text = buffer.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("version response is not an object");
  }
  return parsed as Record<string, unknown>;
}

function assertPidLive(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw new Error("Chrome process exited unexpectedly");
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
}

async function cdpWithDeadline(
  view: MinimalView,
  method: string,
  params: Record<string, unknown> | undefined,
  capMs: number,
  deadline: number,
): Promise<unknown> {
  if (monotonicNow() >= deadline) throw new Error(`${method} pre-deadline`);
  const remaining = deadline - monotonicNow();
  const effective = Math.min(capMs, remaining);
  if (effective <= 0) throw new Error(`${method} deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`${method} deadline`)); }, effective);
  });
  void timeout.catch(() => {});
  try {
    const result = await Promise.race([view.cdp(method, params), timeout]);
    if (monotonicNow() >= deadline) throw new Error(`${method} post-deadline`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFrameUrl(
  view: MinimalView,
  fixtureUrl: string,
  deadline: number,
): Promise<void> {
  while (monotonicNow() < deadline) {
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) break;
    const cap = Math.min(CDP_TIMEOUT_MS, remaining);
    const raw = await cdpWithDeadline(view, "Page.getFrameTree", {}, cap, deadline);
    const frameResult = raw as { frameTree?: { frame?: { url?: unknown } } };
    const frameUrl = frameResult?.frameTree?.frame?.url;
    if (frameUrl === fixtureUrl) return;
    const pollRemaining = deadline - monotonicNow();
    if (pollRemaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, pollRemaining));
  }
  throw new Error("Frame URL did not match fixture before deadline");
}

async function runAgentBrowserBounded(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  deadline: number,
): Promise<{ status: number; output: string }> {
  if (monotonicNow() >= deadline) throw new Error("pre-command deadline");
  const remaining = deadline - monotonicNow();
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const result = await runBoundedDiagnosticResult(
    {
      stdout: child.stdout as ReadableStream<Uint8Array>,
      exited: child.exited,
      kill: (signal: "SIGTERM" | "SIGKILL") => { child.kill(signal); },
    },
    {
      timeoutMs: remaining,
      maximumBytes: STDOUT_MAX_BYTES,
      cleanupTimeoutMs: AB_CLEANUP_TIMEOUT_MS,
    },
  );
  if (monotonicNow() >= deadline) throw new Error("post-command deadline");
  return result;
}

function parseOpenEnvelope(output: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.success !== true) return null;
  const data = obj.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function parseGetUrlEnvelope(output: string, fixtureUrl: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  if (obj.success !== true) return false;
  const data = obj.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).url === fixtureUrl;
}

describe.skipIf(!OPT_IN)("browser smoke", () => {
  test(
    "disposable transport attachment",
    async () => {
      let root: string | undefined;
      let chromeChild: Bun.Subprocess | undefined;
      let server: Bun.Server<undefined> | undefined;
      let view: MinimalView | undefined;
      let abInvoked = false;
      let sessionClosed = false;
      let chromeReaped = false;
      let abHome: string | undefined;
      let abConfig: string | undefined;
      let sessionId: string | undefined;
      let abPort: number | undefined;

      try {
        const deadline = monotonicNow() + 115_000;

        // 1. Temp root + dedicated profile
        root = await mkdtemp(join(tmpdir(), "browser-smoke-"));
        await chmod(root, 0o700);
        const profileDir = join(root, "profile");
        await mkdir(profileDir, { mode: 0o700 });

        // 2. Locate Chrome/Chromium
        const chromeExe = await findChrome();
        if (chromeExe === null) {
          throw new Error(
            "Chrome/Chromium not found; install Google Chrome or Chromium"
            + " or unset CHATGPT_CONSULT_BROWSER_SMOKE",
          );
        }

        // 3. Spawn disposable Chrome
        const chromeEnv: Record<string, string> = {
          HOME: root,
          PATH: process.env.PATH ?? "",
          LANG: "C",
          LC_ALL: "C",
          NO_COLOR: "1",
        };
        const tmpVal = process.env.TMPDIR;
        if (tmpVal !== undefined && tmpVal.length > 0) {
          chromeEnv.TMPDIR = tmpVal;
        }

        chromeChild = Bun.spawn([
          chromeExe,
          "--headless",
          "--remote-debugging-port=0",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ], { stdout: "ignore", stderr: "ignore", env: chromeEnv });
        const chromePid = chromeChild.pid;

        // 4. Poll DevToolsActivePort
        const activePort = await pollDevToolsActivePort(
          profileDir,
          monotonicNow() + READINESS_TIMEOUT_MS,
        );
        const webSocketUrl =
          `ws://127.0.0.1:${activePort.port}${activePort.path}`;

        // 5. Verify /json/version loopback endpoint
        const versionJson = await fetchVersionJson(
          activePort.port,
          monotonicNow() + READINESS_TIMEOUT_MS,
        );
        const versionWs = versionJson.webSocketDebuggerUrl;
        if (typeof versionWs !== "string" || versionWs !== webSocketUrl) {
          throw new Error(
            "Version endpoint webSocketDebuggerUrl does not match"
            + " DevToolsActivePort",
          );
        }

        // 6. Local fixture server
        const srv = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            return new Response(FIXTURE_HTML, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          },
        });
        server = srv;
        const fixturePort = srv.port;
        if (fixturePort === undefined) throw new Error("fixture port unavailable");
        const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

        // 7. WebView attachment
        const g = globalThis as Record<string, unknown>;
        const BunNS = g.Bun as Record<string, unknown> | undefined;
        type WebViewFactory = new (opts: Record<string, unknown>) => MinimalView;
        const WebViewCtor = (BunNS?.WebView as WebViewFactory | undefined);
        if (typeof WebViewCtor !== "function") {
          throw new Error("Bun.WebView is not available in this build");
        }
        view = new WebViewCtor({
          backend: { type: "chrome", url: webSocketUrl },
          url: fixtureUrl,
        });

        await cdpWithDeadline(view, "Page.enable", {}, CDP_TIMEOUT_MS, deadline);
        await waitForFrameUrl(view, fixtureUrl, deadline);

        // Chrome PID alive after WebView attachment
        assertPidLive(chromePid);

        // 8. agent-browser attachment
        const abExe = Bun.which("agent-browser");
        if (abExe === null) {
          throw new Error(
            "agent-browser not found in PATH; install it"
            + " or unset CHATGPT_CONSULT_BROWSER_SMOKE",
          );
        }
        const abVersion = Bun.spawnSync([abExe, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (abVersion.exitCode !== 0
          || abVersion.stdout.toString().trim() !== "agent-browser 0.35.1") {
          throw new Error("browser smoke requires Bun-owned agent-browser 0.35.1");
        }

        const abHomePath = join(root, "ab-home");
        await mkdir(abHomePath, { mode: 0o700 });
        const abConfigPath = join(abHomePath, "agent-browser.json");
        await writeFile(abConfigPath, "{}\n", { mode: 0o600 });
        await chmod(abConfigPath, 0o600);
        abHome = abHomePath;
        abConfig = abConfigPath;

        const sid = randomBytes(16).toString("hex");
        sessionId = sid;
        abPort = activePort.port;
        const globalArgs = [
          abExe,
          "--session", sid,
          "--cdp", String(activePort.port),
          "--pin-tab",
          "--config", abConfig,
          "--idle-timeout", "1s",
          "--json",
        ];
        const abEnv: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: abHomePath,
          XDG_CONFIG_HOME: abHomePath,
          LANG: "C",
          LC_ALL: "C",
          NO_COLOR: "1",
        };
        const abTmp = process.env.TMPDIR;
        if (abTmp !== undefined && abTmp.length > 0) {
          abEnv.TMPDIR = abTmp;
        }

        // Mark session attempted before first command
        abInvoked = true;

        // open <fixtureUrl>
        const openResult = await runAgentBrowserBounded(
          [...globalArgs, "open", fixtureUrl],
          abEnv,
          abHomePath,
          deadline,
        );
        expect(openResult.status).toBe(0);
        const openData = parseOpenEnvelope(openResult.output);
        expect(openData).not.toBeNull();

        // get url
        const urlResult = await runAgentBrowserBounded(
          [...globalArgs, "get", "url"],
          abEnv,
          abHomePath,
          deadline,
        );
        expect(urlResult.status).toBe(0);
        expect(parseGetUrlEnvelope(urlResult.output, fixtureUrl)).toBe(true);

        // Both WebView and agent-browser attached via the same CDP port
        // that was written by the directly spawned Chrome child (chromePid).
        // Verify the child is still alive after both attachments.
        assertPidLive(chromePid);

        // Invoke bounded close for exact session
        try {
          const closeResult = await runAgentBrowserBounded(
            [...globalArgs, "close"],
            abEnv,
            abHomePath,
            deadline,
          );
          if (closeResult.status === 0) sessionClosed = true;
        } catch {
          // close failed, will retry in cleanup
        }
      } finally {
        // Close WebView at most once
        if (view) {
          try { view.close(); } catch { /* swallow */ }
        }
        // Stop fixture server
        if (server) {
          try { server.stop(true); } catch { /* swallow */ }
        }
        // Retry agent-browser close if needed
        if (abInvoked && !sessionClosed && abHome && abConfig && sessionId !== undefined && abPort !== undefined) {
          const retryDeadline = monotonicNow() + AB_CLOSE_RETRY_MS;
          try {
            const retryExe = Bun.which("agent-browser");
            if (retryExe !== null) {
              const retryArgs = [
                retryExe,
                "--session", sessionId,
                "--cdp", String(abPort),
                "--pin-tab",
                "--config", abConfig,
                "--idle-timeout", "1s",
                "--json",
                "close",
              ];
              const retryEnv: Record<string, string> = {
                PATH: process.env.PATH ?? "",
                HOME: abHome,
                XDG_CONFIG_HOME: abHome,
                LANG: "C",
                LC_ALL: "C",
                NO_COLOR: "1",
              };
              const retryTmp = process.env.TMPDIR;
              if (retryTmp !== undefined && retryTmp.length > 0) {
                retryEnv.TMPDIR = retryTmp;
              }
              await runAgentBrowserBounded(retryArgs, retryEnv, abHome, retryDeadline);
            }
          } catch {
            // retry failed, continue with Chrome termination
          }
        }
        // Terminate Chrome with SIGTERM then SIGKILL escalation
        if (chromeChild) {
          try { chromeChild.kill("SIGTERM"); } catch { /* already exited */ }
          const sigtermResult = await Promise.race([
            chromeChild.exited.then(() => true as const),
            sleep(CHROME_EXIT_TIMEOUT_MS).then(() => false as const),
          ]);
          if (!sigtermResult) {
            try { chromeChild.kill("SIGKILL"); } catch { /* already exited */ }
            const sigkillResult = await Promise.race([
              chromeChild.exited.then(() => true as const),
              sleep(CHROME_KILL_TIMEOUT_MS).then(() => false as const),
            ]);
            chromeReaped = sigkillResult;
          } else {
            chromeReaped = true;
          }
        } else {
          chromeReaped = true;
        }
        // Only remove temp root after Chrome exit is proven
        if (chromeReaped && root) {
          try {
            await rm(root, { recursive: true, force: true });
          } catch { /* swallow */ }
        }
      }
      // Fail if Chrome exit could not be proven
      if (chromeChild && !chromeReaped) {
        throw new Error("Chrome exit could not be proven; temp root retained");
      }
    },
    120_000,
  );
});
