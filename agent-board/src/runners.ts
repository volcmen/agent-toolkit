/**
 * Runners: how a card actually gets worked. One process per run, streaming
 * NDJSON into the card's log so `ab watch`/`ab log` can follow it live and the
 * main process never holds a transcript in memory.
 *
 * Every runner takes the same input and returns the same outcome, so the
 * dispatcher does not care which agent CLI is behind a role.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "./config.ts";
import { parseCodexStream } from "./llm.ts";
import { extractBlocked, extractHandoff } from "./context.ts";
import type { Runtime } from "./types.ts";

export type RunnerInput = {
  runtime: Runtime;
  model: string | null;
  system: string;
  prompt: string;
  cwd: string;
  maxTurns: number;
  readOnly: boolean;
  skills: string[];
  resumeSessionId: string | null;
  timeoutMs: number;
  logPath: string;
  localBaseUrl?: string;
  /** Durable launch registration consumed by the process-group wrapper. */
  launchRegistration?: { root: string; cardId: string; runId: string };
  /** Called immediately before the registration wrapper is spawned. */
  onBeforeSpawn?: () => boolean;
  /** Called immediately after spawning the detached worker process group. */
  onSpawn?: (pgid: number) => boolean;
};

export type RunnerOutput = {
  ok: boolean;
  text: string;
  handoff: string | null;
  blocked: string | null;
  sessionId: string | null;
  usd: number;
  /** Provider-reported tokens; 0 when unknown. Recorded for accounting even
   * when the run is subscription-billed and therefore costs $0. */
  tokens: number;
  turns: number;
  error: string | null;
};

export class ProcessGroupTerminationError extends Error {
  constructor(readonly pgid: number) {
    super(`could not confirm worker process group ${pgid} terminated`);
  }
}

type ProcessGroupOptions = {
  graceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  signal?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  alive?: (pgid: number) => boolean;
  wait?: (ms: number) => Promise<void>;
};

/** Bounded TERM→KILL shutdown. False means callers must retain ownership. */
export async function terminateProcessGroup(
  pgid: number,
  options: ProcessGroupOptions = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? 25;
  const signal = options.signal ?? ((id, name) => process.kill(-id, name));
  const alive = options.alive ?? ((id) => {
    try {
      process.kill(-id, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  });
  const wait = options.wait ?? ((ms) => Bun.sleep(ms));
  const isAlive = (): boolean | null => {
    try {
      return alive(pgid);
    } catch {
      return null;
    }
  };
  const send = (name: "SIGTERM" | "SIGKILL"): boolean => {
    try {
      signal(pgid, name);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const waitUntilGone = async (graceMs: number): Promise<boolean> => {
    const checks = Math.max(1, Math.ceil(graceMs / pollMs));
    for (let index = 0; index <= checks; index += 1) {
      if (isAlive() === false) return true;
      if (index < checks) await wait(pollMs);
    }
    return false;
  };

  if (!send("SIGTERM")) return false;
  if (await waitUntilGone(options.graceMs ?? 1_500)) return true;
  if (!send("SIGKILL")) return false;
  return waitUntilGone(options.killGraceMs ?? 1_500);
}

export function effectiveSkills(cardSkills: string[], roleSkills: string[]): string[] {
  return [...new Set([...roleSkills, ...cardSkills])];
}

/** Skills are prompt commands, not Claude CLI flags; Codex skills are named
 * explicitly so its normal skill trigger contract must load them. */
export function promptWithSkills(prompt: string, skills: string[], runtime: Runtime): string {
  if (skills.length === 0) return prompt;
  const required = runtime === "claude"
    ? skills.map((skill) => `/${skill}`).join("\n")
    : `Required skills (load and follow each before acting): ${skills.map((skill) => `$${skill}`).join(", ")}`;
  return `${required}\n\n${prompt}`;
}

/** `-c` values are TOML. JSON string literals are valid TOML basic strings and
 * preserve the complete multiline SOUL without shell interpolation. */
export function codexDeveloperInstructions(system: string): string {
  return `developer_instructions=${JSON.stringify(system)}`;
}

export function logPathFor(root: string, cardId: string): string {
  mkdirSync(join(root, LOGS_DIR), { recursive: true });
  return join(root, LOGS_DIR, `${cardId}.log`);
}

function appendLog(path: string, line: string): void {
  try {
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // A failed log write must never kill a run.
  }
}

async function spawnStreaming(
  argv: string[],
  input: RunnerInput,
  onLine: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  appendLog(input.logPath, `--- ${new Date().toISOString()} $ ${argv.join(" ")}`);
  if (input.onBeforeSpawn && !input.onBeforeSpawn()) {
    throw new Error("worker lease was lost before spawn");
  }
  const launchArgv = input.launchRegistration
    ? [
        process.execPath,
        join(import.meta.dir, "launch-worker.ts"),
        input.launchRegistration.root,
        input.launchRegistration.cardId,
        input.launchRegistration.runId,
        ...argv,
      ]
    : argv;
  const proc = Bun.spawn(launchArgv, {
    cwd: input.cwd,
    stdin: new TextEncoder().encode(`${promptWithSkills(input.prompt, input.skills, input.runtime)}\n`),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AB_CARD_RUN: "1" },
    detached: true,
  });
  const admitted = input.onSpawn?.(proc.pid) ?? true;
  if (!admitted) {
    const terminated = await terminateProcessGroup(proc.pid);
    if (!terminated) throw new ProcessGroupTerminationError(proc.pid);
    await proc.exited;
    throw new Error("worker lease was lost before process-group registration");
  }
  let timedOut = false;

  // Both pipes must be drained concurrently: a child that fills the stderr
  // buffer while we only read stdout blocks forever (until the timeout).
  const readStdout = async (): Promise<string> => {
    let collected = "";
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      collected += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          appendLog(input.logPath, line);
          onLine(line);
        }
      }
    }
    if (pending.trim()) {
      appendLog(input.logPath, pending);
      onLine(pending);
    }
    return collected;
  };

  const stdoutPromise = readStdout();
  const stderrPromise = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
  });
  try {
    const outcome = await Promise.race([proc.exited.then(() => "exit" as const), timeout]);
    if (outcome === "timeout") {
      timedOut = true;
      if (!await terminateProcessGroup(proc.pid)) throw new ProcessGroupTerminationError(proc.pid);
    } else if (!await terminateProcessGroup(proc.pid)) {
      // The CLI exited, but a descendant may still own the process group and
      // inherited pipes/workspace access. Do not release admission until gone.
      throw new ProcessGroupTerminationError(proc.pid);
    }
    const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    if (stderr.trim()) appendLog(input.logPath, `stderr: ${stderr.trim().slice(0, 2000)}`);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer!);
  }
}

export function codexArgv(input: RunnerInput): string[] {
  // Sandbox and cwd are top-level Codex options. Keeping them before `exec`
  // also makes them apply when the nested command is `exec resume`.
  const argv = [
    "codex",
    "-s",
    input.readOnly ? "read-only" : "workspace-write",
    "-C",
    input.cwd,
    "-c",
    codexDeveloperInstructions(input.system),
  ];
  if (input.model) argv.push("-m", input.model);
  argv.push("exec");
  if (input.resumeSessionId) argv.push("resume", input.resumeSessionId);
  argv.push("--json", "--skip-git-repo-check", "-");
  return argv;
}

async function runCodex(input: RunnerInput): Promise<RunnerOutput> {
  const result = await spawnStreaming(codexArgv(input), input, () => {});
  const parsed = parseCodexStream(result.stdout);
  const text = parsed.text;
  const failed = result.code !== 0 || result.timedOut || text === "";
  return {
    ok: !failed,
    text,
    handoff: extractHandoff(text),
    blocked: extractBlocked(text),
    sessionId: parsed.sessionId,
    usd: parsed.usd,
    tokens: parsed.tokens,
    turns: 1,
    error: failed
      ? result.timedOut
        ? "codex timed out"
        : `codex exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`
      : null,
  };
}

export function claudeArgv(input: RunnerInput): string[] {
  const argv = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(input.maxTurns),
    "--append-system-prompt",
    input.system,
  ];
  if (input.model) argv.push("--model", input.model);
  if (input.resumeSessionId) argv.push("--resume", input.resumeSessionId);
  if (input.readOnly) argv.push("--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch");
  else argv.push("--permission-mode", "acceptEdits", "--add-dir", input.cwd);
  return argv;
}

async function runClaude(input: RunnerInput): Promise<RunnerOutput> {
  const argv = claudeArgv(input);

  let usd = 0;
  let tokens = 0;
  let turns = 0;
  let sessionId: string | null = null;
  let text = "";
  const result = await spawnStreaming(argv, input, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.session_id === "string") sessionId = event.session_id;
    const type = String(event.type ?? "");
    if (type === "assistant") turns += 1;
    if (type === "result") {
      if (typeof event.total_cost_usd === "number") usd = event.total_cost_usd;
      if (typeof event.num_turns === "number") turns = event.num_turns;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        tokens = Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
      }
      if (typeof event.result === "string") text = event.result;
      if (typeof event.subtype === "string" && event.subtype !== "success" && !text) {
        text = `(${event.subtype})`;
      }
    }
  });

  const failed = result.code !== 0 || result.timedOut || text === "";
  return {
    ok: !failed,
    text,
    handoff: extractHandoff(text),
    blocked: extractBlocked(text),
    sessionId,
    usd,
    tokens,
    turns,
    error: failed
      ? result.timedOut
        ? "claude timed out"
        : `claude exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`
      : null,
  };
}

/** Local models get no tools, so they are only useful for reasoning cards. */
async function runLocal(input: RunnerInput): Promise<RunnerOutput> {
  const base = (input.localBaseUrl ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
  appendLog(input.logPath, `--- ${new Date().toISOString()} local ${base} ${input.model ?? "?"}`);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify({
        model: input.model ?? "llama3.2:3b",
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        text: "",
        handoff: null,
        blocked: null,
        sessionId: null,
        usd: 0,
        tokens: 0,
        turns: 0,
        error: `local http ${response.status}`,
      };
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = payload.choices?.[0]?.message?.content ?? "";
    appendLog(input.logPath, text.slice(0, 4000));
    return {
      ok: text !== "",
      text,
      handoff: extractHandoff(text),
      blocked: extractBlocked(text),
      sessionId: null,
      usd: 0,
      tokens: 0,
      turns: 1,
      error: text ? null : "local returned empty output",
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      handoff: null,
      blocked: null,
      sessionId: null,
      usd: 0,
      tokens: 0,
      turns: 0,
      error: `local unreachable: ${(error as Error).message}`,
    };
  }
}

export async function runCard(input: RunnerInput): Promise<RunnerOutput> {
  switch (input.runtime) {
    case "codex":
      return runCodex(input);
    case "claude":
      return runClaude(input);
    case "local":
      return runLocal(input);
  }
}

/**
 * Exactly what would be spawned. Delegates to the same builders the runners use,
 * so `ab plan` can never drift from a real run.
 */
export function previewArgv(input: RunnerInput): string[] {
  switch (input.runtime) {
    case "codex":
      return codexArgv(input);
    case "claude":
      return claudeArgv(input);
    case "local":
      return ["local", input.model ?? "llama3.2:3b", `(${input.localBaseUrl ?? "http://127.0.0.1:11434/v1"})`];
  }
}
