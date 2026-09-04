import { describe, expect, test } from "bun:test";
import {
  getChatgptSetupGuidance,
  setupClients,
  type SetupClientsInput,
  type ClientStatus,
  type SpawnedChild,
} from "../src/cli/setup";

const FAKE_BIN = "/opt/project/bin/chatgpt-consult.ts";
const SERVER_NAME = "chatgpt-consult";

const CODEX_NOT_FOUND = `Error: No MCP server named '${SERVER_NAME}' found.`;
const CLAUDE_NOT_FOUND = `No MCP server named "${SERVER_NAME}".`;
const CLAUDE_NOT_FOUND_WITH_SERVERS = `No MCP server named "${SERVER_NAME}". Configured servers: other-server`;
const CLAUDE_NOT_FOUND_REALISTIC = `No MCP server named "${SERVER_NAME}". Configured servers: mcp-fetch (v1.2.3) — github.com/user/repo, mcp-filesystem (v2.0.0) \`/mcp\``;

const codexAddArgv = (bin: string): readonly string[] => [
  "codex", "mcp", "add", SERVER_NAME, "--",
  "bun", "run", bin, "serve", "local",
];

const claudeAddArgv = (bin: string): readonly string[] => [
  "claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--",
  "bun", "run", bin, "serve", "local",
];

const codexGetArgv: readonly string[] = ["codex", "mcp", "get", SERVER_NAME, "--json"];
const claudeGetArgv: readonly string[] = ["claude", "mcp", "get", SERVER_NAME];
const codexRemoveArgv: readonly string[] = ["codex", "mcp", "remove", SERVER_NAME];
const claudeRemoveArgv: readonly string[] = ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME];

interface RecordedCall {
  readonly argv: readonly string[];
}

const createRecorder = (
  handlers: Record<string, (argv: readonly string[]) => { status: number; stdout: string; stderr: string }>,
) => {
  const calls: RecordedCall[] = [];
  const remaining = new Map(Object.keys(handlers).map((pattern) => [
    pattern,
    /^(?:codex|claude)\b/.test(pattern) ? 1 : 2,
  ]));
  const runCommand = async (argv: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
    calls.push({ argv });
    const key = argv.join(" ");
    const matches = Object.keys(handlers)
      .filter((pattern) => key.includes(pattern))
      .sort((left, right) => right.length - left.length);
    if (matches.length === 0) throw new Error(`Unexpected command: ${key}`);
    if (matches.length > 1 && matches[0]!.length === matches[1]!.length) {
      throw new Error(`Ambiguous command handler: ${key}`);
    }
    const pattern = matches[0]!;
    const available = remaining.get(pattern) ?? 0;
    if (available <= 0) throw new Error(`Command handler exhausted: ${pattern}`);
    remaining.set(pattern, available - 1);
    return handlers[pattern]!(argv);
  };
  return { calls, runCommand };
};

const defaultInput = (overrides: Partial<SetupClientsInput> = {}): SetupClientsInput => ({
  apply: false,
  replace: false,
  resolveSourceBinary: async () => FAKE_BIN,
  isExecutableAvailable: async () => true,
  ...overrides,
});

const codexEnvelope = (bin: string): string => JSON.stringify({
  name: SERVER_NAME,
  enabled: true,
  disabled_reason: null,
  transport: {
    type: "stdio",
    command: "bun",
    args: ["run", bin, "serve", "local"],
    env: null,
    env_vars: [],
    cwd: null,
  },
  enabled_tools: null,
  disabled_tools: null,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
});

const claudeCurrentText = (bin: string): string => [
  "Type: stdio",
  "Command: bun",
  `Args: run ${bin} serve local`,
].join("\n");

const claudeWithEmptyEnv = (bin: string): string => [
  "Type: stdio",
  "Command: bun",
  `Args: run ${bin} serve local`,
  "Environment:",
].join("\n");

const claudeFullForm = (bin: string, status: string = "connected"): string => [
  `${SERVER_NAME}:`,
  `Scope: User config (available in all your projects)`,
  `Status: ${status}`,
  `Type: stdio`,
  `Command: bun`,
  `Args: run ${bin} serve local`,
  `Environment:`,
  ``,
  `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
].join("\n");

const mutatingCallsFor = (calls: RecordedCall[], client: string): RecordedCall[] =>
  calls.filter((c) => c.argv[0] === client && (c.argv.includes("remove") || c.argv.includes("add")));

describe("setupClients", () => {
  test("returns a stable preview result envelope", async () => {
    const { runCommand } = createRecorder({
      "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
      "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
    });

    const result = await setupClients(defaultInput({ runCommand }));

    expect(result.kind).toBe("clients");
    expect(result.mode).toBe("preview");
    expect(result.success).toBeTrue();
  });

  test("marks the stable apply result unsuccessful when a client action errors", async () => {
    const { runCommand } = createRecorder({
      "codex mcp get": () => ({ status: 2, stdout: "", stderr: "failed" }),
      "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      "claude mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
    });

    const result = await setupClients(defaultInput({ apply: true, runCommand }));

    expect(result.mode).toBe("apply");
    expect(result.success).toBeFalse();
  });

  test("recorder rejects duplicate or unexpected invocations", async () => {
    const { runCommand } = createRecorder({
      "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
    });

    await runCommand(codexGetArgv);
    expect(runCommand(codexGetArgv)).rejects.toThrow("exhausted");
    expect(runCommand(["codex", "unexpected"])).rejects.toThrow("Unexpected command");
  });

  describe("preview mode (default)", () => {
    test("makes zero mutating calls and returns deterministic preview argv for absent entries", async () => {
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));

      expect(result.clients).toHaveLength(2);
      expect(result.clients[0]?.client).toBe("codex");
      expect(result.clients[1]?.client).toBe("claude");
      expect(result.clients[0]?.status).toBe("absent");
      expect(result.clients[0]?.action).toBe("add");
      expect(result.clients[0]?.addArgv).toEqual(codexAddArgv(FAKE_BIN));
      expect(result.clients[1]?.status).toBe("absent");
      expect(result.clients[1]?.action).toBe("add");
      expect(result.clients[1]?.addArgv).toEqual(claudeAddArgv(FAKE_BIN));

      expect(calls.filter((c) => c.argv.includes("add") || c.argv.includes("remove"))).toHaveLength(0);
    });

    test("reports current entries with no action and no argv", async () => {
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(FAKE_BIN), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(FAKE_BIN), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));

      expect(result.clients[0]?.status).toBe("current");
      expect(result.clients[0]?.action).toBe("none");
      expect(result.clients[0]?.addArgv).toBeUndefined();
      expect(result.clients[0]?.removeArgv).toBeUndefined();
      expect(result.clients[1]?.status).toBe("current");
      expect(result.clients[1]?.action).toBe("none");
      expect(result.clients[1]?.addArgv).toBeUndefined();

      expect(calls.filter((c) => c.argv.includes("add") || c.argv.includes("remove"))).toHaveLength(0);
    });

    test("reports mismatch with proposed replace action but does not execute", async () => {
      const wrongBin = "/other/path/bin/chatgpt-consult.ts";
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(wrongBin), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(wrongBin), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));

      expect(result.clients[0]?.status).toBe("mismatch");
      expect(result.clients[0]?.action).toBe("replace");
      expect(result.clients[0]?.removeArgv).toEqual(codexRemoveArgv);
      expect(result.clients[1]?.status).toBe("mismatch");
      expect(result.clients[1]?.action).toBe("replace");
      expect(result.clients[1]?.removeArgv).toEqual(claudeRemoveArgv);

      expect(calls.filter((c) => c.argv.includes("add") || c.argv.includes("remove"))).toHaveLength(0);
    });
  });

  describe("missing executable", () => {
    test("skips client when executable is not available with no argv", async () => {
      const { calls, runCommand } = createRecorder({
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({
        isExecutableAvailable: async (name) => name !== "codex",
        runCommand,
      }));

      expect(result.clients[0]?.client).toBe("codex");
      expect(result.clients[0]?.status).toBe("skipped");
      expect(result.clients[0]?.action).toBe("skipped");
      expect(result.clients[0]?.addArgv).toBeUndefined();
      expect(result.clients[0]?.removeArgv).toBeUndefined();
      expect(result.clients[1]?.client).toBe("claude");
      expect(result.clients[1]?.status).toBe("absent");

      expect(calls.filter((c) => c.argv[0] === "codex")).toHaveLength(0);
    });
  });

  describe("strict Codex envelope recognition", () => {
    const claudeAbsent = () => ({ status: 1 as const, stdout: "", stderr: CLAUDE_NOT_FOUND });

    test("accepts the canonical enabled envelope", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(FAKE_BIN), stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("current");
    });

    test("rejects wrong name", async () => {
      const wrong = JSON.stringify({
        name: "other-server",
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: null, env_vars: [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: wrong, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects disabled entry", async () => {
      const disabled = JSON.stringify({
        name: SERVER_NAME,
        enabled: false,
        disabled_reason: "manually disabled",
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: null, env_vars: [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: disabled, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects non-null env", async () => {
      const withEnv = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: { KEY: "val" }, env_vars: [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: withEnv, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects non-empty env_vars", async () => {
      const withEnvVars = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: null, env_vars: ["SECRET"], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: withEnvVars, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects non-null cwd", async () => {
      const withCwd = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: null, env_vars: [], cwd: "/some/path" },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: withCwd, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects tool restrictions", async () => {
      const withTools = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: null, env_vars: [], cwd: null },
        enabled_tools: ["tool_a"],
        disabled_tools: null,
        startup_timeout_sec: null,
        tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: withTools, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects custom timeouts", async () => {
      const withTimeout = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local"], env: null, env_vars: [], cwd: null },
        enabled_tools: null,
        disabled_tools: null,
        startup_timeout_sec: 30,
        tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: withTimeout, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects URL transport", async () => {
      const urlTransport = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "url", url: "http://localhost:3000" },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: urlTransport, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects extra args", async () => {
      const extraArgs = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", FAKE_BIN, "serve", "local", "--extra"], env: null, env_vars: [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: extraArgs, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects malformed JSON", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: "{invalid json", stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("error");
    });

    test("rejects unknown root key", async () => {
      const obj = JSON.parse(codexEnvelope(FAKE_BIN));
      obj.extra_field = "unexpected";
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: JSON.stringify(obj), stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects transport.headers key", async () => {
      const obj = JSON.parse(codexEnvelope(FAKE_BIN));
      obj.transport.headers = {};
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: JSON.stringify(obj), stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test("rejects transport.url key", async () => {
      const obj = JSON.parse(codexEnvelope(FAKE_BIN));
      obj.transport.url = "http://localhost";
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: JSON.stringify(obj), stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("mismatch");
    });

    test.each([
      ["missing root key 'name'", "name"],
      ["missing root key 'enabled'", "enabled"],
      ["missing root key 'transport'", "transport"],
      ["missing root key 'disabled_reason'", "disabled_reason"],
      ["missing transport key 'type'", "transport.type"],
      ["missing transport key 'command'", "transport.command"],
      ["missing transport key 'args'", "transport.args"],
    ])("rejects Codex envelope with %s", async (_, path) => {
      const obj = JSON.parse(codexEnvelope(FAKE_BIN));
      if (path.startsWith("transport.")) {
        delete obj.transport[path.slice("transport.".length)];
      } else {
        delete obj[path];
      }
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: JSON.stringify(obj), stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).not.toBe("current");
    });
  });

  describe("strict Claude recognition", () => {
    const codexAbsent = () => ({ status: 1 as const, stdout: "", stderr: CODEX_NOT_FOUND });

    test("accepts canonical output with empty Environment line", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({ status: 0, stdout: claudeWithEmptyEnv(FAKE_BIN), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("current");
    });

    test("rejects non-empty Environment value", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local`,
            "Environment: SECRET=val",
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("mismatch");
    });

    test("rejects Headers authority", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local`,
            "Headers: Authorization=Bearer x",
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects URL authority", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local`,
            "URL: http://localhost:3000",
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects lookalike field names", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local`,
            "Typee: stdio",
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects duplicate Type lines", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Type: stdio",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local`,
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects extra args", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local --extra`,
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("mismatch");
    });

    test("rejects wrong command", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "Command: node",
            `Args: run ${FAKE_BIN} serve local`,
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("mismatch");
    });

    test("rejects malformed lines", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({
          status: 0,
          stdout: [
            "Type: stdio",
            "this is not a field line",
            "Command: bun",
            `Args: run ${FAKE_BIN} serve local`,
          ].join("\n"),
          stderr: "",
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("accepts real installed claude mcp get full-form presentation", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({ status: 0, stdout: claudeFullForm(FAKE_BIN), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("current");
    });

    test("accepts full-form with non-connected Status", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({ status: 0, stdout: claudeFullForm(FAKE_BIN, "failed"), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("current");
    });

    test.each([
      ["wrong header name", [
        `other-server:`,
        `Scope: User config (available in all your projects)`,
        `Status: connected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove other-server -s user`,
      ].join("\n"), "error"],
      ["wrong removal hint", [
        `${SERVER_NAME}:`,
        `Scope: User config (available in all your projects)`,
        `Status: connected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove other-server -s user`,
      ].join("\n"), "error"],
      ["empty Status", [
        `${SERVER_NAME}:`,
        `Scope: User config (available in all your projects)`,
        `Status:`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
      ].join("\n"), "error"],
      ["duplicate Status", [
        `${SERVER_NAME}:`,
        `Scope: User config (available in all your projects)`,
        `Status: connected`,
        `Status: disconnected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
      ].join("\n"), "error"],
      ["missing Scope line", [
        `${SERVER_NAME}:`,
        `Status: connected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
      ].join("\n"), "error"],
      ["wrong scope", [
        `${SERVER_NAME}:`,
        `Scope: Project config`,
        `Status: connected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
      ].join("\n"), "mismatch"],
      ["non-empty Environment in full form", [
        `${SERVER_NAME}:`,
        `Scope: User config (available in all your projects)`,
        `Status: connected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment: SECRET=val`,
        ``,
        `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
      ].join("\n"), "mismatch"],
      ["trailing authority line", [
        `${SERVER_NAME}:`,
        `Scope: User config (available in all your projects)`,
        `Status: connected`,
        `Type: stdio`,
        `Command: bun`,
        `Args: run ${FAKE_BIN} serve local`,
        `Environment:`,
        ``,
        `To remove this server, run: claude mcp remove ${SERVER_NAME} -s user`,
        `ExtraAuthority: injected`,
      ].join("\n"), "error"],
    ])("rejects full-form with %s", async (_, stdout, expectedStatus) => {
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({ status: 0, stdout, stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe(expectedStatus as ClientStatus);
    });
  });

  describe("parser input bounds", () => {
    const codexAbsent = () => ({ status: 1 as const, stdout: "", stderr: CODEX_NOT_FOUND });
    const claudeAbsent = () => ({ status: 1 as const, stdout: "", stderr: CLAUDE_NOT_FOUND });
    const PARSER_CEILING = 16 * 1024;

    test("rejects oversized Claude stdout with canonical prefix padded beyond ceiling", async () => {
      const canonical = claudeCurrentText(FAKE_BIN);
      const seededTail = "AUTHORITY_LINE_SHOULD_NOT_APPEAR";
      const oversized = canonical + "\n" + "x".repeat(PARSER_CEILING) + "\n" + seededTail;
      const { runCommand } = createRecorder({
        "codex mcp get": codexAbsent,
        "claude mcp get": () => ({ status: 0, stdout: oversized, stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(seededTail);
    });

    test("rejects oversized Codex stdout with canonical JSON followed by oversized whitespace", async () => {
      const canonical = codexEnvelope(FAKE_BIN);
      const seededTail = "SECRET_TAIL_MARKER";
      const oversized = canonical + " ".repeat(PARSER_CEILING) + seededTail;
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: oversized, stderr: "" }),
        "claude mcp get": claudeAbsent,
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("error");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(seededTail);
    });
  });

  describe("apply mode", () => {
    test("runs add on absent entry", async () => {
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
        "mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, runCommand }));

      expect(result.clients[0]?.status).toBe("absent");
      expect(result.clients[0]?.action).toBe("add");
      expect(result.clients[1]?.status).toBe("absent");
      expect(result.clients[1]?.action).toBe("add");

      const addCalls = calls.filter((c) => c.argv.includes("add"));
      expect(addCalls).toHaveLength(2);
      expect(addCalls[0]?.argv).toEqual(codexAddArgv(FAKE_BIN));
      expect(addCalls[1]?.argv).toEqual(claudeAddArgv(FAKE_BIN));
    });

    test("runs nothing on current entry", async () => {
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(FAKE_BIN), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(FAKE_BIN), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, runCommand }));

      expect(result.clients[0]?.status).toBe("current");
      expect(result.clients[0]?.action).toBe("none");
      expect(result.clients[1]?.status).toBe("current");
      expect(result.clients[1]?.action).toBe("none");

      expect(calls.filter((c) => c.argv.includes("add") || c.argv.includes("remove"))).toHaveLength(0);
    });

    test("returns actionable error on mismatch without replace", async () => {
      const wrongBin = "/other/path/bin/chatgpt-consult.ts";
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(wrongBin), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(wrongBin), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, replace: false, runCommand }));

      expect(result.clients[0]?.status).toBe("mismatch");
      expect(result.clients[0]?.action).toBe("error");
      expect(result.clients[1]?.status).toBe("mismatch");
      expect(result.clients[1]?.action).toBe("error");

      expect(calls.filter((c) => c.argv.includes("add") || c.argv.includes("remove"))).toHaveLength(0);
    });

    test("runs remove then add on mismatch with replace for both clients", async () => {
      const wrongBin = "/other/path/bin/chatgpt-consult.ts";
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(wrongBin), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(wrongBin), stderr: "" }),
        "mcp remove": () => ({ status: 0, stdout: "", stderr: "" }),
        "mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, replace: true, runCommand }));

      expect(result.clients[0]?.status).toBe("mismatch");
      expect(result.clients[0]?.action).toBe("replace");
      expect(result.clients[1]?.status).toBe("mismatch");
      expect(result.clients[1]?.action).toBe("replace");

      const codexMutating = mutatingCallsFor(calls, "codex");
      expect(codexMutating).toHaveLength(2);
      expect(codexMutating[0]?.argv).toEqual(codexRemoveArgv);
      expect(codexMutating[1]?.argv).toEqual(codexAddArgv(FAKE_BIN));

      const claudeMutating = mutatingCallsFor(calls, "claude");
      expect(claudeMutating).toHaveLength(2);
      expect(claudeMutating[0]?.argv).toEqual(claudeRemoveArgv);
      expect(claudeMutating[1]?.argv).toEqual(claudeAddArgv(FAKE_BIN));
    });

    test("stops client on remove failure and does not touch other client", async () => {
      const wrongBin = "/other/path/bin/chatgpt-consult.ts";
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(wrongBin), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(wrongBin), stderr: "" }),
        "codex mcp remove": () => ({ status: 1, stdout: "", stderr: "remove failed" }),
        "claude mcp remove": () => ({ status: 0, stdout: "", stderr: "" }),
        "mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, replace: true, runCommand }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(result.clients[1]?.status).toBe("mismatch");
      expect(result.clients[1]?.action).toBe("replace");

      const codexMutating = mutatingCallsFor(calls, "codex");
      expect(codexMutating).toHaveLength(1);
      expect(codexMutating[0]?.argv).toEqual(codexRemoveArgv);

      const claudeMutating = mutatingCallsFor(calls, "claude");
      expect(claudeMutating).toHaveLength(2);
      expect(claudeMutating[0]?.argv).toEqual(claudeRemoveArgv);
      expect(claudeMutating[1]?.argv).toEqual(claudeAddArgv(FAKE_BIN));
    });
  });

  describe("failure isolation", () => {
    test("one client query failure does not prevent evaluating the other", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 2, stdout: "", stderr: "query failed" }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[1]?.status).toBe("absent");
    });

    test("add failure is reported per client", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
        "codex mcp add": () => ({ status: 1, stdout: "", stderr: "add failed" }),
        "claude mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, runCommand }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(result.clients[1]?.status).toBe("absent");
      expect(result.clients[1]?.action).toBe("add");
    });

    test("thrown availability check is contained per client", async () => {
      const { runCommand } = createRecorder({
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({
        isExecutableAvailable: async (name) => {
          if (name === "codex") throw new Error("SECRET_AVAILABILITY_ERROR");
          return true;
        },
        runCommand,
      }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(result.clients[1]?.status).toBe("absent");

      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain("SECRET_AVAILABILITY_ERROR");
    });

    test("thrown query is contained per client", async () => {
      const runCommand = async (argv: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
        if (argv[0] === "codex") throw new Error("SECRET_QUERY_ERROR");
        return { status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND };
      };
      const result = await setupClients(defaultInput({ runCommand }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[1]?.status).toBe("absent");

      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain("SECRET_QUERY_ERROR");
    });

    test("thrown mutation is contained per client and does not add", async () => {
      const wrongBin = "/other/path/bin/chatgpt-consult.ts";
      let addCalled = false;
      const runCommand = async (argv: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
        if (argv.includes("get") && argv[0] === "codex") {
          return { status: 0, stdout: codexEnvelope(wrongBin), stderr: "" };
        }
        if (argv.includes("get") && argv[0] === "claude") {
          return { status: 0, stdout: claudeCurrentText(wrongBin), stderr: "" };
        }
        if (argv.includes("remove") && argv[0] === "codex") {
          throw new Error("SECRET_REMOVE_ERROR");
        }
        if (argv.includes("remove") && argv[0] === "claude") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (argv.includes("add") && argv[0] === "codex") {
          addCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (argv.includes("add") && argv[0] === "claude") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unknown" };
      };
      const result = await setupClients(defaultInput({ apply: true, replace: true, runCommand }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(addCalled).toBe(false);
      expect(result.clients[1]?.status).toBe("mismatch");
      expect(result.clients[1]?.action).toBe("replace");

      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain("SECRET_REMOVE_ERROR");
    });
  });

  describe("bounded output", () => {
    test("result does not include raw stdout/stderr", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
        "codex mcp add": () => ({ status: 0, stdout: "SUCCESS_OUTPUT", stderr: "" }),
        "claude mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, runCommand }));

      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain("SUCCESS_OUTPUT");
    });

    test("result does not expose environment or credentials", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
        "mcp add": () => ({ status: 0, stdout: "", stderr: "" }),
      });
      const result = await setupClients(defaultInput({ apply: true, runCommand }));

      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain("HOME");
      expect(resultJson).not.toContain("API_KEY");
    });
  });

  describe("default resolver", () => {
    test("uses injected resolver without reading real MCP configuration", async () => {
      const customBin = "/custom/path/to/binary.ts";
      const { calls, runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({
        resolveSourceBinary: async () => customBin,
        runCommand,
      }));

      expect(result.clients[0]?.addArgv).toEqual(codexAddArgv(customBin));
      expect(result.clients[1]?.addArgv).toEqual(claudeAddArgv(customBin));

      const getCalls = calls.filter((c) => c.argv.includes("get"));
      expect(getCalls).toHaveLength(2);
      expect(getCalls[0]?.argv).toEqual(codexGetArgv);
      expect(getCalls[1]?.argv).toEqual(claudeGetArgv);
    });
  });

  describe("exact named-not-found recognition", () => {
    test("accepts exact Codex named not-found", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));

      expect(result.clients[0]?.status).toBe("absent");
      expect(result.clients[1]?.status).toBe("absent");
    });

    test("accepts Claude named not-found with configured servers suffix", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND_WITH_SERVERS }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("absent");
    });

    test("accepts Claude named not-found with realistic punctuation suffix", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND_REALISTIC }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("absent");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("mcp-fetch");
      expect(serialized).not.toContain("github.com");
    });

    test("rejects generic command not found as error", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: "codex: command not found" }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: "claude: command not found" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects different server name in Codex not-found", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: "Error: No MCP server named 'other-server' found." }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("error");
    });

    test("rejects different server name in Claude not-found", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: 'No MCP server named "other-server".' }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects not found phrase inside another error", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: `Something failed: not found in config for ${SERVER_NAME}` }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("error");
    });

    test("rejects Claude configured-server suffix with control characters", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({
          status: 1,
          stdout: "",
          stderr: `No MCP server named "${SERVER_NAME}". Configured servers: server\x01name`,
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects Claude configured-server suffix with embedded newline", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({
          status: 1,
          stdout: "",
          stderr: `No MCP server named "${SERVER_NAME}". Configured servers: server-a\nserver-b`,
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects Claude empty configured-server suffix", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND }),
        "claude mcp get": () => ({
          status: 1,
          stdout: "",
          stderr: `No MCP server named "${SERVER_NAME}". Configured servers: `,
        }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[1]?.status).toBe("error");
    });

    test("rejects extra diagnostic text after Codex not-found", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({
          status: 1,
          stdout: "",
          stderr: `Error: No MCP server named '${SERVER_NAME}' found.\nAdditional diagnostics here`,
        }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      expect(result.clients[0]?.status).toBe("error");
    });
  });

  describe("path-bearing action data limits", () => {
    test("current result does not contain the fake absolute path", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 0, stdout: codexEnvelope(FAKE_BIN), stderr: "" }),
        "claude mcp get": () => ({ status: 0, stdout: claudeCurrentText(FAKE_BIN), stderr: "" }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(FAKE_BIN);
    });

    test("skipped result does not contain the fake absolute path", async () => {
      const { runCommand } = createRecorder({
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({
        isExecutableAvailable: async (name) => name !== "codex",
        runCommand,
      }));
      const codexResult = result.clients.find((c) => c.client === "codex");
      expect(codexResult?.status).toBe("skipped");
      const serialized = JSON.stringify(codexResult);
      expect(serialized).not.toContain(FAKE_BIN);
    });

    test("query-error result does not contain the fake absolute path", async () => {
      const { runCommand } = createRecorder({
        "codex mcp get": () => ({ status: 2, stdout: "", stderr: "query failed" }),
        "claude mcp get": () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND }),
      });
      const result = await setupClients(defaultInput({ runCommand }));
      const codexResult = result.clients.find((c) => c.client === "codex");
      expect(codexResult?.status).toBe("error");
      const serialized = JSON.stringify(codexResult);
      expect(serialized).not.toContain(FAKE_BIN);
    });
  });

  describe("exact absent envelope guard", () => {
    test.each([
      ["status 2 with named stderr (codex)", "codex", { status: 2, stdout: "", stderr: CODEX_NOT_FOUND }],
      ["status 2 with named stderr (claude)", "claude", { status: 2, stdout: "", stderr: CLAUDE_NOT_FOUND }],
      ["whitespace stdout with named stderr (codex)", "codex", { status: 1, stdout: "  ", stderr: CODEX_NOT_FOUND }],
      ["whitespace stdout with named stderr (claude)", "claude", { status: 1, stdout: "\n", stderr: CLAUDE_NOT_FOUND }],
      ["malformed stdout with named stderr (codex)", "codex", { status: 1, stdout: "{not json", stderr: CODEX_NOT_FOUND }],
      ["malformed stdout with named stderr (claude)", "claude", { status: 1, stdout: "Type: bad", stderr: CLAUDE_NOT_FOUND }],
      ["canonical codex stdout with named stderr", "codex", { status: 1, stdout: codexEnvelope(FAKE_BIN), stderr: CODEX_NOT_FOUND }],
      ["canonical claude stdout with named stderr", "claude", { status: 1, stdout: claudeCurrentText(FAKE_BIN), stderr: CLAUDE_NOT_FOUND }],
    ])("classifies %s as error with zero mutations", async (_label, client, getResult) => {
      const handlers: Record<string, (argv: readonly string[]) => { status: number; stdout: string; stderr: string }> = {};
      if (client === "codex") {
        handlers["codex mcp get"] = () => getResult;
        handlers["claude mcp get"] = () => ({ status: 1, stdout: "", stderr: CLAUDE_NOT_FOUND });
      } else {
        handlers["codex mcp get"] = () => ({ status: 1, stdout: "", stderr: CODEX_NOT_FOUND });
        handlers["claude mcp get"] = () => getResult;
      }
      const { calls, runCommand } = createRecorder(handlers);
      const result = await setupClients(defaultInput({ apply: true, runCommand }));

      const target = result.clients.find((c) => c.client === client);
      expect(target?.status).toBe("error");
      expect(target?.action).toBe("error");

      const mutating = calls.filter((c) => c.argv[0] === client && (c.argv.includes("add") || c.argv.includes("remove")));
      expect(mutating).toHaveLength(0);
    });
  });

  describe("bounded runner seams", () => {
    const OUTPUT_CAP = 64 * 1024;

    interface FakeChildHandle {
      child: SpawnedChild;
      killCalls: string[];
      resolveExited: (code: number) => void;
    }

    const createFakeChild = (opts: {
      stdoutChunks?: Uint8Array[];
      stderrChunks?: Uint8Array[];
      onCancelStdout?: () => void;
      onCancelStderr?: () => void;
      keepStdoutOpen?: boolean;
      keepStderrOpen?: boolean;
      autoResolveOnKill?: boolean;
    } = {}): FakeChildHandle => {
      const killCalls: string[] = [];
      let resolveExited!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { resolveExited = resolve; });

      const sc = opts.stdoutChunks ?? [];
      const ec = opts.stderrChunks ?? [];
      let si = 0, ei = 0;
      const sq = sc.length, eq = ec.length;

      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (si < sq) { controller.enqueue(sc[si++]); }
          else if (sq > 0 && !opts.keepStdoutOpen) { controller.close(); }
        },
        cancel() { opts.onCancelStdout?.(); },
      });

      const stderr = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (ei < eq) { controller.enqueue(ec[ei++]); }
          else if (eq > 0 && !opts.keepStderrOpen) { controller.close(); }
        },
        cancel() { opts.onCancelStderr?.(); },
      });

      const autoResolve = opts.autoResolveOnKill !== false;

      return {
        child: {
          stdout,
          stderr,
          exited,
          kill: (signal) => {
            killCalls.push(signal);
            if (autoResolve) resolveExited(0);
          },
        },
        killCalls,
        resolveExited,
      };
    };

    const createNow = (values: number[]) => {
      let i = 0;
      return (): number => {
        if (i >= values.length) throw new Error(`now queue exhausted at ${i}`);
        return values[i++]!;
      };
    };

    const createAwaitWithin = (behaviors: Array<"resolve" | "reject">) => {
      let i = 0;
      return async <T>(work: () => Promise<T>, _ms: number): Promise<T> => {
        if (i >= behaviors.length) throw new Error(`awaitWithin queue exhausted at ${i}`);
        const b = behaviors[i++];
        if (b === "resolve") return work();
        throw new Error("timeout");
      };
    };

    const codexOnlyInput = (overrides: Partial<SetupClientsInput> = {}): SetupClientsInput => ({
      apply: false,
      replace: false,
      resolveSourceBinary: async () => FAKE_BIN,
      isExecutableAvailable: async (name) => name === "codex",
      ...overrides,
    });

    test("post-await deadline check rejects nominal result and signals exact child with SIGTERM", async () => {
      const handle = createFakeChild({
        stdoutChunks: [new TextEncoder().encode("ok")],
        stderrChunks: [new Uint8Array(0)],
      });
      let spawned: SpawnedChild | undefined;
      const spawnCommand = () => { spawned = handle.child; handle.resolveExited(0); return handle.child; };
      const now = createNow([0, 0, 5000]);
      const awaitWithin = createAwaitWithin(["resolve", "resolve", "resolve"]);

      const result = await setupClients(codexOnlyInput({ spawnCommand, now, awaitWithin }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(handle.killCalls).toEqual(["SIGTERM"]);
      expect(spawned).toBe(handle.child);
    });

    test("main-await timeout records SIGTERM before both cancellation callbacks", async () => {
      const events: string[] = [];
      const handle = createFakeChild({
        onCancelStdout: () => events.push("cancel:stdout"),
        onCancelStderr: () => events.push("cancel:stderr"),
      });
      const origKill = handle.child.kill;
      handle.child.kill = (signal) => { events.push(`kill:${signal}`); origKill(signal); };

      const spawnCommand = () => handle.child;
      const now = createNow([0, 0]);
      const awaitWithin = createAwaitWithin(["reject", "resolve", "resolve"]);

      await setupClients(codexOnlyInput({ spawnCommand, now, awaitWithin }));

      const sigtermIdx = events.indexOf("kill:SIGTERM");
      const cancelOutIdx = events.indexOf("cancel:stdout");
      const cancelErrIdx = events.indexOf("cancel:stderr");
      expect(sigtermIdx).toBeGreaterThanOrEqual(0);
      expect(cancelOutIdx).toBeGreaterThan(sigtermIdx);
      expect(cancelErrIdx).toBeGreaterThan(sigtermIdx);
    });

    test("SIGTERM cleanup timeout escalates same child to SIGKILL and setup awaits exact exited", async () => {
      const handle = createFakeChild({ autoResolveOnKill: false });
      const spawnCommand = () => handle.child;
      const now = createNow([0, 0]);
      const awaitWithin = createAwaitWithin(["reject", "reject", "resolve", "resolve"]);

      let returned = false;
      const setupPromise = setupClients(codexOnlyInput({ spawnCommand, now, awaitWithin }))
        .then((r) => { returned = true; return r; });

      while (handle.killCalls.length < 2 || handle.killCalls[1] !== "SIGKILL") {
        await Promise.resolve();
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(returned).toBe(false);

      handle.resolveExited(0);
      const result = await setupPromise;
      expect(returned).toBe(true);
      expect(handle.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
      expect(result.clients[0]?.status).toBe("error");
    });

    test("stdout overflow produces sanitized error and exact-child cleanup", async () => {
      const cancelled: string[] = [];
      const big = new Uint8Array(OUTPUT_CAP + 1);
      const handle = createFakeChild({
        stdoutChunks: [big],
        keepStdoutOpen: true,
        onCancelStdout: () => cancelled.push("stdout"),
        onCancelStderr: () => cancelled.push("stderr"),
      });
      const spawnCommand = () => handle.child;
      const now = createNow([0, 0]);
      const awaitWithin = createAwaitWithin(["resolve", "resolve", "resolve"]);

      const result = await setupClients(codexOnlyInput({ spawnCommand, now, awaitWithin }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.message).toBe("Get command failed");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("overflow");
      expect(handle.killCalls[0]).toBe("SIGTERM");
      expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
    });

    test("stderr overflow produces sanitized error and exact-child cleanup", async () => {
      const cancelled: string[] = [];
      const big = new Uint8Array(OUTPUT_CAP + 1);
      const handle = createFakeChild({
        stderrChunks: [big],
        keepStderrOpen: true,
        onCancelStdout: () => cancelled.push("stdout"),
        onCancelStderr: () => cancelled.push("stderr"),
      });
      const spawnCommand = () => handle.child;
      const now = createNow([0, 0]);
      const awaitWithin = createAwaitWithin(["resolve", "resolve", "resolve"]);

      const result = await setupClients(codexOnlyInput({ spawnCommand, now, awaitWithin }));

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.message).toBe("Get command failed");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("overflow");
      expect(handle.killCalls[0]).toBe("SIGTERM");
      expect(cancelled.sort()).toEqual(["stderr", "stdout"]);
    });

    test("no add/remove spawn occurs after query boundary fails at the deadline", async () => {
      const spawnArgvs: string[][] = [];
      const handles: FakeChildHandle[] = [];
      const spawnCommand = (argv: readonly string[]) => {
        spawnArgvs.push(argv as string[]);
        const h = createFakeChild({});
        handles.push(h);
        return h.child;
      };
      const now = createNow([0, 0, 0, 0]);
      const awaitWithin = createAwaitWithin(["reject", "resolve", "resolve", "reject", "resolve", "resolve"]);

      const result = await setupClients({
        apply: true,
        replace: true,
        resolveSourceBinary: async () => FAKE_BIN,
        isExecutableAvailable: async () => true,
        spawnCommand,
        now,
        awaitWithin,
      });

      const mutating = spawnArgvs.filter((a) => a.includes("add") || a.includes("remove"));
      expect(mutating).toHaveLength(0);
      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[1]?.status).toBe("error");
      expect(spawnArgvs).toHaveLength(2);
      for (const h of handles) {
        expect(h.killCalls[0]).toBe("SIGTERM");
      }
    });

    test("absent query then add at deadline reports error and signals exact add child", async () => {
      const codexNotFound = `Error: No MCP server named '${SERVER_NAME}' found.`;
      const getChild = createFakeChild({
        stdoutChunks: [new Uint8Array(0)],
        stderrChunks: [new TextEncoder().encode(codexNotFound)],
        autoResolveOnKill: false,
      });
      getChild.resolveExited(1);

      const addChild = createFakeChild({
        stdoutChunks: [new Uint8Array(0)],
        stderrChunks: [new Uint8Array(0)],
      });
      addChild.resolveExited(0);

      let spawnCount = 0;
      const spawnCommand = () => {
        spawnCount++;
        if (spawnCount === 1) return getChild.child;
        return addChild.child;
      };

      const now = createNow([0, 0, 4999, 5000, 5000, 10000]);
      const awaitWithin = createAwaitWithin(["resolve", "resolve", "resolve", "resolve"]);

      const result = await setupClients({
        apply: true,
        replace: false,
        resolveSourceBinary: async () => FAKE_BIN,
        isExecutableAvailable: async (name) => name === "codex",
        spawnCommand,
        now,
        awaitWithin,
      });

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(addChild.killCalls).toEqual(["SIGTERM"]);
      expect(spawnCount).toBe(2);
    });

    test("mismatch query then remove at deadline reports error, signals remove child, no add spawned", async () => {
      const wrongBin = "/other/path/bin/chatgpt-consult.ts";
      const wrongEnvelope = JSON.stringify({
        name: SERVER_NAME,
        enabled: true,
        disabled_reason: null,
        transport: { type: "stdio", command: "bun", args: ["run", wrongBin, "serve", "local"], env: null, env_vars: [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
      });

      const getChild = createFakeChild({
        stdoutChunks: [new TextEncoder().encode(wrongEnvelope)],
        stderrChunks: [new Uint8Array(0)],
      });
      getChild.resolveExited(0);

      const removeChild = createFakeChild({
        stdoutChunks: [new Uint8Array(0)],
        stderrChunks: [new Uint8Array(0)],
      });
      removeChild.resolveExited(0);

      const spawnArgvs: string[][] = [];
      let spawnCount = 0;
      const spawnCommand = (argv: readonly string[]) => {
        spawnArgvs.push(argv as string[]);
        spawnCount++;
        if (spawnCount === 1) return getChild.child;
        return removeChild.child;
      };

      const now = createNow([0, 0, 4999, 5000, 5000, 10000]);
      const awaitWithin = createAwaitWithin(["resolve", "resolve", "resolve", "resolve"]);

      const result = await setupClients({
        apply: true,
        replace: true,
        resolveSourceBinary: async () => FAKE_BIN,
        isExecutableAvailable: async (name) => name === "codex",
        spawnCommand,
        now,
        awaitWithin,
      });

      expect(result.clients[0]?.status).toBe("error");
      expect(result.clients[0]?.action).toBe("error");
      expect(removeChild.killCalls).toEqual(["SIGTERM"]);
      const addCalls = spawnArgvs.filter((a) => a.includes("add"));
      expect(addCalls).toHaveLength(0);
      expect(spawnCount).toBe(2);
    });
  });
});

describe("getChatgptSetupGuidance", () => {
  test("returns browser-first no-key guidance with legacy compatibility isolated", () => {
    const guidance = getChatgptSetupGuidance();

    expect(guidance.kind).toBe("chatgpt");
    expect(guidance.recommended).toMatchObject({
      initCommand: "chatgpt-consult init --chatgpt-project-url <chatgpt-project-url>",
      clientsCommand: "chatgpt-consult setup clients --apply",
      browserCommand: "chatgpt-consult setup browser",
      doctorCommand: "chatgpt-consult doctor",
      startCommand: "chatgpt-consult start \"Review the queue retry policy\" --profile lean --file src/queue.ts --open",
    });
    const steps = guidance.recommended.steps.join(" ");
    for (const concept of [
      /ChatGPT Project URL.*ignored local state/i,
      /local six-tool MCP.*Codex and Claude/i,
      /headed browser.*sign in directly on ChatGPT/i,
      /doctor.*bounded automatic consultation/i,
      /poll status.*completion.*recovery state/i,
    ]) expect(steps).toMatch(concept);
    expect(guidance.manualFallback).toEqual({
      handoff: "chatgpt-consult handoff <id>",
      importResult: "chatgpt-consult import-result <id> --input <file>",
    });
    expect(guidance.legacyCompatibility).toMatchObject({
      optional: true,
      neverAutoStarted: true,
      startCommand: "chatgpt-consult serve chatgpt",
      healthUrl: "http://127.0.0.1:43891/health",
      mcpUrl: "http://127.0.0.1:43891/mcp",
      healthCommand: "curl --fail --silent http://127.0.0.1:43891/health",
      tunnelDocumentationUrl: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
    });
    expect(guidance.legacyCompatibility.requiredTools).toEqual([
      "request_get",
      "context_search",
      "context_read",
      "diff_get",
      "attachment_get",
      "request_complete",
    ]);
  });

  test("recommended setup requires neither an API key nor a tunnel", () => {
    const guidance = getChatgptSetupGuidance();
    const recommended = JSON.stringify(guidance.recommended);

    expect(recommended).toContain("setup browser");
    expect(recommended.toLowerCase()).not.toContain("api key");
    expect(recommended.toLowerCase()).not.toContain("tunnel");
    expect(guidance.legacyCompatibility).toMatchObject({
      optional: true,
      neverAutoStarted: true,
    });
    const serialized = JSON.stringify(guidance);
    expect(serialized).not.toContain("unlimited");
    expect(serialized).not.toContain(FAKE_BIN);
    expect(serialized).not.toContain(process.cwd());
  });
});
