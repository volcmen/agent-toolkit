import { resolve } from "node:path";
import {
  BrowserWorkerLauncher,
  setupBrowserSession,
  type BrowserSetupResult,
} from "../browser/runtime";
import {
  runBrowserWorker,
  type RunBrowserWorkerInput,
} from "../browser/worker-process";
import { ContextService } from "../context/selection";
import { ConsultError } from "../core/errors";
import {
  ConsultationService,
  configureBrowserCdp,
  initializeProject,
  readLocalConfig,
  type BrowserWorkerLauncher as BrowserWorkerLauncherContract,
} from "../core/service";
import { CapabilityProfileSchema, ChatModeSchema, HARD_BUDGET, resolveRequestedProfile, type CapabilityProfile } from "../core/schema";
import { RequestStore } from "../core/store";
import { createLocalMcp, serveLocalStdio } from "../mcp/local";
import { startChatgptHttp } from "../mcp/http";
import { readStableProjectFile, resolveProject } from "../security/project";
import { parseArgs } from "./args";
import { errorEnvelope, renderHuman, successEnvelope } from "./render";
import {
  getChatgptSetupGuidance,
  setupClients,
  type ChatgptSetupGuidance,
  type SetupClientsResult,
} from "./setup";
import { runDoctor, type DoctorResult } from "./doctor";

export interface MainDependencies {
  write?: (message: string) => void;
  writeError?: (message: string) => void;
  cwd?: string;
  workerLauncher?: BrowserWorkerLauncherContract;
  workerLauncherFactory?: (
    project: Awaited<ReturnType<typeof resolveProject>>,
    store: RequestStore,
  ) => BrowserWorkerLauncherContract;
  setupBrowser?: (input: {
    project: Awaited<ReturnType<typeof resolveProject>>;
    config: Awaited<ReturnType<typeof readLocalConfig>>;
  }) => Promise<BrowserSetupResult>;
  runBrowserWorker?: (input: RunBrowserWorkerInput) => Promise<unknown>;
  setupClients?: (input: { apply: boolean; replace: boolean }) => Promise<SetupClientsResult>;
  getChatgptSetupGuidance?: () => ChatgptSetupGuidance;
  doctor?: () => Promise<DoctorResult>;
}

const help = "chatgpt-consult v1.0.0\nUsage: chatgpt-consult <command>";

const selectWorkerLauncher = (
  deps: MainDependencies,
  project: Awaited<ReturnType<typeof resolveProject>>,
  store: RequestStore,
): BrowserWorkerLauncherContract => {
  if (deps.workerLauncher) return deps.workerLauncher;
  if (deps.workerLauncherFactory) return deps.workerLauncherFactory(project, store);
  return new BrowserWorkerLauncher({ project, store });
};

const requireCount = (values: string[], minimum: number, maximum: number, message: string): void => {
  if (values.length < minimum || values.length > maximum) {
    throw new ConsultError("INVALID_INPUT", message);
  }
};

const parseLimit = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ConsultError("INVALID_INPUT", "Limit must be a positive integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 1_000) {
    throw new ConsultError("INVALID_INPUT", "Limit must not exceed 1000");
  }
  return limit;
};

const parseCdpPort = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ConsultError("INVALID_INPUT", "Browser CDP port must be an integer from 1 through 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new ConsultError("INVALID_INPUT", "Browser CDP port must be an integer from 1 through 65535");
  }
  return port;
};

const parseWorkerArguments = (argv: string[]): { requestId: string; ownerId: string } => {
  if (argv.length !== 3 || argv.some((value, index) => index > 0 && value.startsWith("--"))) {
    throw new ConsultError("INVALID_INPUT", "Browser worker arguments are invalid");
  }
  const requestId = argv[1]!;
  const ownerId = argv[2]!;
  if (!/^[a-f0-9]{32}$/.test(requestId) || !/^[a-f0-9]{32}$/.test(ownerId)) {
    throw new ConsultError("INVALID_INPUT", "Browser worker arguments are invalid");
  }
  return { requestId, ownerId };
};

const exitCodeFor = (error: ConsultError): number => {
  if (error.code === "NOT_FOUND") return 3;
  if (error.code === "CONFLICT" || error.code === "EXPIRED") return 4;
  if (["INVALID_INPUT", "FORBIDDEN_PATH", "SENSITIVE_CONTENT", "BUDGET_EXCEEDED"].includes(error.code)) return 2;
  return 1;
};

const safeError = (error: unknown): ConsultError => {
  if (error instanceof ConsultError) return error;
  return new ConsultError("INTERNAL", "The operation failed");
};

type ServeArguments = {
  target: "local";
} | {
  target: "chatgpt";
  hostname: "127.0.0.1";
  port: number;
  root?: string;
};

const parseServeArguments = (argv: string[]): ServeArguments => {
  const target = argv[1];
  if (target === "local") {
    if (argv.length !== 2) {
      throw new ConsultError("INVALID_INPUT", "serve local does not accept options");
    }
    return { target };
  }
  if (target !== "chatgpt") {
    throw new ConsultError("INVALID_INPUT", "serve requires local or chatgpt");
  }

  let hostname: "127.0.0.1" = "127.0.0.1";
  let port = 43_891;
  let root: string | undefined;
  const seen = new Set<string>();
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (!["--host", "--port", "--root"].includes(option)) {
      throw new ConsultError("INVALID_INPUT", "serve chatgpt accepts only host, port, and root options");
    }
    if (seen.has(option)) throw new ConsultError("INVALID_INPUT", "Duplicate serve option");
    seen.add(option);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new ConsultError("INVALID_INPUT", "A serve option value is missing");
    }
    if (option === "--host") {
      if (value !== "127.0.0.1") {
        throw new ConsultError("INVALID_INPUT", "serve chatgpt host must be 127.0.0.1");
      }
      hostname = value;
    } else if (option === "--port") {
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new ConsultError("INVALID_INPUT", "serve chatgpt port must be an integer from 1 through 65535");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > 65_535) {
        throw new ConsultError("INVALID_INPUT", "serve chatgpt port must be an integer from 1 through 65535");
      }
      port = parsed;
    } else {
      root = value;
    }
  }
  return { target, hostname, port, ...(root === undefined ? {} : { root }) };
};

const waitForShutdownSignal = (): Promise<void> => new Promise((settle) => {
  const done = (): void => {
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
    settle();
  };
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
});

export const main = async (
  argv: string[],
  deps: MainDependencies = {},
): Promise<number> => {
  const write = deps.write ?? console.log;
  const writeError = deps.writeError ?? console.error;
  if (argv.length === 0) {
    write(help);
    return 0;
  }

  const serveRequested = argv[0] === "serve";
  const workerRequested = argv[0] === "worker";
  let json = !serveRequested && !workerRequested && argv.includes("--json");
  try {
    if (workerRequested) {
      const identifiers = parseWorkerArguments(argv);
      const project = await resolveProject(deps.cwd ?? process.cwd());
      const config = await readLocalConfig(project);
      await (deps.runBrowserWorker ?? runBrowserWorker)({ project, config, ...identifiers });
      return 0;
    }
    if (serveRequested) {
      const serve = parseServeArguments(argv);
      const startupCwd = deps.cwd ?? process.cwd();
      if (serve.target === "local") {
        const project = await resolveProject(startupCwd);
        await serveLocalStdio(async () => {
          const store = await RequestStore.init(project);
          const context = new ContextService(project, store);
          const config = await readLocalConfig(project);
          const workerLauncher = selectWorkerLauncher(deps, project, store);
          const service = new ConsultationService(project, store, context, {
            workerLauncher,
            ...(config.chatgptProjectUrl === undefined ? {} : { chatgptProjectUrl: config.chatgptProjectUrl }),
          });
          return createLocalMcp(service, config.defaultProfile);
        });
        return 0;
      }

      const selectedRoot = serve.root === undefined
        ? startupCwd
        : resolve(startupCwd, serve.root);
      const project = await resolveProject(selectedRoot);
      const store = await RequestStore.init(project);
      const context = new ContextService(project, store);
      const server = await startChatgptHttp({
        store,
        context,
        hostname: serve.hostname,
        port: serve.port,
      });
      try {
        writeError(`Health: ${server.url}/health`);
        writeError(`MCP: ${server.mcpUrl}`);
        await waitForShutdownSignal();
        return 0;
      } finally {
        await server.stop();
      }
    }
    const args = parseArgs(argv);
    json = args.json;
    if (args.command === "setup") {
      requireCount(args.positionals, 1, 1, "setup requires clients, browser, or chatgpt");
      const target = args.positionals[0];
      let data: SetupClientsResult | ChatgptSetupGuidance | BrowserSetupResult;
      if (target === "clients") {
        if (args.browserCdpPort !== undefined || args.managed) {
          throw new ConsultError("INVALID_INPUT", "setup clients does not accept browser options");
        }
        data = await (deps.setupClients ?? setupClients)({
          apply: args.apply,
          replace: args.replace,
        });
      } else if (target === "chatgpt") {
        if (args.apply || args.replace || args.browserCdpPort !== undefined || args.managed) {
          throw new ConsultError("INVALID_INPUT", "setup chatgpt does not accept these options");
        }
        data = (deps.getChatgptSetupGuidance ?? getChatgptSetupGuidance)();
      } else if (target === "browser") {
        if (args.apply || args.replace) {
          throw new ConsultError("INVALID_INPUT", "setup browser does not accept apply or replace");
        }
        if (args.managed && args.browserCdpPort !== undefined) {
          throw new ConsultError("INVALID_INPUT", "setup browser accepts either --managed or --cdp");
        }
        const project = await resolveProject(deps.cwd ?? process.cwd());
        let config = await readLocalConfig(project);
        if (config.chatgptProjectUrl === undefined) {
          throw new ConsultError(
            "INVALID_INPUT",
            "Configure a ChatGPT Project URL before browser setup",
          );
        }
        if (args.browserCdpPort !== undefined) {
          config = await configureBrowserCdp(project, parseCdpPort(args.browserCdpPort));
        } else if (args.managed) {
          config = await configureBrowserCdp(project, null);
        }
        data = await (deps.setupBrowser
          ?? (async ({ config: selected }) => setupBrowserSession(selected)))({ project, config });
      } else {
        throw new ConsultError("INVALID_INPUT", "setup requires clients, browser, or chatgpt");
      }
      write(json ? JSON.stringify(successEnvelope(data)) : renderHuman(args.command, data));
      return data.kind === "clients" && !data.success ? 1 : 0;
    }
    if (args.command === "doctor") {
      requireCount(args.positionals, 0, 0, "doctor does not accept positional arguments");
      const data = await (deps.doctor ?? (() => runDoctor({ cwd: deps.cwd ?? process.cwd() })))();
      write(json ? JSON.stringify(successEnvelope(data)) : renderHuman(args.command, data));
      return data.success ? 0 : 1;
    }
    const project = await resolveProject(deps.cwd ?? process.cwd());
    let data: unknown;
    if (args.command === "init") {
      requireCount(args.positionals, 0, 0, "init does not accept positional arguments");
      data = await initializeProject(project, {
        ...(args.chatgptProjectUrl ? { chatgptProjectUrl: args.chatgptProjectUrl } : {}),
      });
    } else {
      const store = await RequestStore.init(project);
      const context = new ContextService(project, store);
      const config = await readLocalConfig(project);
      const workerLauncher = selectWorkerLauncher(deps, project, store);
      const service = new ConsultationService(project, store, context, {
        workerLauncher,
        ...(config.chatgptProjectUrl === undefined ? {} : { chatgptProjectUrl: config.chatgptProjectUrl }),
      });
      switch (args.command) {
        case "start": {
          requireCount(args.positionals, 1, Number.MAX_SAFE_INTEGER, "A consultation goal is required");
          let explicitProfile: CapabilityProfile | undefined;
          if (args.profile !== undefined) {
            const parsed = CapabilityProfileSchema.safeParse(args.profile);
            if (!parsed.success) throw new ConsultError("INVALID_INPUT", "Capability profile is invalid");
            explicitProfile = parsed.data;
          }
          if (args.diff !== undefined && args.diff !== "working" && args.diff !== "none") {
            throw new ConsultError("INVALID_INPUT", "Diff must be working or none");
          }
          const startDiff = (args.diff ?? "none") as "working" | "none";
          const startProfile = resolveRequestedProfile(explicitProfile, {
            files: args.files,
            attachments: args.attachments,
            diff: startDiff,
          }) ?? config.defaultProfile;
          data = await service.start({
            goal: args.positionals.join(" "),
            profile: startProfile,
            files: args.files,
            smart: args.smart,
            attachments: args.attachments,
            diff: startDiff,
            open: args.open,
            allowSensitive: args.allowSensitive,
            connectors: args.connectors.length > 0
              ? args.connectors
              : (startProfile === "connected" ? config.connectorAllowlist : []),
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
            budget: config.budget,
          });
          break;
        }
        case "followup": {
          requireCount(args.positionals, 2, Number.MAX_SAFE_INTEGER, "A parent request and goal are required");
          const chatMode = ChatModeSchema.safeParse(args.chatMode ?? "auto");
          if (!chatMode.success) throw new ConsultError("INVALID_INPUT", "--chat-mode must be auto, new, or continue");
          const [parentId, ...goal] = args.positionals;
          let explicitProfile: CapabilityProfile | undefined;
          if (args.profile !== undefined) {
            const parsed = CapabilityProfileSchema.safeParse(args.profile);
            if (!parsed.success) throw new ConsultError("INVALID_INPUT", "Capability profile is invalid");
            explicitProfile = parsed.data;
          }
          if (args.diff !== undefined && args.diff !== "working" && args.diff !== "none") {
            throw new ConsultError("INVALID_INPUT", "Diff must be working or none");
          }
          const followupDiff = (args.diff ?? "none") as "working" | "none";
          const profile = resolveRequestedProfile(explicitProfile, {
            files: args.files,
            attachments: args.attachments,
            diff: followupDiff,
          });
          data = await service.followup({
            parentId: parentId!,
            chatMode: chatMode.data,
            goal: goal.join(" "),
            ...(profile ? { profile } : {}),
            files: args.files,
            smart: args.smart,
            attachments: args.attachments,
            diff: followupDiff,
            open: args.open,
            allowSensitive: args.allowSensitive,
            ...(args.connectors.length > 0 ? { connectors: args.connectors } : {}),
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
            budget: config.budget,
          });
          break;
        }
        case "status":
          requireCount(args.positionals, 1, 1, "status requires one request ID");
          data = await service.status(args.positionals[0]!);
          break;
        case "show":
          requireCount(args.positionals, 1, 1, "show requires one request ID");
          data = await service.show(args.positionals[0]!);
          break;
        case "cancel":
          requireCount(args.positionals, 1, 1, "cancel requires one request ID");
          data = await service.cancel(args.positionals[0]!);
          break;
        case "publish":
          requireCount(args.positionals, 1, 1, "publish requires one request ID");
          data = await service.publish(args.positionals[0]!, args.output);
          break;
        case "open":
          requireCount(args.positionals, 1, 1, "open requires one request ID");
          data = await service.open(args.positionals[0]!);
          break;
        case "handoff":
          requireCount(args.positionals, 1, 1, "handoff requires one request ID");
          data = await service.manualBundle(args.positionals[0]!);
          break;
        case "import-result": {
          requireCount(args.positionals, 1, 1, "import-result requires one request ID");
          if (!args.input) throw new ConsultError("INVALID_INPUT", "import-result requires --input");
          const request = await store.get(args.positionals[0]!);
          if (request.state === "expired") {
            throw new ConsultError("EXPIRED", "The request has expired");
          }
          const maximumBytes = Math.min(
            request.budget.maxCompletionBytes,
            HARD_BUDGET.maxCompletionBytes,
          );
          const snapshot = await readStableProjectFile(project, args.input, maximumBytes);
          let value: unknown;
          try {
            value = JSON.parse(snapshot.content.toString("utf8"));
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new ConsultError("INVALID_INPUT", "Completion input is malformed JSON");
            }
            throw error;
          }
          data = await service.importManualCompletion(args.positionals[0]!, value);
          break;
        }
        case "list":
          requireCount(args.positionals, 0, 0, "list does not accept positional arguments");
          data = await service.listRecent(parseLimit(args.limit));
          break;
      }
    }
    write(json ? JSON.stringify(successEnvelope(data)) : renderHuman(args.command, data));
    return 0;
  } catch (caught) {
    const error = safeError(caught);
    const message = error.code === "INTERNAL" ? "The operation failed" : error.message;
    if (json) write(JSON.stringify(errorEnvelope(error.code, message, error.details)));
    else writeError(`${error.code}: ${message}`);
    return exitCodeFor(error);
  }
};
