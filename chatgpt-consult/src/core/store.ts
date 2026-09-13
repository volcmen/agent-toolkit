import {
  createHash,
  randomBytes as systemRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sanitizeChatgptUrl, type BrowserCollectionPath } from "../browser/handoff";
import type { ResolvedProject } from "../security/project";
import { assertChatgptRequestProjectionPersistable } from "./chatgpt-projection";
import {
  applyBrowserExecutionUpdate,
  completeBrowserExecution,
  initialBrowserExecution,
} from "./browser-execution";
import { inspectCompletionClaimMaterial, redactTextClaimMaterial } from "./claim-material";
import { ConsultError, ConversationBusyError } from "./errors";
import {
  BrowserExecutionSchema,
  CompletionSchema,
  HARD_BUDGET,
  RequestSchema,
  StoredCompletionSchema,
  type AttachmentDescriptor,
  type BrowserFailureReason,
  type BrowserPhase,
  type SubmissionCertainty,
  type CapabilityProfile,
  type ConsultationCompletion,
  type ConsultationRequest,
  type ContextBudget,
  type ContextManifest,
  type DiffMetadata,
  type SensitivityDecision,
  type StoredCompletion,
  validateBudget,
} from "./schema";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_BACKOFF_MS = 25;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const EVENT_OPEN_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_APPEND |
  fsConstants.O_NOFOLLOW;

export const BROWSER_LEASE_MS = 30_000;
export const MAX_BROWSER_LEASE_MS = 60_000;
const BROWSER_OWNER = /^[a-f0-9]{32}$/;

export interface CreateRequestInput {
  projectName: string;
  goal: string;
  profile: CapabilityProfile;
  parentId: string | null;
  conversationUrl: string | null;
  thread?: ConsultationRequest["thread"];
  idempotencyKey: string;
  budget: ContextBudget;
  contextManifest: ContextManifest;
  diff: DiffMetadata | null;
  attachments: AttachmentDescriptor[];
  sensitivity: SensitivityDecision[];
  connectorAllowlist: string[];
}

export interface CreatedRequest {
  request: ConsultationRequest;
  claimToken: string;
}

export interface BrowserProgressInput {
  phase: BrowserPhase;
  reason?: BrowserFailureReason | null;
  submissionCertainty?: SubmissionCertainty;
  conversationUrl?: string;
  collectionPath?: BrowserCollectionPath;
}

declare const browserSubmissionAttemptBrand: unique symbol;

/**
 * Opaque, process-local proof that one live worker persisted uncertainty
 * immediately before attempting submission. Runtime authority is object
 * identity held by the issuing RequestStore, not any serializable field.
 */
export interface BrowserSubmissionAttempt {
  readonly [browserSubmissionAttemptBrand]: true;
}

export interface CompletedRequest {
  request: ConsultationRequest;
  result: StoredCompletion;
}

export interface RequestStoreOptions {
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  lockNow?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface StoreEvent {
  timestamp: string;
  requestId: string;
  event: string;
  state: ConsultationRequest["state"];
  revision: number;
  metadata: Record<string, string | number | boolean | null>;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const fingerprintCreation = (
  projectId: string,
  input: CreateRequestInput,
  budget: ContextBudget,
): string => digest(canonicalJson({
  projectId,
  projectName: input.projectName,
  goal: input.goal,
  profile: input.profile,
  parentId: input.parentId,
  conversationUrl: input.conversationUrl,
  ...(input.thread === undefined ? {} : { thread: input.thread }),
  budget,
  contextManifest: input.contextManifest,
  diff: input.diff,
  attachments: input.attachments,
  sensitivity: input.sensitivity,
  connectorAllowlist: input.connectorAllowlist,
}));

const invalidInput = (message: string): never => {
  throw new ConsultError("INVALID_INPUT", message);
};

export class RequestStore {
  private readonly project: Readonly<ResolvedProject>;
  private readonly now: () => Date;
  private readonly getRandomBytes: (size: number) => Uint8Array;
  private readonly lockNow: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private initialized = false;
  private temporarySequence = 0;
  private readonly issuedClaims = new Map<string, string>();
  private readonly creationFingerprints = new Map<string, string>();
  private readonly missingCreateEvents = new Set<string>();
  private readonly browserSubmissionAttempts = new WeakMap<
    BrowserSubmissionAttempt,
    { requestId: string; ownerId: string; attempt: number; attemptedAt: string }
  >();

  constructor(
    project: ResolvedProject,
    options: RequestStoreOptions = {},
  ) {
    this.project = Object.freeze({ ...project });
    this.now = options.now ?? (() => new Date());
    this.getRandomBytes = options.randomBytes ?? systemRandomBytes;
    this.lockNow = options.lockNow ?? Date.now;
    this.wait = options.wait ?? sleep;
  }

  static async init(
    project: ResolvedProject,
    options: RequestStoreOptions = {},
  ): Promise<RequestStore> {
    const store = new RequestStore(project, options);
    await store.init();
    return store;
  }

  async init(): Promise<this> {
    if (this.initialized) return this;
    await this.validateProject();
    await this.ensurePrivateDirectory(this.project.stateDir, true);
    for (const name of ["requests", "results", "attachments", "events", "locks", "rejected"]) {
      await this.ensurePrivateDirectory(join(this.project.stateDir, name), false);
    }
    this.initialized = true;
    return this;
  }

  async create(input: CreateRequestInput): Promise<CreatedRequest> {
    await this.init();
    if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") {
      invalidInput("An idempotency key is required");
    }
    const budget = (() => {
      try {
        return validateBudget(input.budget);
      } catch {
        return invalidInput("Request budget is invalid or exceeds a hard ceiling");
      }
    })();
    const incomingFingerprint = fingerprintCreation(this.project.projectId, input, budget);

    const createLock = `create-${digest(input.idempotencyKey).slice(0, 32)}`;
    return this.withLock(createLock, async () => {
      const existing = await this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const storedFingerprint = existing.creationFingerprint
          ?? this.creationFingerprints.get(existing.id);
        if (storedFingerprint !== incomingFingerprint) {
          throw new ConsultError(
            "CONFLICT",
            "The idempotency key belongs to a different request payload",
          );
        }
        const cachedClaim = this.issuedClaims.get(existing.id);
        if (!cachedClaim) {
          if (existing.state !== "pending") {
            throw new ConsultError(
              "CONFLICT",
              "The request already exists and its one-time claim is no longer available",
            );
          }
          const recovered = await this.rotateClaim(existing.id);
          this.creationFingerprints.set(existing.id, incomingFingerprint);
          return recovered;
        }
        if (this.missingCreateEvents.has(existing.id)) {
          await this.appendEvent("created", existing, {});
          this.missingCreateEvents.delete(existing.id);
        }
        return { request: existing, claimToken: cachedClaim };
      }

      const timestamp = this.timestamp();
      const idEntropy = this.random(16);
      const id = digest(
        Buffer.concat([idEntropy, Buffer.from(`\0${input.idempotencyKey}`, "utf8")]),
      ).slice(0, 32);
      const claimToken = this.random(32).toString("base64url");
      const requestValue = {
        schemaVersion: 1,
        id,
        projectId: this.project.projectId,
        projectName: input.projectName,
        goal: input.goal,
        profile: input.profile,
        parentId: input.parentId,
        conversationUrl: input.conversationUrl,
        ...(input.thread === undefined ? {} : { thread: input.thread }),
        state: "pending",
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: new Date(this.now().getTime() + input.budget.expiresAfterMs).toISOString(),
        claimHash: digest(claimToken),
        idempotencyKey: input.idempotencyKey,
        creationFingerprint: incomingFingerprint,
        budget,
        servedTextBytes: 0,
        servedSearchHits: 0,
        contextManifest: input.contextManifest,
        diff: input.diff,
        attachments: input.attachments,
        sensitivity: input.sensitivity,
        connectorAllowlist: input.connectorAllowlist,
      };
      const parsed = RequestSchema.safeParse(requestValue);
      if (!parsed.success) {
        throw new ConsultError("INVALID_INPUT", "Request input does not match the request schema");
      }
      const request = parsed.data;
      assertChatgptRequestProjectionPersistable(request);

      await this.atomicWrite(this.requestPath(id), request);
      this.issuedClaims.set(id, claimToken);
      this.creationFingerprints.set(id, incomingFingerprint);
      try {
        await this.appendEvent("created", request, {});
      } catch (error) {
        this.missingCreateEvents.add(id);
        throw error;
      }
      return { request, claimToken };
    });
  }

  async get(id: string): Promise<ConsultationRequest> {
    await this.init();
    this.validateId(id);
    return this.withLock(id, async () => this.materializeExpiry(await this.readRequest(id)));
  }

  async claim(id: string, claimToken: string): Promise<ConsultationRequest> {
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      this.verifyClaim(request, claimToken);
      assertChatgptRequestProjectionPersistable(request);
      request = await this.rejectIfExpired(request);
      if (request.state !== "pending" && request.state !== "claimed") {
        throw new ConsultError("CONFLICT", `Cannot claim a ${request.state} request`);
      }
      if (request.state === "claimed") return request;

      request = this.transition(request, { state: "claimed" });
      await this.atomicWrite(this.requestPath(id), request);
      await this.appendEvent("claimed", request, {});
      return request;
    });
  }

  async authorize(id: string, claimToken: string): Promise<ConsultationRequest> {
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      this.verifyClaim(request, claimToken);
      request = await this.rejectIfExpired(request);
      if (request.state !== "claimed") {
        throw new ConsultError("CONFLICT", `Cannot authorize a ${request.state} request`);
      }
      return request;
    });
  }

  async consumeTextBudget(
    id: string,
    claimToken: string,
    bytes: number,
  ): Promise<ConsultationRequest> {
    return this.consumeBudget(
      id,
      claimToken,
      bytes,
      "servedTextBytes",
      "maxServedTextBytes",
      "Text byte count",
    );
  }

  async consumeSearchHits(
    id: string,
    claimToken: string,
    hits: number,
  ): Promise<ConsultationRequest> {
    return this.consumeBudget(
      id,
      claimToken,
      hits,
      "servedSearchHits",
      "maxSearchHits",
      "Search hit count",
    );
  }

  async consumeRetrievalBudget(
    id: string,
    claimToken: string,
    textBytes: number,
    searchHits: number,
  ): Promise<ConsultationRequest> {
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      this.verifyClaim(request, claimToken);
      this.validateCounter(textBytes, "Text byte count");
      this.validateCounter(searchHits, "Search hit count");
      request = await this.rejectIfExpired(request);
      if (request.state !== "claimed") {
        throw new ConsultError("CONFLICT", `Cannot consume budget for a ${request.state} request`);
      }
      const servedTextBytes = request.servedTextBytes + textBytes;
      const servedSearchHits = request.servedSearchHits + searchHits;
      if (
        !Number.isSafeInteger(servedTextBytes)
        || !Number.isSafeInteger(servedSearchHits)
        || servedTextBytes > request.budget.maxServedTextBytes
        || servedSearchHits > request.budget.maxSearchHits
      ) {
        throw new ConsultError("BUDGET_EXCEEDED", "Retrieval budget exceeded", {
          textLimit: request.budget.maxServedTextBytes,
          searchHitLimit: request.budget.maxSearchHits,
        });
      }
      request = RequestSchema.parse({
        ...request,
        servedTextBytes,
        servedSearchHits,
        updatedAt: this.timestamp(),
      });
      await this.atomicWrite(this.requestPath(id), request);
      await this.appendEvent("budget_consumed", request, {
        textBytes,
        searchHits,
        servedTextBytes,
        servedSearchHits,
      });
      return request;
    });
  }

  async complete(
    id: string,
    claimToken: string,
    expectedRevision: number,
    value: ConsultationCompletion,
  ): Promise<CompletedRequest> {
    const completion = this.parseCompletion(value);
    await this.init();
    this.validateId(id);

    const snapshot = await this.readRequest(id);
    this.verifyClaim(snapshot, claimToken);
    this.validateRevision(expectedRevision);
    this.validateCompletionSize(snapshot, completion);
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      this.verifyClaim(request, claimToken);
      request = await this.rejectIfExpired(request);
      if (request.state === "cancelled") {
        throw new ConsultError("CONFLICT", "A cancelled request cannot be completed");
      }
      this.rejectClaimMaterial(request, completion);
      if (request.state === "completed") {
        this.validateCompletedRevision(request, expectedRevision);
        return this.resolveRepeatedCompletion(request, completion);
      }
      if (request.state !== "claimed") {
        throw new ConsultError("CONFLICT", "The request must be claimed before completion");
      }
      return this.persistCompletion(request, expectedRevision, completion, "mcp");
    });
  }

  async completeLocal(
    id: string,
    expectedRevision: number,
    value: ConsultationCompletion,
  ): Promise<CompletedRequest> {
    return this.completeTrustedLocal(id, expectedRevision, value, "manual");
  }

  private async completeTrustedLocal(
    id: string,
    expectedRevision: number,
    value: ConsultationCompletion,
    source: "manual" | "browser",
  ): Promise<CompletedRequest> {
    const completion = this.parseCompletion(value);
    await this.init();
    this.validateRevision(expectedRevision);
    this.validateId(id);

    const snapshot = await this.readRequest(id);
    this.validateCompletionSize(snapshot, completion);
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      if (request.state === "cancelled") {
        throw new ConsultError("CONFLICT", "A cancelled request cannot be completed");
      }
      this.rejectClaimMaterial(request, completion);
      if (request.state === "completed") {
        this.validateCompletedRevision(request, expectedRevision);
        if (source === "browser") {
          if (request.browserExecution === null) {
            throw new ConsultError(
              "CONFLICT",
              "Browser replay requires persisted browser execution proof",
            );
          }
          try {
            completeBrowserExecution(request.browserExecution, "browser", this.timestamp());
          } catch {
            throw new ConsultError(
              "CONFLICT",
              "Browser replay requires a proven browser completion",
            );
          }
        }
        const repeated = await this.resolveRepeatedCompletion(request, completion);
        if (source === "browser" && repeated.result.source !== "browser") {
          throw new ConsultError("CONFLICT", "Browser replay requires a browser-source result");
        }
        return repeated;
      }
      return this.persistCompletion(request, expectedRevision, completion, source);
    });
  }

  async completeBrowser(
    id: string,
    expectedRevision: number,
    value: ConsultationCompletion,
  ): Promise<CompletedRequest> {
    return this.completeTrustedLocal(id, expectedRevision, value, "browser");
  }

  /**
   * Worker-only browser completion boundary. The active write is authorized
   * inside the request lock by both the current live lease and the attempt the
   * worker captured when it acquired that lease. A completed replay is
   * read-only and remains bound to the persisted attempt.
   */
  async completeBrowserOwned(
    id: string,
    expectedRevision: number,
    ownerId: string,
    expectedAttempt: number,
    value: ConsultationCompletion,
    collectionPath?: BrowserCollectionPath,
  ): Promise<CompletedRequest> {
    this.validateBrowserOwner(ownerId);
    if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1) {
      invalidInput("Browser attempt is invalid");
    }
    const completion = this.parseCompletion(value);
    await this.init();
    this.validateRevision(expectedRevision);
    this.validateId(id);

    const snapshot = await this.readRequest(id);
    this.validateCompletionSize(snapshot, completion);
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      const execution = request.browserExecution;
      if (request.state === "completed") {
        if (execution?.attempt !== expectedAttempt) {
          throw new ConsultError("CONFLICT", "Browser completion attempt is no longer current");
        }
        this.validateCompletedRevision(request, expectedRevision);
        try {
          completeBrowserExecution(execution, "browser", this.timestamp());
        } catch {
          throw new ConsultError("CONFLICT", "Browser replay requires a proven browser completion");
        }
        const repeated = await this.resolveRepeatedCompletion(request, completion);
        if (repeated.result.source !== "browser") {
          throw new ConsultError("CONFLICT", "Browser replay requires a browser-source result");
        }
        return repeated;
      }

      this.requireLiveBrowserLease(execution, ownerId);
      if (execution.attempt !== expectedAttempt) {
        throw new ConsultError("CONFLICT", "Browser completion attempt is no longer current");
      }
      request = await this.rejectIfExpired(request);
      if (request.state === "cancelled") {
        throw new ConsultError("CONFLICT", "A cancelled request cannot be completed");
      }
      this.rejectClaimMaterial(request, completion);
      return this.persistCompletion(request, expectedRevision, completion, "browser", collectionPath);
    });
  }

  /**
   * Persist the browser-work intent before a controller may spawn a worker.
   * Repeated calls preserve an existing execution verbatim so a live or
   * recoverable attempt can only be advanced by its lease owner.
   */
  async queueBrowserExecution(id: string): Promise<ConsultationRequest> {
    await this.init();
    this.validateId(id);
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      if (request.state !== "pending" && request.state !== "claimed") {
        throw new ConsultError("CONFLICT", `Cannot queue a ${request.state} request`);
      }
      if (request.browserExecution !== null) return request;
      return this.persistBrowserExecution(
        request,
        initialBrowserExecution(this.timestamp()),
        "browser_queued",
        { phase: "queued" },
      );
    });
  }

  /**
   * Controller-only pre-lease failure boundary. Once any worker has acquired
   * authority, its persisted state wins and this method becomes a no-op.
   */
  async recordBrowserLaunchFailure(id: string): Promise<ConsultationRequest> {
    await this.init();
    this.validateId(id);
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      const current = request.browserExecution;
      if (request.state !== "pending" && request.state !== "claimed") return request;
      if (current === null || current.phase !== "queued" || current.lease !== null) return request;
      const failed = applyBrowserExecutionUpdate(current, {
        phase: "needs_manual",
        reason: "browser_unavailable",
      }, this.timestamp());
      return this.persistBrowserExecution(
        request,
        failed,
        "browser_launch_failed",
        { phase: "needs_manual", reason: "browser_unavailable" },
      );
    });
  }

  async acquireBrowserLease(
    id: string,
    ownerId: string,
    durationMs = BROWSER_LEASE_MS,
  ): Promise<ConsultationRequest> {
    this.validateBrowserOwner(ownerId);
    this.validateLeaseDuration(durationMs);
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      if (request.state === "cancelled" || request.state === "completed") {
        throw new ConsultError("CONFLICT", `Cannot lease a ${request.state} request`);
      }
      const current = request.browserExecution ?? initialBrowserExecution(this.timestamp());
      if (current.lease && new Date(current.lease.expiresAt).getTime() > this.now().getTime()) {
        throw new ConsultError("CONFLICT", "The request already has a live browser lease");
      }
      const updated = applyBrowserExecutionUpdate(current, {
        phase: current.phase === "queued" ? "preparing" : current.phase,
        lease: { ownerId, expiresAt: new Date(this.now().getTime() + durationMs).toISOString() },
        incrementAttempt: true,
      }, this.timestamp());
      request = await this.persistBrowserExecution(request, updated, "browser_lease_acquired", {
        attempt: updated.attempt,
      });
      return request;
    });
  }

  async renewBrowserLease(
    id: string,
    ownerId: string,
    durationMs = BROWSER_LEASE_MS,
  ): Promise<ConsultationRequest> {
    this.validateBrowserOwner(ownerId);
    this.validateLeaseDuration(durationMs);
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      const current = request.browserExecution;
      this.requireLiveBrowserLease(current, ownerId);
      const updated = applyBrowserExecutionUpdate(current, {
        phase: current.phase,
        lease: { ownerId, expiresAt: new Date(this.now().getTime() + durationMs).toISOString() },
      }, this.timestamp());
      return this.persistBrowserExecution(request, updated, "browser_lease_renewed", {});
    });
  }

  async recordBrowserProgress(
    id: string,
    ownerId: string,
    input: BrowserProgressInput,
  ): Promise<ConsultationRequest> {
    this.validateBrowserOwner(ownerId);
    await this.init();
    this.validateId(id);
    let canonicalUrl: string | undefined;
    if (input.conversationUrl !== undefined) {
      const value = sanitizeChatgptUrl(input.conversationUrl, "conversation");
      if (value === null) invalidInput("Invalid conversation URL");
      else canonicalUrl = value;
    }
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      const current = request.browserExecution;
      this.requireLiveBrowserLease(current, ownerId);
      if (["cancelled", "expired", "completed"].includes(input.phase)) {
        throw new ConsultError("CONFLICT", "Terminal browser phases are owned by request lifecycle mutations");
      }
      if (input.submissionCertainty === "submitted"
        && current.submission.certainty !== "submitted") {
        throw new ConsultError(
          "CONFLICT",
          "Browser submission confirmation requires per-attempt authority",
        );
      }
      if (current.submission.certainty === "submitted"
        && input.submissionCertainty !== undefined
        && input.submissionCertainty !== "submitted") {
        throw new ConsultError("CONFLICT", "Submitted browser certainty cannot be downgraded");
      }
      const browserUpdate = {
        phase: input.phase,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.submissionCertainty !== undefined
          ? { submissionCertainty: input.submissionCertainty }
          : {}),
      };
      const updated = applyBrowserExecutionUpdate(current, browserUpdate, this.timestamp());
      if (canonicalUrl !== undefined && request.conversationUrl !== canonicalUrl) {
        request = RequestSchema.parse({ ...request, conversationUrl: canonicalUrl });
      }
      return this.persistBrowserExecution(request, updated, "browser_progress", {
        phase: updated.phase,
        ...(updated.reason ? { reason: updated.reason } : {}),
        ...(input.collectionPath !== undefined ? { collectionPath: input.collectionPath } : {}),
      });
    });
  }

  async persistRejectedBrowserCompletion(
    id: string,
    ownerId: string,
    rawText: string,
  ): Promise<void> {
    this.validateBrowserOwner(ownerId);
    if (typeof rawText !== "string") invalidInput("Rejected browser completion text is invalid");
    await this.init();
    this.validateId(id);
    await this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      this.requireLiveBrowserLease(request.browserExecution, ownerId);
      const boundedBytes = Buffer.from(rawText, "utf8").subarray(0, HARD_BUDGET.maxCompletionBytes);
      const redacted = redactTextClaimMaterial(boundedBytes.toString("utf8"), request.claimHash);
      await this.atomicWrite(this.rejectedPath(id), {
        requestId: id,
        rejectedAt: this.timestamp(),
        text: redacted,
      });
    });
  }

  async beginBrowserSubmission(
    id: string,
    ownerId: string,
  ): Promise<BrowserSubmissionAttempt> {
    this.validateBrowserOwner(ownerId);
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      const current = request.browserExecution;
      this.requireLiveBrowserLease(current, ownerId);
      if (current.phase !== "awaiting_browser"
        || current.submission.certainty !== "not_submitted") {
        throw new ConsultError(
          "CONFLICT",
          "Browser submission requires a live pre-submission attempt",
        );
      }
      const attemptedAt = this.timestamp();
      const updated = applyBrowserExecutionUpdate(current, {
        phase: "needs_manual",
        reason: "submission_uncertain",
        submissionCertainty: "uncertain",
        attemptedAt,
      }, attemptedAt);
      const persisted = await this.persistBrowserExecution(
        request,
        updated,
        "browser_submission_attempted",
        { phase: updated.phase, reason: "submission_uncertain" },
      );
      const capability = Object.freeze({}) as BrowserSubmissionAttempt;
      this.browserSubmissionAttempts.set(capability, {
        requestId: id,
        ownerId,
        attempt: persisted.browserExecution!.attempt,
        attemptedAt,
      });
      return capability;
    });
  }

  async confirmBrowserSubmission(
    id: string,
    ownerId: string,
    capability: BrowserSubmissionAttempt,
    conversationUrl: string,
  ): Promise<ConsultationRequest> {
    this.validateBrowserOwner(ownerId);
    await this.init();
    this.validateId(id);
    const canonicalUrl = sanitizeChatgptUrl(conversationUrl, "conversation");
    if (canonicalUrl === null || canonicalUrl !== conversationUrl) {
      invalidInput("Conversation URL must already be canonical");
    }
    return this.withLock(id, async () => {
      const authority = capability !== null && typeof capability === "object"
        ? this.browserSubmissionAttempts.get(capability)
        : undefined;
      if (!authority || authority.requestId !== id || authority.ownerId !== ownerId) {
        throw new ConsultError("CONFLICT", "Browser submission confirmation is not authorized");
      }
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      const current = request.browserExecution;
      this.requireLiveBrowserLease(current, ownerId);
      if (current.attempt !== authority.attempt
        || current.phase !== "needs_manual"
        || current.reason !== "submission_uncertain"
        || current.submission.certainty !== "uncertain"
        || current.submission.attemptedAt !== authority.attemptedAt) {
        throw new ConsultError("CONFLICT", "Browser submission attempt is no longer current");
      }

      // This is the sole automatic authority allowed to clear uncertainty.
      // Generic progress, a restarted store, and a later lease cannot reach it.
      this.browserSubmissionAttempts.delete(capability);
      const updated = BrowserExecutionSchema.parse({
        ...current,
        phase: "awaiting_response",
        reason: null,
        submission: { ...current.submission, certainty: "submitted" },
        updatedAt: this.timestamp(),
      });
      request = RequestSchema.parse({ ...request, conversationUrl: canonicalUrl });
      return this.persistBrowserExecution(
        request,
        updated,
        "browser_submission_confirmed",
        { phase: updated.phase },
      );
    });
  }

  async releaseBrowserLease(id: string, ownerId: string): Promise<ConsultationRequest> {
    this.validateBrowserOwner(ownerId);
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      const current = request.browserExecution;
      if (!current || !current.lease) return request;
      if (current.lease.ownerId !== ownerId && new Date(current.lease.expiresAt).getTime() > this.now().getTime()) {
        throw new ConsultError("CONFLICT", "The browser lease belongs to another worker");
      }
      const updated = applyBrowserExecutionUpdate(current, {
        phase: current.phase,
        lease: null,
      }, this.timestamp());
      return this.persistBrowserExecution(request, updated, "browser_lease_released", {});
    });
  }

  async cancel(id: string): Promise<ConsultationRequest> {
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      if (request.state === "cancelled") return request;
      if (request.state === "completed") {
        throw new ConsultError("CONFLICT", "A completed request cannot be cancelled");
      }
      request = this.transition(request, { state: "cancelled", claimHash: null });
      if (request.browserExecution) {
        const browserExecution = applyBrowserExecutionUpdate(request.browserExecution, {
          phase: "cancelled",
          lease: null,
        }, this.timestamp());
        request = RequestSchema.parse({ ...request, browserExecution });
      }
      await this.atomicWrite(this.requestPath(id), request);
      await this.appendEvent("cancelled", request, {});
      this.issuedClaims.delete(id);
      this.creationFingerprints.delete(id);
      return request;
    });
  }

  async rotateClaim(id: string, allowClaimed = false): Promise<CreatedRequest> {
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      request = await this.rejectIfExpired(request);
      if (request.state !== "pending" && request.state !== "claimed") {
        throw new ConsultError("CONFLICT", `Cannot rotate a ${request.state} request claim`);
      }
      if (request.state === "claimed" && !allowClaimed) {
        throw new ConsultError("CONFLICT", "Claimed request rotation requires explicit approval");
      }
      const claimToken = this.random(32).toString("base64url");
      request = this.transition(request, { claimHash: digest(claimToken) });
      await this.atomicWrite(this.requestPath(id), request);
      await this.appendEvent("claim_rotated", request, { allowClaimed });
      this.issuedClaims.set(id, claimToken);
      return { request, claimToken };
    });
  }

  async setConversationUrl(id: string, value: string): Promise<ConsultationRequest> {
    await this.init();
    this.validateId(id);
    const canonical = sanitizeChatgptUrl(value, "conversation");
    if (canonical === null) {
      invalidInput("Invalid conversation URL");
    }
    return this.withLock(id, async () => {
      const request = await this.readRequest(id);
      if (request.conversationUrl === canonical) return request;
      const updated = RequestSchema.parse({
        ...request,
        conversationUrl: canonical,
        updatedAt: this.timestamp(),
      });
      assertChatgptRequestProjectionPersistable(updated);
      await this.atomicWrite(this.requestPath(id), updated);
      await this.appendEvent("conversation_url_updated", updated, {});
      return updated;
    });
  }

  async getCompletion(id: string): Promise<StoredCompletion | null> {
    await this.init();
    this.validateId(id);
    return this.readResult(id, true);
  }

  async withBrowserConversation<T>(
    conversationUrl: string | null,
    current: { requestId?: string; idempotencyKey?: string; allowBusy?: boolean },
    operation: () => Promise<T>,
  ): Promise<T> {
    if (conversationUrl === null) return operation();
    const canonicalUrl = sanitizeChatgptUrl(conversationUrl, "conversation");
    if (canonicalUrl === null) throw new ConsultError("INVALID_INPUT", "Conversation URL is invalid");
    await this.init();
    return this.withLock(`conversation-${digest(canonicalUrl).slice(0, 32)}`, async () => {
      if (!current.allowBusy) await this.assertBrowserConversationAvailable(canonicalUrl, current);
      return operation();
    });
  }

  async assertBrowserConversationAvailable(
    conversationUrl: string,
    current: { requestId?: string; idempotencyKey?: string },
  ): Promise<void> {
    const entries = await readdir(join(this.project.stateDir, "requests"));
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const request = await this.get(entry.slice(0, -5));
      if (request.id === current.requestId || request.idempotencyKey === current.idempotencyKey
        || request.conversationUrl !== conversationUrl || request.state === "completed"
        || request.state === "cancelled" || request.state === "expired") continue;
      const execution = request.browserExecution;
      if (execution === null) continue;
      const active = execution.lease !== null
        && new Date(execution.lease.expiresAt).getTime() > this.now().getTime();
      if (!active && execution.submission.certainty === "not_submitted"
        && (execution.phase === "needs_manual" || execution.phase === "needs_login")) continue;
      throw new ConversationBusyError(request.id);
    }
  }

  async countConversationRequests(conversationUrl: string): Promise<number> {
    await this.init();
    let count = 0;
    for (const entry of await readdir(join(this.project.stateDir, "requests"))) {
      if (!entry.endsWith(".json")) continue;
      const request = await this.get(entry.slice(0, -5));
      if (request.conversationUrl !== conversationUrl) continue;
      const certainty = request.browserExecution?.submission.certainty;
      if ((request.state !== "cancelled" && request.state !== "expired")
        || certainty === "submitted" || certainty === "uncertain") count += 1;
    }
    return count;
  }

  async listRecent(limit = 20): Promise<ConsultationRequest[]> {
    await this.init();
    if (!Number.isInteger(limit) || limit <= 0) invalidInput("Recent request limit must be positive");
    const entries = await readdir(join(this.project.stateDir, "requests"));
    const requests = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.get(entry.slice(0, -5))),
    );
    return requests
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  private async consumeBudget(
    id: string,
    claimToken: string,
    amount: number,
    counter: "servedTextBytes" | "servedSearchHits",
    maximum: "maxServedTextBytes" | "maxSearchHits",
    counterName: string,
  ): Promise<ConsultationRequest> {
    await this.init();
    return this.withLock(id, async () => {
      let request = await this.readRequest(id);
      this.verifyClaim(request, claimToken);
      this.validateCounter(amount, counterName);
      request = await this.rejectIfExpired(request);
      if (request.state !== "claimed") {
        throw new ConsultError("CONFLICT", `Cannot consume budget for a ${request.state} request`);
      }
      const total = request[counter] + amount;
      if (!Number.isSafeInteger(total) || total > request.budget[maximum]) {
        throw new ConsultError("BUDGET_EXCEEDED", `${counter} budget exceeded`, {
          limit: request.budget[maximum],
        });
      }
      request = RequestSchema.parse({
        ...request,
        [counter]: total,
        updatedAt: this.timestamp(),
      });
      await this.atomicWrite(this.requestPath(id), request);
      await this.appendEvent("budget_consumed", request, { amount, total });
      return request;
    });
  }

  private async persistCompletion(
    request: ConsultationRequest,
    expectedRevision: number,
    completion: ConsultationCompletion,
    source: StoredCompletion["source"],
    collectionPath?: BrowserCollectionPath,
  ): Promise<CompletedRequest> {
    if (request.revision !== expectedRevision) {
      throw new ConsultError("CONFLICT", "Request revision does not match", {
        expectedRevision,
        actualRevision: request.revision,
      });
    }
    if (source === "browser" && request.browserExecution === null) {
      throw new ConsultError("CONFLICT", "Browser completion requires persisted browser execution proof");
    }
    const canonicalDigest = digest(canonicalJson(completion));
    const existing = await this.readResult(request.id, true);
    if (existing) {
      if (existing.canonicalDigest !== canonicalDigest) {
        throw new ConsultError("CONFLICT", "A different completion already exists");
      }
      if (source === "browser" && existing.source !== "browser") {
        throw new ConsultError("CONFLICT", "Browser completion requires a browser-source result");
      }
    }
    const result = existing ?? StoredCompletionSchema.parse({
      completion,
      source,
      canonicalDigest,
      completedAt: this.timestamp(),
    });
    let completedRequest = this.transition(request, { state: "completed" });
    if (completedRequest.browserExecution) {
      let browserExecution;
      try {
        browserExecution = completeBrowserExecution(
          completedRequest.browserExecution,
          source === "manual" ? "manual" : "browser",
          this.timestamp(),
        );
      } catch {
        throw new ConsultError("CONFLICT", "Browser execution is not ready for this completion authority");
      }
      completedRequest = RequestSchema.parse({ ...completedRequest, browserExecution });
    }
    if (!existing) await this.atomicWrite(this.resultPath(request.id), result);
    await this.atomicWrite(this.requestPath(request.id), completedRequest);
    await this.appendEvent("completed", completedRequest, {
      source: result.source,
      ...(collectionPath !== undefined ? { collectionPath } : {}),
    });
    return { request: completedRequest, result };
  }

  private async resolveRepeatedCompletion(
    request: ConsultationRequest,
    completion: ConsultationCompletion,
  ): Promise<CompletedRequest> {
    const result = await this.readResult(request.id, false);
    if (result.canonicalDigest !== digest(canonicalJson(completion))) {
      throw new ConsultError("CONFLICT", "A different completion already exists");
    }
    return { request, result };
  }

  private validateCompletionSize(
    request: ConsultationRequest,
    completion: ConsultationCompletion,
  ): void {
    const bytes = Buffer.byteLength(canonicalJson(completion), "utf8");
    if (bytes > request.budget.maxCompletionBytes) {
      throw new ConsultError("BUDGET_EXCEEDED", "Completion byte budget exceeded", {
        limit: request.budget.maxCompletionBytes,
      });
    }
  }

  private rejectClaimMaterial(
    request: ConsultationRequest,
    completion: ConsultationCompletion,
  ): void {
    const decision = inspectCompletionClaimMaterial(completion, request.claimHash);
    if (decision !== "clean") {
      throw new ConsultError("INVALID_INPUT", "Completion contains forbidden claim material");
    }
  }

  private validateCompletedRevision(
    request: ConsultationRequest,
    expectedRevision: number,
  ): void {
    if (request.revision !== expectedRevision + 1) {
      throw new ConsultError("CONFLICT", "Request revision does not match the completed request", {
        expectedRevision,
        actualRevision: request.revision,
      });
    }
  }

  private parseCompletion(value: ConsultationCompletion): ConsultationCompletion {
    const parsed = CompletionSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConsultError("INVALID_INPUT", "Completion does not match the completion schema");
    }
    return parsed.data;
  }

  private async rejectIfExpired(request: ConsultationRequest): Promise<ConsultationRequest> {
    request = await this.materializeExpiry(request);
    if (request.state === "expired") throw new ConsultError("EXPIRED", "The request has expired");
    return request;
  }

  private async materializeExpiry(
    request: ConsultationRequest,
  ): Promise<ConsultationRequest> {
    if (request.state === "expired") return request;
    if (
      (request.state === "pending" || request.state === "claimed") &&
      this.now().getTime() >= new Date(request.expiresAt).getTime()
    ) {
      let expired = this.transition(request, { state: "expired", claimHash: null });
      if (expired.browserExecution) {
        const browserExecution = applyBrowserExecutionUpdate(expired.browserExecution, {
          phase: "expired",
          lease: null,
        }, this.timestamp());
        expired = RequestSchema.parse({ ...expired, browserExecution });
      }
      await this.atomicWrite(this.requestPath(request.id), expired);
      await this.appendEvent("expired", expired, {});
      this.issuedClaims.delete(request.id);
      this.creationFingerprints.delete(request.id);
      return expired;
    }
    return request;
  }

  private async persistBrowserExecution(
    request: ConsultationRequest,
    browserExecution: ConsultationRequest["browserExecution"],
    event: string,
    metadata: StoreEvent["metadata"],
  ): Promise<ConsultationRequest> {
    const updated = RequestSchema.parse({
      ...request,
      browserExecution,
      updatedAt: this.timestamp(),
    });
    assertChatgptRequestProjectionPersistable(updated);
    await this.atomicWrite(this.requestPath(request.id), updated);
    await this.appendEvent(event, updated, metadata);
    return updated;
  }

  private validateBrowserOwner(ownerId: string): void {
    if (typeof ownerId !== "string" || !BROWSER_OWNER.test(ownerId)) {
      invalidInput("Browser worker owner identifier is invalid");
    }
  }

  private validateLeaseDuration(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_BROWSER_LEASE_MS) {
      invalidInput("Browser lease duration exceeds its hard ceiling");
    }
  }

  private requireLiveBrowserLease(
    execution: ConsultationRequest["browserExecution"],
    ownerId: string,
  ): asserts execution is NonNullable<ConsultationRequest["browserExecution"]> {
    if (!execution?.lease || execution.lease.ownerId !== ownerId) {
      throw new ConsultError("CONFLICT", "The browser lease belongs to another worker");
    }
    if (new Date(execution.lease.expiresAt).getTime() <= this.now().getTime()) {
      throw new ConsultError("EXPIRED", "The browser lease has expired");
    }
  }

  private transition(
    request: ConsultationRequest,
    changes: Partial<Pick<ConsultationRequest, "state" | "claimHash">>,
  ): ConsultationRequest {
    return RequestSchema.parse({
      ...request,
      ...changes,
      revision: request.revision + 1,
      updatedAt: this.timestamp(),
    });
  }

  private verifyClaim(request: ConsultationRequest, claimToken: string): void {
    if (typeof claimToken !== "string" || request.claimHash === null) {
      throw new ConsultError("NOT_FOUND", "Request or claim was not found");
    }
    const expected = Buffer.from(request.claimHash, "hex");
    const actual = Buffer.from(digest(claimToken), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ConsultError("NOT_FOUND", "Request or claim was not found");
    }
  }

  async findByIdempotencyKey(key: string): Promise<ConsultationRequest | null> {
    await this.init();
    const entries = await readdir(join(this.project.stateDir, "requests"));
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const request = await this.readRequest(entry.slice(0, -5));
      if (request.idempotencyKey === key) return request;
    }
    return null;
  }

  private async readRequest(id: string): Promise<ConsultationRequest> {
    this.validateId(id);
    const request = await this.readAndParse(this.requestPath(id), RequestSchema, false);
    try {
      validateBudget(request.budget);
    } catch {
      throw new ConsultError("CORRUPT_STATE", "Persisted request budget exceeds hard ceilings");
    }
    return request;
  }

  private async readResult(id: string, optional: true): Promise<StoredCompletion | null>;
  private async readResult(id: string, optional: false): Promise<StoredCompletion>;
  private async readResult(id: string, optional: boolean): Promise<StoredCompletion | null> {
    this.validateId(id);
    if (optional) return this.readAndParse(this.resultPath(id), StoredCompletionSchema, true);
    return this.readAndParse(this.resultPath(id), StoredCompletionSchema, false);
  }

  private async readAndParse<T>(
    path: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    optional: true,
  ): Promise<T | null>;
  private async readAndParse<T>(
    path: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    optional: false,
  ): Promise<T>;
  private async readAndParse<T>(
    path: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    optional: boolean,
  ): Promise<T | null> {
    let text: string;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ConsultError("CORRUPT_STATE", "Persisted state is not a regular file");
      }
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (optional) return null;
        throw new ConsultError("NOT_FOUND", "Request state was not found");
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ConsultError("CORRUPT_STATE", "Persisted state is malformed JSON");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ConsultError("CORRUPT_STATE", "Persisted state does not match its schema");
    }
    return parsed.data;
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const directory = dirname(path);
    const randomPart = this.random(12).toString("hex");
    const temporaryPath = join(
      directory,
      `.${basename(path)}.${process.pid}.${this.temporarySequence++}.${randomPart}.tmp`,
    );
    let renamed = false;
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
      renamed = true;
    } finally {
      if (!renamed) await rm(temporaryPath, { force: true });
    }
  }

  private async appendEvent(
    event: string,
    request: ConsultationRequest,
    metadata: StoreEvent["metadata"],
  ): Promise<void> {
    const record: StoreEvent = {
      timestamp: this.timestamp(),
      requestId: request.id,
      event,
      state: request.state,
      revision: request.revision,
      metadata,
    };
    const path = join(this.project.stateDir, "events", `${request.id}.jsonl`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, EVENT_OPEN_FLAGS, PRIVATE_FILE_MODE);
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new ConsultError("CORRUPT_STATE", "Event state is not a regular file");
      }
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ConsultError("CORRUPT_STATE", "Event state cannot be a symbolic link");
      }
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.validateId(id);
    const lockPath = join(this.project.stateDir, "locks", `${id}.lock`);
    const deadline = this.lockNow() + LOCK_TIMEOUT_MS;
    while (true) {
      if (this.lockNow() >= deadline) {
        throw new ConsultError("UNAVAILABLE", "Timed out waiting for the request lock");
      }
      try {
        await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const remaining = deadline - this.lockNow();
        if (remaining <= 0) {
          throw new ConsultError("UNAVAILABLE", "Timed out waiting for the request lock");
        }
        await this.wait(Math.min(LOCK_BACKOFF_MS, remaining));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { force: true, recursive: true });
    }
  }

  private async ensurePrivateDirectory(path: string, stateDirectory: boolean): Promise<void> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new ConsultError("FORBIDDEN_PATH", "State directories cannot be symbolic links");
      }
      if (!info.isDirectory()) {
        throw new ConsultError("CORRUPT_STATE", "State path is not a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new ConsultError("FORBIDDEN_PATH", "State directories must be real directories");
        }
      }
    }
    await chmod(path, PRIVATE_DIRECTORY_MODE);
    if (stateDirectory && basename(path) !== ".chatgpt-consult") {
      throw new ConsultError("INTERNAL", "Unexpected state directory");
    }
  }

  private async validateProject(): Promise<void> {
    const expectedStateDir = join(this.project.root, ".chatgpt-consult");
    if (this.project.stateDir !== expectedStateDir) {
      throw new ConsultError(
        "FORBIDDEN_PATH",
        "State directory must be the private directory directly under the project root",
      );
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.project.root);
    } catch {
      throw new ConsultError("FORBIDDEN_PATH", "Project root cannot be resolved");
    }
    if (canonicalRoot !== this.project.root) {
      throw new ConsultError("FORBIDDEN_PATH", "Project root must be canonical");
    }
    const rootInfo = await lstat(canonicalRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new ConsultError("FORBIDDEN_PATH", "Project root must be a real directory");
    }
  }

  private requestPath(id: string): string {
    return join(this.project.stateDir, "requests", `${id}.json`);
  }

  private resultPath(id: string): string {
    return join(this.project.stateDir, "results", `${id}.json`);
  }

  private rejectedPath(id: string): string {
    return join(this.project.stateDir, "rejected", `${id}.json`);
  }

  private validateId(id: string): void {
    if (typeof id !== "string" || !SAFE_ID.test(id)) invalidInput("Request identifier is invalid");
  }

  private validateCounter(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) invalidInput(`${label} must be non-negative`);
  }

  private validateRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) invalidInput("Revision must be non-negative");
  }

  private random(size: number): Buffer {
    const bytes = Buffer.from(this.getRandomBytes(size));
    if (bytes.length !== size) {
      throw new ConsultError("INTERNAL", "Random byte source returned the wrong byte count");
    }
    return bytes;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ConsultError("INTERNAL", "Clock returned an invalid date");
    }
    return value.toISOString();
  }
}
