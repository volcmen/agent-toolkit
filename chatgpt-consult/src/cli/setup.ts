import { realpath } from "node:fs/promises";

export type ClientName = "codex" | "claude";
export type ClientStatus = "current" | "absent" | "mismatch" | "skipped" | "error";
export type ClientAction = "none" | "add" | "replace" | "skipped" | "error";

export interface ClientResult {
  readonly client: ClientName;
  readonly status: ClientStatus;
  readonly action: ClientAction;
  readonly addArgv?: readonly string[];
  readonly removeArgv?: readonly string[];
  readonly message: string;
}

export interface SetupClientsResult {
  readonly kind: "clients";
  readonly mode: "preview" | "apply";
  readonly success: boolean;
  readonly clients: readonly ClientResult[];
}

export interface ChatgptSetupGuidance {
  readonly kind: "chatgpt";
  readonly recommended: {
    readonly initCommand: string;
    readonly clientsCommand: string;
    readonly browserCommand: string;
    readonly doctorCommand: string;
    readonly startCommand: string;
    readonly steps: readonly string[];
  };
  readonly manualFallback: {
    readonly handoff: string;
    readonly importResult: string;
  };
  readonly legacyCompatibility: {
    readonly optional: true;
    readonly neverAutoStarted: true;
    readonly startCommand: string;
    readonly healthUrl: string;
    readonly mcpUrl: string;
    readonly healthCommand: string;
    readonly tunnelDocumentationUrl: string;
    readonly requiredTools: readonly string[];
  };
}

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnedChild {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface SetupClientsInput {
  readonly apply: boolean;
  readonly replace: boolean;
  readonly resolveSourceBinary?: () => Promise<string> | string;
  readonly isExecutableAvailable?: (name: string) => Promise<boolean> | boolean;
  readonly runCommand?: (argv: readonly string[]) => Promise<CommandResult>;
  readonly spawnCommand?: (argv: readonly string[]) => SpawnedChild;
  readonly now?: () => number;
  readonly awaitWithin?: <T>(work: () => Promise<T>, timeoutMs: number) => Promise<T>;
}

const CLIENTS: readonly ClientName[] = ["codex", "claude"];
const SERVER_NAME = "chatgpt-consult";
const BOUNDED_PARSER_INPUT = 16 * 1024;
const BOUNDED_OUTPUT_CAP = 64 * 1024;
const COMMAND_TIMEOUT_MS = 5000;
const SIGTERM_BUDGET_MS = 2500;
const SIGKILL_BUDGET_MS = 2500;

const defaultResolveSourceBinary = async (): Promise<string> => {
  return realpath(import.meta.dir + "/../../bin/chatgpt-consult.ts");
};

const defaultIsExecutableAvailable = async (name: string): Promise<boolean> => {
  return Bun.which(name) !== null;
};

const defaultSpawnCommand = (argv: readonly string[]): SpawnedChild => {
  const child = Bun.spawn(argv as string[], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: null,
  });
  return {
    stdout: child.stdout ?? null,
    stderr: child.stderr ?? null,
    exited: child.exited,
    kill: (signal) => { child.kill(signal); },
  };
};

const defaultNow = (): number => performance.now();

const defaultAwaitWithin = async <T>(work: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const BOUNDED_DRAIN_MS = 2000;

export const getChatgptSetupGuidance = (): ChatgptSetupGuidance => ({
  kind: "chatgpt",
  recommended: {
    initCommand: "chatgpt-consult init --chatgpt-project-url <chatgpt-project-url>",
    clientsCommand: "chatgpt-consult setup clients --apply",
    browserCommand: "chatgpt-consult setup browser",
    doctorCommand: "chatgpt-consult doctor",
    startCommand: "chatgpt-consult start \"Review the queue retry policy\" --profile lean --file src/queue.ts --open",
    steps: [
      "Configure a topic-scoped ChatGPT Project URL in ignored local state.",
      "Register the local six-tool MCP with Codex and Claude.",
      "Open the dedicated headed browser and sign in directly on ChatGPT.",
      "Run doctor, then start a bounded automatic consultation.",
      "Poll status until completion or a typed login/manual recovery state.",
    ],
  },
  manualFallback: {
    handoff: "chatgpt-consult handoff <id>",
    importResult: "chatgpt-consult import-result <id> --input <file>",
  },
  legacyCompatibility: {
    optional: true,
    neverAutoStarted: true,
    startCommand: "chatgpt-consult serve chatgpt",
    healthUrl: "http://127.0.0.1:43891/health",
    mcpUrl: "http://127.0.0.1:43891/mcp",
    healthCommand: "curl --fail --silent http://127.0.0.1:43891/health",
    tunnelDocumentationUrl: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
    requiredTools: [
      "request_get",
      "context_search",
      "context_read",
      "diff_get",
      "attachment_get",
      "request_complete",
    ],
  },
});

const buildDefaultRunCommand = (input: SetupClientsInput): (argv: readonly string[]) => Promise<CommandResult> => {
  const spawnCommand = input.spawnCommand ?? defaultSpawnCommand;
  const now = input.now ?? defaultNow;
  const awaitWithin = input.awaitWithin ?? defaultAwaitWithin;

  return async (argv: readonly string[]): Promise<CommandResult> => {
    const deadline = now() + COMMAND_TIMEOUT_MS;
    const child = spawnCommand(argv);

    const stdoutReader = child.stdout?.getReader();
    const stderrReader = child.stderr?.getReader();

    const readBounded = async (
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      label: string,
    ): Promise<string> => {
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > BOUNDED_OUTPUT_CAP) {
          throw new Error(`${label} overflow`);
        }
        chunks.push(value);
      }
      const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const output = new TextDecoder().decode(Buffer.concat(chunks, total));
      try { reader.releaseLock(); } catch { /* bounded */ }
      return output;
    };

    const stdoutPromise = readBounded(stdoutReader, "stdout");
    const stderrPromise = readBounded(stderrReader, "stderr");
    stdoutPromise.catch(() => {});
    stderrPromise.catch(() => {});

    const cleanup = async (): Promise<CommandResult> => {
      try { child.kill("SIGTERM"); } catch { /* bounded */ }

      const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => {
        try {
          await reader?.cancel();
        } catch { /* bounded */ }
        finally {
          try { reader?.releaseLock(); } catch { /* bounded */ }
        }
      };

      const stdoutCancel = cancelReader(stdoutReader);
      const stderrCancel = cancelReader(stderrReader);
      const cancelAll = Promise.allSettled([stdoutCancel, stderrCancel]);

      try {
        await awaitWithin(
          () => Promise.all([child.exited, cancelAll]),
          SIGTERM_BUDGET_MS,
        );
      } catch {
        try { child.kill("SIGKILL"); } catch { /* bounded */ }
        try {
          await awaitWithin(
            () => Promise.all([child.exited, cancelAll]),
            SIGKILL_BUDGET_MS,
          );
        } catch { /* bounded cleanup failure */ }
      }

      try {
        await awaitWithin(
          () => Promise.allSettled([stdoutPromise, stderrPromise]),
          BOUNDED_DRAIN_MS,
        );
      } catch { /* bounded */ }

      return { status: 1, stdout: "", stderr: "" };
    };

    const remaining = deadline - now();
    if (remaining <= 0) {
      return cleanup();
    }

    try {
      const [stdout, stderr, status] = await awaitWithin(
        () => Promise.all([stdoutPromise, stderrPromise, child.exited]),
        remaining,
      );

      if (now() >= deadline) {
        return cleanup();
      }

      return { status, stdout, stderr };
    } catch {
      return cleanup();
    }
  };
};

const buildAddArgv = (client: ClientName, absoluteBin: string): readonly string[] => {
  if (client === "codex") {
    return ["codex", "mcp", "add", SERVER_NAME, "--", "bun", "run", absoluteBin, "serve", "local"];
  }
  return ["claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", "bun", "run", absoluteBin, "serve", "local"];
};

const buildGetArgv = (client: ClientName): readonly string[] => {
  if (client === "codex") {
    return ["codex", "mcp", "get", SERVER_NAME, "--json"];
  }
  return ["claude", "mcp", "get", SERVER_NAME];
};

const buildRemoveArgv = (client: ClientName): readonly string[] => {
  if (client === "codex") {
    return ["codex", "mcp", "remove", SERVER_NAME];
  }
  return ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME];
};

const isCodexNamedNotFound = (stderr: string): boolean => {
  return stderr.trim() === `Error: No MCP server named '${SERVER_NAME}' found.`;
};

const isClaudeNamedNotFound = (stderr: string): boolean => {
  const trimmed = stderr.trim();
  const base = `No MCP server named "${SERVER_NAME}".`;
  if (trimmed === base) return true;
  const prefix = base + " Configured servers: ";
  if (trimmed.startsWith(prefix)) {
    const suffix = trimmed.slice(prefix.length);
    return suffix.length > 0 && suffix.length <= 4096 && /^[^\x00-\x1F\x7F]+$/.test(suffix);
  }
  return false;
};

const CODEX_KNOWN_ROOT_KEYS = new Set([
  "name", "enabled", "disabled_reason", "transport",
  "enabled_tools", "disabled_tools", "startup_timeout_sec", "tool_timeout_sec",
]);
const CODEX_KNOWN_STDIO_KEYS = new Set(["type", "command", "args", "env", "env_vars", "cwd"]);

const parseCodexGet = (stdout: string, absoluteBin: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Malformed JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  const envelope = parsed as Record<string, unknown>;

  const envelopeKeys = new Set(Object.keys(envelope));
  for (const key of CODEX_KNOWN_ROOT_KEYS) {
    if (!envelopeKeys.has(key)) return false;
  }
  for (const key of envelopeKeys) {
    if (!CODEX_KNOWN_ROOT_KEYS.has(key)) return false;
  }

  if (envelope.name !== SERVER_NAME) return false;
  if (envelope.enabled !== true) return false;
  if (envelope.disabled_reason !== null && envelope.disabled_reason !== undefined) return false;

  const transport = envelope.transport;
  if (typeof transport !== "object" || transport === null || Array.isArray(transport)) {
    return false;
  }

  const t = transport as Record<string, unknown>;

  const transportKeys = new Set(Object.keys(t));
  for (const key of CODEX_KNOWN_STDIO_KEYS) {
    if (!transportKeys.has(key)) return false;
  }
  for (const key of transportKeys) {
    if (!CODEX_KNOWN_STDIO_KEYS.has(key)) return false;
  }

  if (t.type !== "stdio") return false;
  if (t.command !== "bun") return false;
  if (!Array.isArray(t.args)) return false;

  const expectedArgs = ["run", absoluteBin, "serve", "local"];
  if (t.args.length !== expectedArgs.length) return false;
  for (let i = 0; i < expectedArgs.length; i++) {
    if (t.args[i] !== expectedArgs[i]) return false;
  }

  if (t.env !== null && t.env !== undefined) return false;
  if (Array.isArray(t.env_vars) && t.env_vars.length > 0) return false;
  if (t.env_vars !== null && t.env_vars !== undefined && !Array.isArray(t.env_vars)) return false;
  if (t.cwd !== null && t.cwd !== undefined) return false;

  if (envelope.enabled_tools !== null && envelope.enabled_tools !== undefined) return false;
  if (envelope.disabled_tools !== null && envelope.disabled_tools !== undefined) return false;
  if (envelope.startup_timeout_sec !== null && envelope.startup_timeout_sec !== undefined) return false;
  if (envelope.tool_timeout_sec !== null && envelope.tool_timeout_sec !== undefined) return false;

  return true;
};

const CLAUDE_COMPACT_KNOWN_KEYS = new Set(["Type", "Command", "Args", "Environment"]);
const CLAUDE_FULL_FORM_KNOWN_KEYS = new Set(["Scope", "Status", "Type", "Command", "Args", "Environment"]);
const CLAUDE_EXPECTED_SCOPE = "User config (available in all your projects)";
const FIELD_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/;

const parseClaudeGet = (stdout: string, absoluteBin: string): boolean => {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length === 0) throw new Error("Empty output");

  if (lines[0] === `${SERVER_NAME}:`) {
    return parseClaudeFullForm(lines, absoluteBin);
  }

  return parseClaudeCompactForm(lines, absoluteBin);
};

const parseClaudeFullForm = (lines: string[], absoluteBin: string): boolean => {
  const expectedRemovalHint = `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`;
  const lastLine = lines[lines.length - 1];
  if (lastLine !== expectedRemovalHint) throw new Error("Wrong removal hint");

  const fieldLines = lines.slice(1, -1);
  const fields: Record<string, string[]> = {};

  for (const line of fieldLines) {
    const match = line.match(FIELD_PATTERN);
    if (!match) throw new Error("Malformed line in full form");
    const key = match[1]!;
    const value = match[2] ?? "";
    if (!CLAUDE_FULL_FORM_KNOWN_KEYS.has(key)) throw new Error("Unknown field in full form");
    if (!fields[key]) fields[key] = [];
    fields[key]!.push(value);
  }

  for (const key of CLAUDE_FULL_FORM_KNOWN_KEYS) {
    const values = fields[key] ?? [];
    if (values.length !== 1) throw new Error(`Expected exactly one ${key}`);
  }

  if (fields["Scope"]![0] !== CLAUDE_EXPECTED_SCOPE) return false;
  if (fields["Status"]![0] === "") throw new Error("Empty Status");
  if (fields["Type"]![0] !== "stdio") return false;
  if (fields["Command"]![0] !== "bun") return false;
  if (fields["Environment"]![0] !== "") return false;

  const expectedArgs = `run ${absoluteBin} serve local`;
  return fields["Args"]![0] === expectedArgs;
};

const parseClaudeCompactForm = (lines: string[], absoluteBin: string): boolean => {
  const fields: Record<string, string[]> = {};

  for (const line of lines) {
    const match = line.match(FIELD_PATTERN);
    if (!match) throw new Error("Malformed line");
    const key = match[1]!;
    const value = match[2] ?? "";
    if (!CLAUDE_COMPACT_KNOWN_KEYS.has(key)) throw new Error("Lookalike field");
    if (!fields[key]) fields[key] = [];
    fields[key]!.push(value);
  }

  const typeValues = fields["Type"] ?? [];
  const commandValues = fields["Command"] ?? [];
  const argsValues = fields["Args"] ?? [];
  const envValues = fields["Environment"] ?? [];

  if (typeValues.length !== 1) throw new Error("Ambiguous Type");
  if (commandValues.length !== 1) throw new Error("Ambiguous Command");
  if (argsValues.length !== 1) throw new Error("Ambiguous Args");
  if (envValues.length > 1) throw new Error("Ambiguous Environment");

  if (typeValues[0] !== "stdio") return false;
  if (commandValues[0] !== "bun") return false;
  if (envValues.length === 1 && envValues[0] !== "") return false;

  const expectedArgs = `run ${absoluteBin} serve local`;
  return argsValues[0] === expectedArgs;
};

const inspectClient = async (
  client: ClientName,
  absoluteBin: string,
  runCommand: (argv: readonly string[]) => Promise<CommandResult>,
): Promise<{ status: ClientStatus; message: string }> => {
  const getArgv = buildGetArgv(client);
  const result = await runCommand(getArgv);

  if (Buffer.byteLength(result.stdout, "utf8") > BOUNDED_PARSER_INPUT ||
      Buffer.byteLength(result.stderr, "utf8") > BOUNDED_PARSER_INPUT) {
    return { status: "error", message: "Output exceeds parser limit" };
  }

  if (result.status === 0) {
    try {
      const isCurrent = client === "codex"
        ? parseCodexGet(result.stdout, absoluteBin)
        : parseClaudeGet(result.stdout, absoluteBin);

      if (isCurrent) {
        return { status: "current", message: "Entry is current" };
      }
      return { status: "mismatch", message: "Entry differs" };
    } catch {
      return { status: "error", message: "Malformed get output" };
    }
  }

  if (result.status === 1 && result.stdout === "") {
    const isNamedNotFound = client === "codex"
      ? isCodexNamedNotFound(result.stderr)
      : isClaudeNamedNotFound(result.stderr);

    if (isNamedNotFound) {
      return { status: "absent", message: "Entry not found" };
    }
  }

  return { status: "error", message: "Get command failed" };
};

export const setupClients = async (input: SetupClientsInput): Promise<SetupClientsResult> => {
  const resolveSourceBinary = input.resolveSourceBinary ?? defaultResolveSourceBinary;
  const isExecutableAvailable = input.isExecutableAvailable ?? defaultIsExecutableAvailable;
  const runCommand = input.runCommand ?? buildDefaultRunCommand(input);

  let absoluteBin: string;
  try {
    absoluteBin = await resolveSourceBinary();
  } catch {
    const clients = CLIENTS.map((client) => ({
      client,
      status: "error" as const,
      action: "error" as const,
      message: "Binary resolution failed",
    }));
    return {
      kind: "clients",
      mode: input.apply ? "apply" : "preview",
      success: false,
      clients,
    };
  }

  const clients: ClientResult[] = [];

  for (const client of CLIENTS) {
    let available: boolean;
    try {
      available = await isExecutableAvailable(client);
    } catch {
      clients.push({
        client,
        status: "error",
        action: "error",
        message: "Availability check failed",
      });
      continue;
    }

    if (!available) {
      clients.push({
        client,
        status: "skipped",
        action: "skipped",
        message: `${client} CLI not available`,
      });
      continue;
    }

    let inspection: { status: ClientStatus; message: string };
    try {
      inspection = await inspectClient(client, absoluteBin, runCommand);
    } catch {
      clients.push({
        client,
        status: "error",
        action: "error",
        message: "Query failed",
      });
      continue;
    }

    const addArgv = buildAddArgv(client, absoluteBin);
    const removeArgv = buildRemoveArgv(client);

    if (inspection.status === "current") {
      clients.push({
        client,
        status: "current",
        action: "none",
        message: inspection.message,
      });
      continue;
    }

    if (inspection.status === "absent") {
      if (!input.apply) {
        clients.push({
          client,
          status: "absent",
          action: "add",
          addArgv,
          message: inspection.message,
        });
        continue;
      }

      try {
        const addResult = await runCommand(addArgv);
        if (addResult.status !== 0) {
          clients.push({
            client,
            status: "error",
            action: "error",
            addArgv,
            message: "Add command failed",
          });
          continue;
        }
      } catch {
        clients.push({
          client,
          status: "error",
          action: "error",
          addArgv,
          message: "Add command failed",
        });
        continue;
      }

      clients.push({
        client,
        status: "absent",
        action: "add",
        addArgv,
        message: "Added entry",
      });
      continue;
    }

    if (inspection.status === "mismatch") {
      if (!input.apply) {
        clients.push({
          client,
          status: "mismatch",
          action: "replace",
          addArgv,
          removeArgv,
          message: inspection.message,
        });
        continue;
      }

      if (!input.replace) {
        clients.push({
          client,
          status: "mismatch",
          action: "error",
          addArgv,
          removeArgv,
          message: "Replace required to update entry",
        });
        continue;
      }

      try {
        const removeResult = await runCommand(removeArgv);
        if (removeResult.status !== 0) {
          clients.push({
            client,
            status: "error",
            action: "error",
            addArgv,
            removeArgv,
            message: "Remove command failed",
          });
          continue;
        }
      } catch {
        clients.push({
          client,
          status: "error",
          action: "error",
          addArgv,
          removeArgv,
          message: "Remove command failed",
        });
        continue;
      }

      try {
        const addResult = await runCommand(addArgv);
        if (addResult.status !== 0) {
          clients.push({
            client,
            status: "error",
            action: "error",
            addArgv,
            removeArgv,
            message: "Add command failed",
          });
          continue;
        }
      } catch {
        clients.push({
          client,
          status: "error",
          action: "error",
          addArgv,
          removeArgv,
          message: "Add command failed",
        });
        continue;
      }

      clients.push({
        client,
        status: "mismatch",
        action: "replace",
        addArgv,
        removeArgv,
        message: "Replaced entry",
      });
      continue;
    }

    clients.push({
      client,
      status: "error",
      action: "error",
      message: inspection.message,
    });
  }

  return {
    kind: "clients",
    mode: input.apply ? "apply" : "preview",
    success: clients.every((client) => client.action !== "error"),
    clients,
  };
};
