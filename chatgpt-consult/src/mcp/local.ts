import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { MAX_STATUS_WAIT_SECONDS } from "../core/service";
import type { ConsultationService, WaitStatusResult } from "../core/service";
import { ChatModeSchema, ChatThreadSchema, resolveRequestedProfile } from "../core/schema";
import {
  browserRecoveryInstruction,
  compactText,
  handlerValidatedInput,
  parseToolInput,
  runTool,
  successResult,
} from "./results";

const INSTRUCTIONS = "Project chats share login. Consultations are asynchronous: call consult_status with wait_seconds; repeat after the bound elapses. On needs_login run setup browser. For needs_manual, only submission_uncertain, submission certainty uncertain, and workerActive true may wait again. Every other recovery tuple uses manual handoff/import-result; never resubmit. Use consult_show after completion; publication requires explicit user intent. Use consult_start for new topics.";

const ProfileSchema = z.enum(["lean", "research", "analysis", "connected"]);
const StateSchema = z.enum(["pending", "claimed", "completed", "cancelled", "expired"]);
const REQUEST_ID = /^[a-f0-9]{32}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_PROJECT_PATH = /^(?!\s*$)(?!\/)(?![A-Za-z]:[\\/])(?!\\\\)(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$))[^\0]+$/;
const IdentifierSchema = z.string().length(32).regex(REQUEST_ID);
const ProjectPathSchema = z.string().min(1).max(4_096)
  .regex(SAFE_PROJECT_PATH, "a project-relative path with no leading slash, drive letter, or .. segment");
const GoalSchema = z.string().min(1).max(8_192).regex(/\S/);
const ConnectorSchema = z.string().min(1).max(128).regex(/\S/);
const BrowserStatusSchema = z.object({
  phase: z.enum([
    "queued", "preparing", "awaiting_browser", "awaiting_response",
    "needs_login", "needs_manual", "completed", "cancelled", "expired",
  ]),
  reason: z.enum([
    "login_required", "human_challenge", "rate_limited", "browser_unavailable", "ui_changed",
    "upload_failed", "timed_out", "invalid_response", "submission_uncertain",
  ]).nullable(),
  attempt: z.number().int().nonnegative(),
  submissionCertainty: z.enum(["not_submitted", "submitted", "uncertain"]),
  workerActive: z.boolean(),
  conversationUrl: z.url().optional(),
}).strict();

const StartInputSchema = z.object({
  goal: GoalSchema,
  profile: ProfileSchema.optional(),
  files: z.array(ProjectPathSchema).max(100).default([]),
  smart: z.boolean().default(false),
  attachments: z.array(ProjectPathSchema).max(100).default([]),
  diff: z.enum(["working", "none"]).default("none"),
  open: z.boolean().default(true),
  allow_sensitive: z.boolean().default(false),
  connectors: z.array(ConnectorSchema).max(100).default([]),
  idempotency_key: z.string().min(1).max(128).regex(SAFE_IDEMPOTENCY_KEY).optional(),
}).strict();

const FollowupInputSchema = z.object({
  parent_id: IdentifierSchema,
  chat_mode: ChatModeSchema.default("auto"),
  goal: GoalSchema,
  profile: ProfileSchema.optional(),
  files: z.array(ProjectPathSchema).max(100).default([]),
  smart: z.boolean().default(false),
  attachments: z.array(ProjectPathSchema).max(100).default([]),
  diff: z.enum(["working", "none"]).default("none"),
  open: z.boolean().default(true),
  allow_sensitive: z.boolean().default(false),
  connectors: z.array(ConnectorSchema).max(100).optional(),
  idempotency_key: z.string().min(1).max(128).regex(SAFE_IDEMPOTENCY_KEY).optional(),
}).strict();

const RequestInputSchema = z.object({ request_id: IdentifierSchema }).strict();
const StatusInputSchema = z.object({
  request_id: IdentifierSchema,
  wait_seconds: z.number().int().min(0).max(MAX_STATUS_WAIT_SECONDS).default(0),
}).strict();
const PublishInputSchema = z.object({
  request_id: IdentifierSchema,
  output: ProjectPathSchema.optional(),
}).strict();

const StartOutputSchema = z.object({
  requestId: IdentifierSchema,
  state: StateSchema,
  revision: z.number().int().nonnegative(),
  claimToken: z.string().min(1),
  handoff: z.string().min(1),
  thread: ChatThreadSchema.optional(),
  browser: BrowserStatusSchema.optional(),
}).strict();

const StatusOutputSchema = z.object({
  requestId: IdentifierSchema,
  state: StateSchema,
  revision: z.number().int().nonnegative(),
  goal: z.string().min(1),
  profile: ProfileSchema,
  parentId: IdentifierSchema.nullable(),
  thread: ChatThreadSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  summary: z.string().min(1).optional(),
  completionSource: z.enum(["mcp", "manual", "browser"]).optional(),
  browser: BrowserStatusSchema.optional(),
}).strict();

const CompletionOutputSchema = z.object({
  summary: z.string().min(1),
  answer: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  assumptions: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  recommendations: z.array(z.string().min(1)),
  followUpQuestions: z.array(z.string().min(1)),
}).strict();
const ShowOutputSchema = StatusOutputSchema.extend({
  completion: CompletionOutputSchema.nullable(),
}).strict();
const PublishOutputSchema = z.object({ path: ProjectPathSchema }).strict();

const startInput = handlerValidatedInput(StartInputSchema);
const followupInput = handlerValidatedInput(FollowupInputSchema);
const requestInput = handlerValidatedInput(RequestInputSchema);
const statusInput = handlerValidatedInput(StatusInputSchema);
const publishInput = handlerValidatedInput(PublishInputSchema);

const isActiveSubmissionConfirmation = (
  browser: z.output<typeof BrowserStatusSchema> | undefined,
): boolean => browser?.phase === "needs_manual"
  && browser.reason === "submission_uncertain"
  && browser.submissionCertainty === "uncertain"
  && browser.workerActive === true;

const hasUnsafeUncertainMismatch = (
  browser: z.output<typeof BrowserStatusSchema> | undefined,
): boolean => browser !== undefined
  && !(browser.phase === "needs_manual" && browser.reason === "rate_limited")
  && (browser.reason === "submission_uncertain"
    || browser.submissionCertainty === "uncertain");

const isTerminal = (state: z.output<typeof StateSchema>): boolean =>
  state === "cancelled" || state === "expired";

const progressText = (
  kind: "Consultation" | "Follow-up",
  result: z.output<typeof StartOutputSchema>,
): string => {
  const routing = result.thread
    ? ` ${result.thread.mode === "new" ? "Fresh chat" : "Continuing chat"} in ${result.thread.projectUrl} (${result.thread.reason}, exchange ${result.thread.turn}).`
    : "";
  const prefix = `${kind} ${result.requestId} is ${result.state}.${routing}`;
  if (result.state === "completed") return `${prefix} Use consult_show to review the validated result.`;
  if (isTerminal(result.state)) return `${prefix} It cannot be resumed; start a new consultation if the work is still needed.`;
  if (isActiveSubmissionConfirmation(result.browser)) {
    return `${prefix} The active worker is confirming submission; call consult_status with wait_seconds and do not resubmit.`;
  }
  if (hasUnsafeUncertainMismatch(result.browser)) {
    return `${prefix} Use manual handoff/import-result for recovery; never resubmit uncertain work.`;
  }
  const recovery = browserRecoveryInstruction(result.browser?.phase, result.browser?.submissionCertainty, result.browser?.reason);
  if (recovery) return `${prefix} ${recovery}`;
  if (result.browser && !result.browser.workerActive) {
    return `${prefix} Automatic browser work is ${result.browser.phase} but no worker is running; waiting will not advance it. Run open to resume, or use manual handoff/import-result.`;
  }
  if (result.browser) return `${prefix} Automatic browser work is ${result.browser.phase}; call consult_status with wait_seconds.`;
  return `${prefix} Use the returned handoff; no worker is running, so waiting will not advance it.`;
};

const waitText = (waited: WaitStatusResult): string => {
  if (waited.outcome === "snapshot") return "";
  if (waited.outcome === "actionable") {
    return ` Waited ${waited.waitedSeconds}s for an actionable state.`;
  }
  if (waited.outcome === "aborted") return " The wait was cancelled by the caller.";
  return ` Still running after ${waited.waitedSeconds}s; call consult_status again with wait_seconds to keep waiting.`;
};

const statusText = (result: z.output<typeof StatusOutputSchema>): string => {
  const prefix = `Consultation ${result.requestId} is ${result.state} at revision ${result.revision}.`;
  if (result.state === "completed") return `${prefix} Use consult_show to review the validated result.`;
  if (isTerminal(result.state)) return `${prefix} It cannot be resumed; start a new consultation if the work is still needed.`;
  if (isActiveSubmissionConfirmation(result.browser)) {
    return `${prefix} The active worker is confirming submission; call consult_status with wait_seconds and do not resubmit.`;
  }
  if (hasUnsafeUncertainMismatch(result.browser)) {
    return `${prefix} Use manual handoff/import-result for recovery; never resubmit uncertain work.`;
  }
  const recovery = browserRecoveryInstruction(result.browser?.phase, result.browser?.submissionCertainty, result.browser?.reason);
  if (recovery) return `${prefix} ${recovery}`;
  if (result.browser && !result.browser.workerActive) {
    return `${prefix} Browser work is ${result.browser.phase} but no worker is running; waiting will not advance it. Run open to resume, or use manual handoff/import-result.`;
  }
  if (result.browser) return `${prefix} Browser work is ${result.browser.phase}; call consult_status with wait_seconds.`;
  return prefix;
};

export const createLocalMcp = (
  service: ConsultationService,
  defaultProfile: z.output<typeof ProfileSchema> = "lean",
): McpServer => {
  const server = new McpServer(
    { name: "chatgpt-consult-local", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool("consult_start", {
    title: "Start consultation",
    description: `Create a bounded asynchronous ChatGPT consultation. Omitting profile resolves to analysis when files, attachments, or diff carry context, else the configured default (${defaultProfile}).`,
    inputSchema: startInput,
    outputSchema: StartOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, (raw) => runTool(async () => {
    const input = parseToolInput(StartInputSchema, raw);
    const value = await service.start({
      goal: input.goal,
      profile: resolveRequestedProfile(input.profile, input) ?? defaultProfile,
      files: input.files,
      smart: input.smart,
      attachments: input.attachments,
      diff: input.diff,
      open: input.open,
      allowSensitive: input.allow_sensitive,
      connectors: input.connectors,
      ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
    });
    return successResult(
      StartOutputSchema,
      value,
      (result) => progressText("Consultation", result),
    );
  }));

  server.registerTool("consult_status", {
    title: "Consultation status",
    description: "Read consultation state, optionally waiting up to wait_seconds for an actionable state.",
    inputSchema: statusInput,
    outputSchema: StatusOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (raw, extra) => runTool(async () => {
    const input = parseToolInput(StatusInputSchema, raw);
    const waited: WaitStatusResult = input.wait_seconds === 0
      ? { status: await service.status(input.request_id), outcome: "snapshot", waitedSeconds: 0 }
      : await service.waitStatus(input.request_id, input.wait_seconds, extra?.mcpReq?.signal);
    return successResult(
      StatusOutputSchema,
      waited.status,
      (value) => `${statusText(value)}${waitText(waited)}`,
    );
  }));

  server.registerTool("consult_show", {
    title: "Show consultation",
    description: "Read the bounded structured result of a consultation.",
    inputSchema: requestInput,
    outputSchema: ShowOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (raw) => runTool(async () => {
    const input = parseToolInput(RequestInputSchema, raw);
    const value = await service.show(input.request_id);
    return successResult(
      ShowOutputSchema,
      value,
      (result) => result.completion
        ? JSON.stringify({
          requestId: result.requestId,
          state: result.state,
          completionSource: result.completionSource,
          completion: result.completion,
        })
        : `Consultation ${result.requestId} has no completed result yet.`,
    );
  }));

  server.registerTool("consult_followup", {
    title: "Follow up consultation",
    description: "Continue related work in its ChatGPT Project. chat_mode auto starts fresh after six recorded exchanges; new starts a fresh Project chat with a bounded summary; continue explicitly keeps the conversation. Use consult_start for unrelated topics.",
    inputSchema: followupInput,
    outputSchema: StartOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, (raw) => runTool(async () => {
    const input = parseToolInput(FollowupInputSchema, raw);
    const resolvedProfile = resolveRequestedProfile(input.profile, input);
    const value = await service.followup({
      parentId: input.parent_id,
      chatMode: input.chat_mode,
      goal: input.goal,
      ...(resolvedProfile ? { profile: resolvedProfile } : {}),
      files: input.files,
      smart: input.smart,
      attachments: input.attachments,
      diff: input.diff,
      open: input.open,
      allowSensitive: input.allow_sensitive,
      ...(input.connectors ? { connectors: input.connectors } : {}),
      ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
    });
    return successResult(
      StartOutputSchema,
      value,
      (result) => progressText("Follow-up", result),
    );
  }));

  server.registerTool("consult_cancel", {
    title: "Cancel consultation",
    description: "Cancel a pending or claimed consultation without deleting its record.",
    inputSchema: requestInput,
    outputSchema: StatusOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (raw) => runTool(async () => {
    const input = parseToolInput(RequestInputSchema, raw);
    const value = await service.cancel(input.request_id);
    return successResult(
      StatusOutputSchema,
      value,
      (result) => `Consultation ${result.requestId} is ${result.state}.`,
    );
  }));

  server.registerTool("consult_publish", {
    title: "Publish consultation",
    description: "Explicitly publish a completed consultation as a new project Markdown file.",
    inputSchema: publishInput,
    outputSchema: PublishOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, (raw) => runTool(async () => {
    const input = parseToolInput(PublishInputSchema, raw);
    const value = await service.publish(input.request_id, input.output);
    return successResult(
      PublishOutputSchema,
      value,
      (result) => `Published consultation to ${compactText(result.path)}.`,
    );
  }));

  return server;
};

export const installServeRejectionGuard = (
  write: (message: string) => void = (message) => { process.stderr.write(message); },
): (() => void) => {
  const guard = (): void => {
    write("chatgpt-consult: suppressed background rejection\n");
  };
  process.on("unhandledRejection", guard);
  return () => { process.off("unhandledRejection", guard); };
};

export const serveLocalStdio = async (factory: McpServerFactory): Promise<void> => {
  installServeRejectionGuard();
  serveStdio(factory, {
    onerror: () => {
      process.stderr.write("chatgpt-consult: MCP transport error\n");
    },
  });
};
