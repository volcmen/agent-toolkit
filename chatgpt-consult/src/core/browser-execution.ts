import {
  BrowserExecutionSchema,
  type BrowserExecution,
  type BrowserFailureReason,
  type BrowserPhase,
  type SubmissionCertainty,
} from "./schema";

export type {
  BrowserExecution,
  BrowserFailureReason,
  BrowserPhase,
  SubmissionCertainty,
} from "./schema";

export interface BrowserExecutionUpdate {
  phase: BrowserPhase;
  reason?: BrowserFailureReason | null;
  submissionCertainty?: SubmissionCertainty;
  attemptedAt?: string | null;
  lease?: { ownerId: string; expiresAt: string } | null;
  incrementAttempt?: boolean;
}

const transitions: Record<BrowserPhase, readonly BrowserPhase[]> = {
  queued: ["queued", "preparing", "needs_manual", "cancelled", "expired"],
  preparing: ["preparing", "awaiting_browser", "awaiting_response", "needs_login", "needs_manual", "cancelled", "expired"],
  awaiting_browser: ["awaiting_browser", "awaiting_response", "needs_login", "needs_manual", "cancelled", "expired"],
  awaiting_response: ["awaiting_response", "completed", "needs_manual", "cancelled", "expired"],
  needs_login: ["needs_login", "preparing", "awaiting_browser", "needs_manual", "cancelled", "expired"],
  needs_manual: ["needs_manual", "preparing", "awaiting_browser", "cancelled", "expired"],
  completed: ["completed"],
  cancelled: ["cancelled"],
  expired: ["expired"],
};
const terminalPhases = new Set<BrowserPhase>(["completed", "cancelled", "expired"]);
const uncertainSafePhases = new Set<BrowserPhase>(["needs_manual", "cancelled", "expired"]);

export const initialBrowserExecution = (timestamp: string): BrowserExecution =>
  BrowserExecutionSchema.parse({
    phase: "queued",
    reason: null,
    attempt: 0,
    lease: null,
    submission: { certainty: "not_submitted", attemptedAt: null },
    updatedAt: timestamp,
  });

export const applyBrowserExecutionUpdate = (
  current: BrowserExecution,
  input: BrowserExecutionUpdate,
  timestamp: string,
): BrowserExecution => {
  const parsedCurrent = BrowserExecutionSchema.parse(current);
  if (!transitions[parsedCurrent.phase].includes(input.phase)) {
    throw new Error(`invalid browser phase transition: ${parsedCurrent.phase} -> ${input.phase}`);
  }
  if (terminalPhases.has(parsedCurrent.phase)) {
    const sameReason = input.reason === undefined || input.reason === parsedCurrent.reason;
    const sameCertainty = input.submissionCertainty === undefined
      || input.submissionCertainty === parsedCurrent.submission.certainty;
    const sameAttemptedAt = input.attemptedAt === undefined
      || input.attemptedAt === parsedCurrent.submission.attemptedAt;
    const sameLease = input.lease === undefined
      || JSON.stringify(input.lease) === JSON.stringify(parsedCurrent.lease);
    if (input.incrementAttempt || !sameReason || !sameCertainty || !sameAttemptedAt || !sameLease) {
      throw new Error("terminal phase only accepts idempotent repeats");
    }
    return parsedCurrent;
  }
  if (
    parsedCurrent.submission.certainty === "uncertain"
    && !uncertainSafePhases.has(input.phase)
  ) {
    throw new Error("uncertain submission cannot transition automatically");
  }
  const nextCertainty = input.submissionCertainty ?? parsedCurrent.submission.certainty;
  if (
    parsedCurrent.submission.certainty === "submitted"
    && nextCertainty !== "submitted"
  ) {
    throw new Error("submitted submission certainty cannot be downgraded");
  }
  if (nextCertainty === "uncertain" && !uncertainSafePhases.has(input.phase)) {
    throw new Error("uncertain submission cannot remain in an execution phase");
  }
  if (
    parsedCurrent.submission.certainty === "uncertain"
    && input.submissionCertainty !== undefined
    && input.submissionCertainty !== "uncertain"
  ) {
    throw new Error("uncertain submission certainty cannot be cleared automatically");
  }

  return BrowserExecutionSchema.parse({
    phase: input.phase,
    reason: input.reason === undefined ? parsedCurrent.reason : input.reason,
    attempt: parsedCurrent.attempt + (input.incrementAttempt ? 1 : 0),
    lease: input.lease === undefined ? parsedCurrent.lease : input.lease,
    submission: {
      certainty: nextCertainty,
      attemptedAt: input.attemptedAt === undefined
        ? parsedCurrent.submission.attemptedAt
        : input.attemptedAt,
    },
    updatedAt: timestamp,
  });
};

/**
 * Validated completion boundary shared by manual imports and browser workers.
 * Manual recovery is an explicit human assertion that submission occurred;
 * browser workers must first reach the ordinary response-collection phase.
 */
export const completeBrowserExecution = (
  current: BrowserExecution,
  source: "manual" | "browser",
  timestamp: string,
): BrowserExecution => {
  const parsed = BrowserExecutionSchema.parse(current);
  if (source === "browser") {
    if (parsed.phase === "completed") {
      if (parsed.submission.certainty !== "submitted" || parsed.lease !== null) {
        throw new Error("browser replay requires a proven browser completion");
      }
      return parsed;
    }
    if (parsed.phase !== "awaiting_response" || parsed.submission.certainty !== "submitted") {
      throw new Error("browser completion requires proven response collection");
    }
  }
  if (parsed.phase === "completed") return parsed;
  if (source === "manual" && (parsed.phase === "needs_login" || parsed.phase === "needs_manual")) {
    return BrowserExecutionSchema.parse({
      ...parsed,
      phase: "completed",
      reason: null,
      lease: null,
      submission: { ...parsed.submission, certainty: "submitted" },
      updatedAt: timestamp,
    });
  }
  let next = parsed;
  if (next.phase !== "awaiting_response") {
    next = applyBrowserExecutionUpdate(next, { phase: "awaiting_response" }, timestamp);
  }
  return applyBrowserExecutionUpdate(next, { phase: "completed", lease: null }, timestamp);
};
