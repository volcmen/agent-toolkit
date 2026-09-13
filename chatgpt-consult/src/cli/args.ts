import { ConsultError } from "../core/errors";

export type CommandName =
  | "init" | "start" | "status" | "show" | "followup" | "cancel"
  | "publish" | "open" | "handoff" | "import-result" | "list" | "setup" | "doctor";

export interface ParsedArgs {
  command: CommandName;
  positionals: string[];
  json: boolean;
  files: string[];
  attachments: string[];
  connectors: string[];
  smart: boolean;
  open: boolean;
  allowSensitive: boolean;
  apply: boolean;
  replace: boolean;
  managed: boolean;
  profile?: string;
  diff?: string;
  output?: string;
  input?: string;
  limit?: string;
  idempotencyKey?: string;
  chatgptProjectUrl?: string;
  browserCdpPort?: string;
  chatMode?: string;
}

const commands = new Set<CommandName>([
  "init", "start", "status", "show", "followup", "cancel", "publish",
  "open", "handoff", "import-result", "list",
  "setup",
  "doctor",
]);
const repeated: Record<string, "files" | "attachments" | "connectors" | undefined> = {
  "--file": "files",
  "--attachment": "attachments",
  "--connector": "connectors",
};
const scalar: Record<string,
  | "profile" | "diff" | "output" | "input" | "limit" | "idempotencyKey"
  | "chatgptProjectUrl" | "browserCdpPort" | "chatMode" | undefined> = {
  "--profile": "profile",
  "--diff": "diff",
  "--output": "output",
  "--input": "input",
  "--limit": "limit",
  "--idempotency-key": "idempotencyKey",
  "--chatgpt-project-url": "chatgptProjectUrl",
  "--cdp": "browserCdpPort",
  "--chat-mode": "chatMode",
};
const boolean: Record<string, "json" | "smart" | "open" | "allowSensitive" | "apply" | "replace" | "managed" | undefined> = {
  "--json": "json",
  "--smart": "smart",
  "--open": "open",
  "--allow-sensitive": "allowSensitive",
  "--apply": "apply",
  "--replace": "replace",
  "--managed": "managed",
};

const allowed: Record<CommandName, ReadonlySet<string>> = {
  init: new Set(["--json", "--chatgpt-project-url"]),
  start: new Set([
    "--json", "--file", "--attachment", "--connector", "--profile", "--smart",
    "--diff", "--open", "--idempotency-key", "--allow-sensitive",
  ]),
  followup: new Set([
    "--json", "--file", "--attachment", "--connector", "--profile", "--smart",
    "--diff", "--open", "--idempotency-key", "--allow-sensitive",
    "--chat-mode",
  ]),
  status: new Set(["--json"]),
  show: new Set(["--json"]),
  cancel: new Set(["--json"]),
  publish: new Set(["--json", "--output"]),
  open: new Set(["--json"]),
  handoff: new Set(["--json"]),
  "import-result": new Set(["--json", "--input"]),
  list: new Set(["--json", "--limit"]),
  setup: new Set(["--json", "--apply", "--replace", "--cdp", "--managed"]),
  doctor: new Set(["--json"]),
};

const invalid = (message: string): never => {
  throw new ConsultError("INVALID_INPUT", message);
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const command = argv[0];
  if (!command || !commands.has(command as CommandName)) invalid("A valid command is required");
  const parsed: ParsedArgs = {
    command: command as CommandName,
    positionals: [],
    json: false,
    files: [],
    attachments: [],
    connectors: [],
    smart: false,
    open: false,
    allowSensitive: false,
    apply: false,
    replace: false,
    managed: false,
  };
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      parsed.positionals.push(value);
      continue;
    }
    if (!allowed[parsed.command].has(value)) invalid(`Unknown option for ${parsed.command}: ${value}`);
    const repeatedKey = repeated[value];
    if (repeatedKey) {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) invalid(`${value} requires a value`);
      parsed[repeatedKey].push(next!);
      continue;
    }
    const scalarKey = scalar[value];
    if (scalarKey) {
      if (seen.has(value)) invalid(`Duplicate option: ${value}`);
      seen.add(value);
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) invalid(`${value} requires a value`);
      parsed[scalarKey] = next!;
      continue;
    }
    const booleanKey = boolean[value];
    if (!booleanKey) invalid(`Unknown option: ${value}`);
    if (seen.has(value)) invalid(`Duplicate option: ${value}`);
    seen.add(value);
    parsed[booleanKey!] = true;
  }
  return parsed;
};
