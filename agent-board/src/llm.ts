/**
 * Cheap-tier JSON caller used by triage and the completion judge.
 *
 * Design rules:
 *   - one shot per provider, no retry loops; walk the chain instead
 *   - the first provider is local (free) and only failure or low confidence
 *     escalates to a paid one
 *   - every call is capped in output tokens and wall-clock
 *   - parsing is lenient (fences, prose around the object) so a 3B model's
 *     sloppy formatting does not force an escalation
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriageProvider } from "./types.ts";

export type JsonCall = {
  system: string;
  user: string;
  /** JSON Schema for providers that support structured output. */
  schema?: Record<string, unknown>;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type JsonResult = {
  ok: boolean;
  data: Record<string, unknown> | null;
  provider: string;
  model: string;
  usd: number;
  /** Tokens, when the provider reports them (codex does, local does not). */
  tokens: number;
  raw: string;
  error: string | null;
};

const FENCE = /^\s*```(?:json)?\s*|\s*```\s*$/gi;

/** Pull the first balanced JSON object out of arbitrary model output. */
export function extractJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const cleaned = raw.replace(FENCE, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, index + 1));
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function runProcess(
  argv: string[],
  options: { stdin?: string; timeoutMs: number; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function callLocal(provider: TriageProvider, call: JsonCall): Promise<JsonResult> {
  const base = provider.baseUrl ?? "http://127.0.0.1:11434/v1";
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: call.user },
    ],
    max_tokens: call.maxOutputTokens ?? 900,
    temperature: 0,
    response_format: { type: "json_object" },
    stream: false,
  };
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(call.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        data: null,
        provider: "local",
        model: provider.model,
        usd: 0,
        tokens: 0,
        raw: "",
        error: `local http ${response.status}`,
      };
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = payload.choices?.[0]?.message?.content ?? "";
    const data = extractJson(raw);
    return {
      ok: data !== null,
      data,
      provider: "local",
      model: provider.model,
      usd: 0,
      tokens: 0,
      raw,
      error: data ? null : "local returned unparseable JSON",
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      provider: "local",
      model: provider.model,
      usd: 0,
      tokens: 0,
      raw: "",
      error: `local unreachable: ${(error as Error).message}`,
    };
  }
}

async function callCodex(provider: TriageProvider, call: JsonCall): Promise<JsonResult> {
  let schemaDir: string | null = null;
  const argv = [
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-m",
    provider.model,
    "-c",
    "model_reasoning_effort=low",
  ];
  if (call.schema) {
    schemaDir = mkdtempSync(join(tmpdir(), "ab-schema-"));
    const schemaPath = join(schemaDir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(call.schema), "utf8");
    argv.push("--output-schema", schemaPath);
  }
  argv.push("-");
  try {
    const result = await runProcess(argv, {
      stdin: `${call.system}\n\n${call.user}`,
      timeoutMs: call.timeoutMs ?? 180_000,
    });
    const { text, usd, tokens } = parseCodexStream(result.stdout);
    const data = extractJson(text);
    return {
      ok: data !== null,
      data,
      provider: "codex",
      model: provider.model,
      usd,
      tokens,
      raw: text || result.stderr.slice(0, 800),
      error: data ? null : `codex returned no JSON (exit ${result.code})`,
    };
  } finally {
    if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
  }
}

export type CodexStream = {
  /** Last agent message — the answer. */
  text: string;
  /** Codex is subscription-billed, so cost is only set if the CLI reports one. */
  usd: number;
  tokens: number;
  sessionId: string | null;
};

/**
 * Parse `codex exec --json`. Verified event shapes (codex 2026-07):
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
 * Older builds emitted `{"msg":{"type":"agent_message","message":"…"}}`, so both
 * are accepted.
 */
export function parseCodexStream(stdout: string): CodexStream {
  let text = "";
  let usd = 0;
  let tokens = 0;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event.type ?? "");
    if (typeof event.thread_id === "string") sessionId = event.thread_id;
    if (typeof event.session_id === "string") sessionId = event.session_id;

    const item = event.item as Record<string, unknown> | undefined;
    if (item && String(item.type ?? "") === "agent_message" && typeof item.text === "string") {
      text = item.text;
    }

    // Legacy envelope.
    const msg = event.msg as Record<string, unknown> | undefined;
    if (msg) {
      const msgType = String(msg.type ?? "");
      if (msgType === "agent_message" && typeof msg.message === "string") text = msg.message;
      if (msgType === "agent_message_delta" && typeof msg.delta === "string") text += msg.delta;
      if (typeof msg.session_id === "string") sessionId = msg.session_id;
    }

    const usage = (event.usage ?? msg?.usage) as Record<string, unknown> | undefined;
    if (usage) {
      const input = Number(usage.input_tokens ?? 0);
      const output = Number(usage.output_tokens ?? 0);
      const reasoning = Number(usage.reasoning_output_tokens ?? 0);
      if (Number.isFinite(input + output + reasoning)) tokens += input + output + reasoning;
      const cost = Number(usage.cost_usd ?? NaN);
      if (Number.isFinite(cost)) usd = cost;
    }
  }
  return { text: text.trim(), usd, tokens, sessionId };
}

async function callClaude(provider: TriageProvider, call: JsonCall): Promise<JsonResult> {
  const argv = [
    "claude",
    "-p",
    "--safe-mode",
    "--output-format",
    "json",
    "--model",
    provider.model,
    "--tools",
    "",
    "--max-turns",
    "1",
    "--no-session-persistence",
    "--append-system-prompt",
    call.system,
  ];
  const result = await runProcess(argv, {
    stdin: call.user,
    timeoutMs: call.timeoutMs ?? 180_000,
  });
  let raw = result.stdout;
  let usd = 0;
  let tokens = 0;
  try {
    const envelope = JSON.parse(result.stdout) as {
      result?: string;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    raw = envelope.result ?? result.stdout;
    usd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : 0;
    tokens = Number(envelope.usage?.input_tokens ?? 0) + Number(envelope.usage?.output_tokens ?? 0);
  } catch {
    // Non-JSON envelope (auth error, 429 text) — fall through to lenient parse.
  }
  const data = extractJson(raw);
  return {
    ok: data !== null,
    data,
    provider: "claude",
    model: provider.model,
    usd,
    tokens,
    raw: raw.slice(0, 1200),
    error: data ? null : `claude returned no JSON (exit ${result.code}) ${result.stderr.slice(0, 200)}`,
  };
}

export async function callProvider(provider: TriageProvider, call: JsonCall): Promise<JsonResult> {
  switch (provider.kind) {
    case "local":
      return callLocal(provider, call);
    case "codex":
      return callCodex(provider, call);
    case "claude":
      return callClaude(provider, call);
  }
}

export type ChainOptions = {
  /** Accept the first result whose `confidence` clears this bar. */
  minConfidence?: number;
  onAttempt?: (result: JsonResult) => void;
};

/**
 * Walk the provider chain cheapest-first. Returns the first parseable result
 * that clears the confidence bar, else the last attempt (so callers can log why
 * everything failed).
 */
export async function callChain(
  chain: TriageProvider[],
  call: JsonCall,
  options: ChainOptions = {},
): Promise<JsonResult> {
  const minConfidence = options.minConfidence ?? 0;
  let last: JsonResult = {
    ok: false,
    data: null,
    provider: "none",
    model: "-",
    usd: 0,
    tokens: 0,
    raw: "",
    error: "no triage provider configured",
  };
  for (const provider of chain) {
    const result = await callProvider(provider, call);
    options.onAttempt?.(result);
    last = result;
    if (!result.ok) continue;
    const confidence = Number(result.data?.confidence ?? 1);
    if (Number.isFinite(confidence) && confidence < minConfidence) continue;
    return result;
  }
  return last;
}
