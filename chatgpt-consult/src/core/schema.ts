import { z } from "zod";

export const CapabilityProfileSchema = z.enum([
  "lean",
  "research",
  "analysis",
  "connected",
]);
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

export interface RequestedProfileContext {
  files: readonly string[];
  attachments: readonly string[];
  diff: "working" | "none";
}

export const resolveRequestedProfile = (
  explicit: CapabilityProfile | undefined,
  context: RequestedProfileContext,
): CapabilityProfile | undefined => {
  if (explicit) return explicit;
  const hasContext = context.files.length > 0
    || context.attachments.length > 0
    || context.diff === "working";
  return hasContext ? "analysis" : undefined;
};

export const RequestStateSchema = z.enum([
  "pending",
  "claimed",
  "completed",
  "cancelled",
  "expired",
]);
export type RequestState = z.infer<typeof RequestStateSchema>;

export const BrowserPhaseSchema = z.enum([
  "queued",
  "preparing",
  "awaiting_browser",
  "awaiting_response",
  "needs_login",
  "needs_manual",
  "completed",
  "cancelled",
  "expired",
]);
export type BrowserPhase = z.infer<typeof BrowserPhaseSchema>;

export const BrowserFailureReasonSchema = z.enum([
  "login_required",
  "human_challenge",
  "rate_limited",
  "browser_unavailable",
  "ui_changed",
  "upload_failed",
  "timed_out",
  "invalid_response",
  "submission_uncertain",
]);
export type BrowserFailureReason = z.infer<typeof BrowserFailureReasonSchema>;

export const SubmissionCertaintySchema = z.enum([
  "not_submitted",
  "submitted",
  "uncertain",
]);
export type SubmissionCertainty = z.infer<typeof SubmissionCertaintySchema>;

export const BrowserExecutionSchema = z.object({
  phase: BrowserPhaseSchema,
  reason: BrowserFailureReasonSchema.nullable(),
  attempt: z.number().int().nonnegative(),
  lease: z.object({
    ownerId: z.string().regex(/^[a-f0-9]{32}$/),
    expiresAt: z.string().datetime({ offset: true }),
  }).strict().nullable(),
  submission: z.object({
    certainty: SubmissionCertaintySchema,
    attemptedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type BrowserExecution = z.infer<typeof BrowserExecutionSchema>;

export const ContextBudgetSchema = z
  .object({
    maxPaths: z.number().int().positive(),
    maxReadBytes: z.number().int().positive(),
    maxServedTextBytes: z.number().int().positive(),
    maxSearchHits: z.number().int().positive(),
    maxAttachmentBytes: z.number().int().positive(),
    maxAttachmentTotalBytes: z.number().int().positive(),
    maxCompletionBytes: z.number().int().positive(),
    expiresAfterMs: z.number().int().positive(),
  })
  .strict();
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

export const DEFAULT_BUDGET = ContextBudgetSchema.parse({
  maxPaths: 25,
  maxReadBytes: 65_536,
  maxServedTextBytes: 1_048_576,
  maxSearchHits: 50,
  maxAttachmentBytes: 10_485_760,
  maxAttachmentTotalBytes: 26_214_400,
  maxCompletionBytes: 262_144,
  expiresAfterMs: 86_400_000,
});

export const HARD_BUDGET = ContextBudgetSchema.parse({
  maxPaths: 100,
  maxReadBytes: 262_144,
  maxServedTextBytes: 8_388_608,
  maxSearchHits: 500,
  maxAttachmentBytes: 26_214_400,
  maxAttachmentTotalBytes: 104_857_600,
  maxCompletionBytes: 1_048_576,
  expiresAfterMs: 604_800_000,
});

const BudgetOverrideSchema = ContextBudgetSchema.partial().strict();
export type ContextBudgetOverride = z.input<typeof BudgetOverrideSchema>;

const budgetKeys = Object.keys(DEFAULT_BUDGET) as (keyof ContextBudget)[];

export const validateBudget = (value: unknown): ContextBudget => {
  const budget = ContextBudgetSchema.parse(value);
  for (const key of budgetKeys) {
    if (budget[key] > HARD_BUDGET[key]) {
      throw new Error(`${key} exceeds the hard budget ceiling`);
    }
  }
  return budget;
};

export const resolveBudget = (overrides: ContextBudgetOverride = {}): ContextBudget => {
  const parsedOverrides = BudgetOverrideSchema.parse(overrides);
  return validateBudget({ ...DEFAULT_BUDGET, ...parsedOverrides });
};

export const SelectionReasonSchema = z.string().regex(
  /^(?:explicit:(?:0|[1-9][0-9]?)|mentioned_path|changed_path|stem_match:(?:[0-9]|1[01])|lexical_match:(?:[0-9]|1[01])|adjacent_test)$/,
);

export const ContextPathSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    mimeType: z.string().min(1).optional(),
    selectionReason: z.array(SelectionReasonSchema).max(100),
    sensitivity: z
      .object({
        decision: z.enum(["allowed", "redacted", "blocked"]),
        reasons: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type ContextPath = z.infer<typeof ContextPathSchema>;

export const ContextManifestSchema = z
  .object({
    selectors: z.array(z.string().min(1)),
    paths: z.array(ContextPathSchema),
    smartSelection: z.boolean(),
    exclusions: z.array(z.string().min(1)),
  })
  .strict();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

export const DiffMetadataSchema = z
  .object({
    baseRef: z.string().min(1),
    headRef: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type DiffMetadata = z.infer<typeof DiffMetadataSchema>;

export const AttachmentDescriptorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    mimeType: z.string().min(1),
    sensitivity: z
      .object({
        decision: z.enum(["allowed", "redacted", "blocked"]),
        reasons: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;

export const SensitivityDecisionSchema = z
  .object({
    scope: z.string().min(1),
    decision: z.enum(["allowed", "redacted", "blocked"]),
    reasons: z.array(z.string().min(1)),
  })
  .strict();
export type SensitivityDecision = z.infer<typeof SensitivityDecisionSchema>;

const ConnectorAllowlistSchema = z.array(z.string().min(1).max(128)).max(100);

export const ChatModeSchema = z.enum(["auto", "new", "continue"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;
export const ChatThreadSchema = z.object({
  projectUrl: z.url(),
  mode: z.enum(["new", "continue"]),
  requestedMode: ChatModeSchema,
  reason: z.enum(["initial", "requested", "turn_limit", "no_conversation", "outside_project", "continuation"]),
  turn: z.number().int().positive(),
}).strict();
export type ChatThread = z.infer<typeof ChatThreadSchema>;

export const RequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    goal: z.string().min(1),
    profile: CapabilityProfileSchema,
    parentId: z.string().min(1).nullable(),
    conversationUrl: z.url().nullable(),
    thread: ChatThreadSchema.optional(),
    state: RequestStateSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    claimHash: z.string().min(1).nullable(),
    idempotencyKey: z.string().min(1),
    creationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    budget: ContextBudgetSchema,
    servedTextBytes: z.number().int().nonnegative(),
    servedSearchHits: z.number().int().nonnegative(),
    contextManifest: ContextManifestSchema,
    diff: DiffMetadataSchema.nullable(),
    attachments: z.array(AttachmentDescriptorSchema),
    sensitivity: z.array(SensitivityDecisionSchema),
    connectorAllowlist: ConnectorAllowlistSchema,
    browserExecution: BrowserExecutionSchema.nullable().default(null),
  })
  .strict();
export type ConsultationRequest = z.infer<typeof RequestSchema>;
export const ConsultationRequestSchema = RequestSchema;

export const CompletionSchema = z
  .object({
    summary: z.string().min(1),
    answer: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    recommendations: z.array(z.string().min(1)).default([]),
    followUpQuestions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ConsultationCompletion = z.infer<typeof CompletionSchema>;
export const ConsultationCompletionSchema = CompletionSchema;

export const StoredCompletionSchema = z
  .object({
    completion: CompletionSchema,
    source: z.enum(["mcp", "manual", "browser"]),
    canonicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type StoredCompletion = z.infer<typeof StoredCompletionSchema>;

export const JsonEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export type JsonEnvelope = z.infer<typeof JsonEnvelopeSchema>;

export const LocalConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    chatgptProjectUrl: z.url().optional(),
    tunnelUrl: z.url().optional(),
    browserCdpPort: z.number().int().min(1).max(65_535).optional(),
    defaultProfile: CapabilityProfileSchema,
    connectorAllowlist: ConnectorAllowlistSchema,
    budget: BudgetOverrideSchema,
  })
  .strict();
export type LocalConfig = z.infer<typeof LocalConfigSchema>;
