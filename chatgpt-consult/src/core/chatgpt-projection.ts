import { ConsultError } from "./errors";
import { z } from "zod";
import {
  HARD_BUDGET,
  SelectionReasonSchema,
  type ConsultationRequest,
} from "./schema";

export const CHATGPT_REQUEST_PROJECTION_MAX_BYTES = 262_144;
const PERSISTENCE_HEADROOM_BYTES = 1_024;

const REQUEST_ID = /^[a-f0-9]{32}$/;
const SAFE_PROJECT_PATH = /^(?!\s*$)(?!\/)(?![A-Za-z]:[\\/])(?!\\\\)(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$))[^\0]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const ChatgptIdentifierSchema = z.string().length(32).regex(REQUEST_ID);
export const ChatgptProjectPathSchema = z.string().min(1).max(4_096)
  .regex(SAFE_PROJECT_PATH, "a project-relative path with no leading slash, drive letter, or .. segment");
export const ChatgptAttachmentIdSchema = z.string().length(64).regex(SHA256);
export const ChatgptAttachmentNameSchema = z.string()
  .min(1)
  .max(255)
  .regex(/^[^/\\\0]+$/);
const ChatgptProjectNameSchema = z.string().min(1).max(255).regex(/^[^/\\\0]+$/);
const ChatgptProjectIdSchema = z.string().length(24).regex(/^[a-f0-9]{24}$/);
const ChatgptProfileSchema = z.enum(["lean", "research", "analysis", "connected"]);
export const ChatgptSensitivitySchema = z.object({
  decision: z.enum(["allowed", "redacted", "blocked"]),
  reasons: z.array(z.string().min(1).max(256)).max(100),
}).strict();
const ChatgptBudgetConfigurationSchema = z.object({
  maxPaths: z.number().int().positive(),
  maxReadBytes: z.number().int().positive(),
  maxServedTextBytes: z.number().int().positive(),
  maxSearchHits: z.number().int().positive(),
  maxAttachmentBytes: z.number().int().positive(),
  maxAttachmentTotalBytes: z.number().int().positive(),
  maxCompletionBytes: z.number().int().positive(),
  expiresAfterMs: z.number().int().positive(),
}).strict();
export const ChatgptBudgetProjectionSchema = z.object({
  configured: ChatgptBudgetConfigurationSchema,
  current: z.object({
    servedTextBytes: z.number().int().nonnegative(),
    servedSearchHits: z.number().int().nonnegative(),
  }).strict(),
  remaining: z.object({
    textBytes: z.number().int().nonnegative(),
    searchHits: z.number().int().nonnegative(),
  }).strict(),
}).strict();
const ChatgptManifestPathSchema = z.object({
  path: ChatgptProjectPathSchema,
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(256).optional(),
  selectionReason: z.array(SelectionReasonSchema).max(100),
}).strict();
const ChatgptManifestSchema = z.object({
  selectors: z.array(ChatgptProjectPathSchema).max(HARD_BUDGET.maxPaths),
  paths: z.array(ChatgptManifestPathSchema).max(HARD_BUDGET.maxPaths),
  smartSelection: z.boolean(),
  exclusions: z.array(z.string().min(1).max(256)).max(100),
}).strict();
const ChatgptAttachmentDescriptorSchema = z.object({
  id: ChatgptAttachmentIdSchema,
  name: ChatgptAttachmentNameSchema,
  bytes: z.number().int().positive(),
  mimeType: z.string().min(1).max(256),
}).strict();
const ChatgptDiffMetadataSchema = z.object({
  baseRef: z.string().min(1).max(256),
  headRef: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();
const ChatgptSensitivityDecisionSchema = z.object({
  scope: z.string().min(1).max(8_192),
  decision: z.enum(["allowed", "redacted", "blocked"]),
  reasons: z.array(z.string().min(1).max(256)).max(100),
}).strict();

export const ChatgptRequestProjectionSchema = z.object({
  request: z.object({
    requestId: ChatgptIdentifierSchema,
    state: z.literal("claimed"),
    revision: z.number().int().nonnegative(),
    goal: z.string().min(1).max(8_192),
    profile: ChatgptProfileSchema,
    profileInstructions: z.string().min(1).max(512),
    connectorAllowlist: z.array(z.string().min(1).max(128)).max(100),
    projectName: ChatgptProjectNameSchema,
    projectId: ChatgptProjectIdSchema,
    expiresAt: z.string().datetime({ offset: true }),
    manifest: ChatgptManifestSchema,
    sensitivity: z.array(ChatgptSensitivityDecisionSchema).max(200),
    attachments: z.array(ChatgptAttachmentDescriptorSchema).max(HARD_BUDGET.maxPaths),
    diff: ChatgptDiffMetadataSchema.nullable(),
    budget: ChatgptBudgetProjectionSchema,
    completionContract: z.object({
      expectedRevision: z.number().int().nonnegative(),
      requiredFields: z.tuple([z.literal("summary"), z.literal("answer")]),
      listFields: z.tuple([
        z.literal("evidence"),
        z.literal("assumptions"),
        z.literal("risks"),
        z.literal("recommendations"),
        z.literal("followUpQuestions"),
      ]),
      maxBytes: z.number().int().positive(),
    }).strict(),
  }).strict(),
}).strict();

export const profileInstructions = (profile: ConsultationRequest["profile"]): string => {
  if (profile === "lean") {
    return "Minimize retrieval; use only the question and the smallest approved context needed.";
  }
  if (profile === "research") {
    return "Use current authoritative web sources when helpful and cite them; local context remains bounded by the approved manifest.";
  }
  if (profile === "analysis") {
    return "Use deeper approved search, chunked reads, diff inspection, and approved media only when they improve the analysis.";
  }
  return "Use only connectors named in connectorAllowlist. Actual connector enforcement remains in the ChatGPT Project; use deeper approved retrieval selectively.";
};

export const buildChatgptBudgetProjection = (request: ConsultationRequest) => ({
  configured: request.budget,
  current: {
    servedTextBytes: request.servedTextBytes,
    servedSearchHits: request.servedSearchHits,
  },
  remaining: {
    textBytes: Math.max(0, request.budget.maxServedTextBytes - request.servedTextBytes),
    searchHits: Math.max(0, request.budget.maxSearchHits - request.servedSearchHits),
  },
});

export const buildChatgptRequestProjection = (request: ConsultationRequest) => ({
  request: {
    requestId: request.id,
    state: request.state,
    revision: request.revision,
    goal: request.goal,
    profile: request.profile,
    profileInstructions: profileInstructions(request.profile),
    connectorAllowlist: request.connectorAllowlist,
    projectName: request.projectName,
    projectId: request.projectId,
    expiresAt: request.expiresAt,
    manifest: {
      selectors: request.contextManifest.selectors,
      paths: request.contextManifest.paths.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        selectionReason: entry.selectionReason,
      })),
      smartSelection: request.contextManifest.smartSelection,
      exclusions: request.contextManifest.exclusions,
    },
    sensitivity: request.sensitivity,
    attachments: request.attachments.map((entry) => ({
      id: entry.id,
      name: entry.name,
      bytes: entry.bytes,
      mimeType: entry.mimeType,
    })),
    diff: request.diff ? {
      baseRef: request.diff.baseRef,
      headRef: request.diff.headRef,
      bytes: request.diff.bytes,
      truncated: request.diff.truncated,
    } : null,
    budget: buildChatgptBudgetProjection(request),
    completionContract: {
      expectedRevision: request.revision,
      requiredFields: ["summary", "answer"] as const,
      listFields: [
        "evidence",
        "assumptions",
        "risks",
        "recommendations",
        "followUpQuestions",
      ] as const,
      maxBytes: request.budget.maxCompletionBytes,
    },
  },
});

export type ChatgptRequestProjection = z.infer<typeof ChatgptRequestProjectionSchema>;

const parseChatgptRequestProjection = (
  request: ConsultationRequest,
): ChatgptRequestProjection => ChatgptRequestProjectionSchema.parse(
  buildChatgptRequestProjection(request),
);

export const serializeChatgptRequestProjection = (
  request: ConsultationRequest,
): { value: ChatgptRequestProjection; json: string } => {
  const value = parseChatgptRequestProjection(request);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > CHATGPT_REQUEST_PROJECTION_MAX_BYTES) {
    throw new ConsultError("BUDGET_EXCEEDED", "ChatGPT request projection exceeds its byte ceiling", {
      limit: CHATGPT_REQUEST_PROJECTION_MAX_BYTES,
    });
  }
  return { value, json };
};

export const assertChatgptRequestProjectionPersistable = (
  request: ConsultationRequest,
): void => {
  const claimableRequest = request.state === "pending"
    ? { ...request, state: "claimed" as const, revision: request.revision + 1 }
    : request;
  let value: ChatgptRequestProjection;
  try {
    value = parseChatgptRequestProjection(claimableRequest);
  } catch {
    throw new ConsultError("INVALID_INPUT", "Request cannot be exposed through ChatGPT safely");
  }
  const json = JSON.stringify(value);
  if (
    Buffer.byteLength(json, "utf8")
    > CHATGPT_REQUEST_PROJECTION_MAX_BYTES - PERSISTENCE_HEADROOM_BYTES
  ) {
    throw new ConsultError("BUDGET_EXCEEDED", "ChatGPT request projection exceeds its byte ceiling", {
      limit: CHATGPT_REQUEST_PROJECTION_MAX_BYTES - PERSISTENCE_HEADROOM_BYTES,
    });
  }
};
