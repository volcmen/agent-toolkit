import { createBrowserRuntime, type BrowserRuntime } from "./runtime.js";
import type { BrowserJobResult } from "./worker.js";
import { ConsultError } from "../core/errors.js";
import type { LocalConfig } from "../core/schema.js";
import type { ResolvedProject } from "../security/project.js";

const IDENTIFIER = /^[a-f0-9]{32}$/;

export interface RunBrowserWorkerInput {
  readonly project: ResolvedProject;
  readonly config: LocalConfig;
  readonly requestId: string;
  readonly ownerId: string;
}

export interface RunBrowserWorkerOptions {
  readonly createRuntime?: (
    project: ResolvedProject,
    config: LocalConfig,
  ) => Promise<BrowserRuntime>;
}

export const runBrowserWorker = async (
  input: RunBrowserWorkerInput,
  options: RunBrowserWorkerOptions = {},
): Promise<BrowserJobResult> => {
  if (!IDENTIFIER.test(input.requestId) || !IDENTIFIER.test(input.ownerId)) {
    throw new ConsultError("INVALID_INPUT", "Browser worker identifiers are invalid");
  }
  const runtime = await (options.createRuntime ?? createBrowserRuntime)(
    input.project,
    input.config,
  );
  return runtime.job.run(input.requestId, input.ownerId);
};
