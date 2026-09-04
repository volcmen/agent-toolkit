import { AgentBrowserAutomation } from "./agent-browser.js";
import type { ChromeSession } from "./chrome.js";
import {
  type AuthenticationProbeInput,
  type BrowserAutomationHooks,
  type BrowserAutomationInput,
  type BrowserAutomationResult,
  type BrowserCollectionPath,
  sanitizeChatgptUrl,
} from "./handoff.js";
import {
  cleanupBrowserPackage,
  prepareBrowserPackage,
  type BrowserRequestPackage,
} from "./package.js";
import { parseBrowserCompletion } from "./protocol.js";
import { BrowserSessionManager } from "./session.js";
import { ConsultError } from "../core/errors.js";
import type {
  BrowserFailureReason,
  ConsultationCompletion,
  ConsultationRequest,
  SubmissionCertainty,
} from "../core/schema.js";
import {
  BROWSER_LEASE_MS,
  type BrowserSubmissionAttempt,
  type RequestStore,
} from "../core/store.js";
import type { ResolvedProject } from "../security/project.js";

const LOGIN_DEADLINE_MS = 15 * 60_000;
const LEASE_HEARTBEAT_MS = 10_000;
// Match the existing browser subprocess/cleanup grace without extending the
// 30-second lease or any browser operation's own deadline.
const OPERATION_DRAIN_MS = 1_000;

type Automation = Pick<AgentBrowserAutomation, "run" | "waitForAuthenticatedProject">;
type SessionManager = Pick<BrowserSessionManager, "ensureRunning" | "switchOwnedToHeaded">;
type PreparePackage = typeof prepareBrowserPackage;
type CleanupPackage = typeof cleanupBrowserPackage;
type LeaseWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type DetachedFulfillment<T> = (value: T) => Promise<void>;

type MonitoredOperation<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "operation_error" }
  | { readonly kind: "authority_lost"; readonly value?: T };

const waitForLeaseHeartbeat: LeaseWait = (milliseconds, signal) => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(done, milliseconds);
  signal.addEventListener("abort", done, { once: true });
  function done(): void {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
});

export type BrowserJobResult =
  | { kind: "completed"; requestId: string }
  | {
      kind: "recovery";
      requestId: string;
      phase: "needs_login" | "needs_manual";
      reason: BrowserFailureReason;
    }
  | { kind: "cancelled" | "expired"; requestId: string };

export interface BrowserJobOptions {
  readonly project: ResolvedProject;
  readonly store: RequestStore;
  readonly projectUrl: string;
  readonly sessionManager?: SessionManager;
  readonly automation?: Automation;
  readonly preparePackage?: PreparePackage;
  readonly cleanupPackage?: CleanupPackage;
  readonly leaseWait?: LeaseWait;
  readonly drainWait?: LeaseWait;
}

interface Target {
  readonly url: string;
  readonly kind: "configured" | "conversation";
}

export class BrowserJob {
  private readonly project: ResolvedProject;
  private readonly store: RequestStore;
  private readonly projectUrl: string;
  private readonly sessionManager: SessionManager;
  private readonly automation: Automation;
  private readonly preparePackage: PreparePackage;
  private readonly cleanupPackage: CleanupPackage;
  private readonly leaseWait: LeaseWait;
  private readonly drainWait: LeaseWait;

  constructor(options: BrowserJobOptions) {
    const projectUrl = sanitizeChatgptUrl(options.projectUrl, "configured");
    if (projectUrl === null) {
      throw new ConsultError("INVALID_INPUT", "Project URL is not a valid ChatGPT endpoint");
    }
    this.project = options.project;
    this.store = options.store;
    this.projectUrl = projectUrl;
    this.sessionManager = options.sessionManager ?? new BrowserSessionManager();
    this.automation = options.automation ?? new AgentBrowserAutomation();
    this.preparePackage = options.preparePackage ?? prepareBrowserPackage;
    this.cleanupPackage = options.cleanupPackage ?? cleanupBrowserPackage;
    this.leaseWait = options.leaseWait ?? waitForLeaseHeartbeat;
    this.drainWait = options.drainWait ?? waitForLeaseHeartbeat;
  }

  async run(requestId: string, ownerId: string): Promise<BrowserJobResult> {
    let leased = false;
    let browserPackage: BrowserRequestPackage | undefined;
    try {
      let request: ConsultationRequest;
      try {
        request = await this.store.acquireBrowserLease(requestId, ownerId, BROWSER_LEASE_MS);
        leased = true;
      } catch {
        return await this.resultWithoutAuthority(requestId);
      }
      const browserAttempt = request.browserExecution!.attempt;

      const guarded = this.resumeGuard(request);
      if (guarded !== null) return guarded;

      const target = await this.resolveTarget(request);
      if (target === null) {
        return await this.persistRecovery(requestId, ownerId, "needs_manual", "ui_changed");
      }

      const packageOutcome = await this.monitorLease(
        requestId,
        ownerId,
        () => this.preparePackage(this.project, this.store, request),
        async (value) => {
          try {
            await this.cleanupPackage(value);
          } catch {
            // Detached cleanup has no authority to alter the bounded result.
          }
        },
      );
      if ("value" in packageOutcome) browserPackage = packageOutcome.value;
      if (packageOutcome.kind === "authority_lost") {
        return await this.resultWithoutAuthority(requestId);
      }
      if (packageOutcome.kind === "operation_error") {
        return await this.persistRecovery(
          requestId,
          ownerId,
          "needs_manual",
          "browser_unavailable",
        );
      }
      browserPackage = packageOutcome.value;
      if (browserPackage.requestId !== request.id
        || browserPackage.expectedRevision !== request.revision) {
        return await this.persistRecovery(
          requestId,
          ownerId,
          "needs_manual",
          "invalid_response",
        );
      }

      const certainty = request.browserExecution!.submission.certainty;
      const mode = certainty === "submitted" ? "collect_only" : "submit_and_collect";
      const automationTarget = mode === "collect_only"
        ? this.submittedTarget(request, target)
        : target;
      if (automationTarget === null) {
        return await this.persistRecovery(
          requestId,
          ownerId,
          "needs_manual",
          "invalid_response",
        );
      }

      const sessionOutcome = await this.monitorLease(
        requestId,
        ownerId,
        () => this.sessionManager.ensureRunning("headless"),
      );
      if (sessionOutcome.kind === "authority_lost") {
        return await this.resultWithoutAuthority(requestId);
      }
      if (sessionOutcome.kind === "operation_error") {
        return await this.persistRecovery(
          requestId,
          ownerId,
          "needs_manual",
          "browser_unavailable",
        );
      }
      let session = sessionOutcome.value;

      let loginAttempted = false;
      for (;;) {
        const terminal = await this.terminalResult(requestId);
        if (terminal !== null) return terminal;
        await this.prepareAutomationPhase(requestId, ownerId, mode);
        const hooks = this.createHooks(
          requestId,
          ownerId,
          mode === "submit_and_collect" && automationTarget.kind === "conversation"
            ? automationTarget.url
            : undefined,
        );
        let automationResult: BrowserAutomationResult;
        try {
          automationResult = await this.automation.run(
            this.automationInput(browserPackage, request, automationTarget, mode, session),
            hooks,
          );
        } catch {
          return await this.persistRecovery(
            requestId,
            ownerId,
            "needs_manual",
            "browser_unavailable",
          );
        }

        const afterAutomation = await this.terminalResult(requestId);
        if (afterAutomation !== null) return afterAutomation;
        if (automationResult.kind === "completed") {
          return await this.importCompletion(
            requestId,
            ownerId,
            browserAttempt,
            browserPackage,
            automationResult,
          );
        }

        const recovery = await this.persistAutomationRecovery(
          requestId,
          ownerId,
          automationResult,
        );
        if (recovery.kind !== "recovery"
          || recovery.phase !== "needs_login"
          || recovery.reason !== "login_required"
          || automationResult.certainty !== "not_submitted"
          || loginAttempted) {
          return recovery;
        }

        loginAttempted = true;
        const headedOutcome = await this.monitorLease(
          requestId,
          ownerId,
          () => this.sessionManager.switchOwnedToHeaded(),
        );
        if (headedOutcome.kind === "authority_lost") {
          return await this.resultWithoutAuthority(requestId);
        }
        if (headedOutcome.kind === "operation_error") {
          return await this.persistRecovery(
            requestId,
            ownerId,
            "needs_login",
            "browser_unavailable",
          );
        }
        const headed = headedOutcome.value;
        const loginHooks = this.createHooks(requestId, ownerId);
        let authenticated: "authenticated" | "timed_out" | "manual";
        const authenticationOutcome = await this.monitorLease(
          requestId,
          ownerId,
          () => this.automation.waitForAuthenticatedProject(
            this.authenticationInput(headed),
            loginHooks,
          ),
        );
        if (authenticationOutcome.kind === "authority_lost") {
          return await this.resultWithoutAuthority(requestId);
        }
        if (authenticationOutcome.kind === "operation_error") {
          authenticated = "manual";
        } else {
          authenticated = authenticationOutcome.value;
        }
        const afterLogin = await this.terminalResult(requestId);
        if (afterLogin !== null) return afterLogin;
        if (authenticated === "authenticated") {
          session = headed;
          continue;
        }
        if (authenticated === "timed_out") {
          return await this.persistRecovery(
            requestId,
            ownerId,
            "needs_login",
            "login_required",
          );
        }
        return await this.persistRecovery(
          requestId,
          ownerId,
          "needs_manual",
          "human_challenge",
        );
      }
    } catch {
      return leased
        ? await this.persistRecovery(
            requestId,
            ownerId,
            "needs_manual",
            "browser_unavailable",
          )
        : await this.resultWithoutAuthority(requestId);
    } finally {
      if (browserPackage !== undefined) {
        try {
          await this.cleanupPackage(browserPackage);
        } catch {
          // Staging cleanup cannot disclose paths or replace the bounded result.
        }
      }
      if (leased) {
        try {
          await this.store.releaseBrowserLease(requestId, ownerId);
        } catch {
          // Cancellation, expiry, completion, or lease loss may already clear it.
        }
      }
    }
  }

  private resumeGuard(request: ConsultationRequest): BrowserJobResult | null {
    const execution = request.browserExecution!;
    if (execution.submission.certainty === "uncertain") {
      return {
        kind: "recovery",
        requestId: request.id,
        phase: "needs_manual",
        reason: "submission_uncertain",
      };
    }
    return null;
  }

  private async resolveTarget(request: ConsultationRequest): Promise<Target | null> {
    if (request.parentId === null) return { url: this.projectUrl, kind: "configured" };
    let parent: ConsultationRequest;
    try {
      parent = await this.store.get(request.parentId);
    } catch {
      return null;
    }
    const url = sanitizeChatgptUrl(parent.conversationUrl, "conversation");
    if (url === null || url !== parent.conversationUrl) return null;
    return { url, kind: "conversation" };
  }

  private submittedTarget(request: ConsultationRequest, expected: Target): Target | null {
    const url = sanitizeChatgptUrl(request.conversationUrl, "conversation");
    if (url === null || url !== request.conversationUrl) return null;
    if (request.parentId !== null && (expected.kind !== "conversation" || expected.url !== url)) {
      return null;
    }
    return { url, kind: "conversation" };
  }

  private async prepareAutomationPhase(
    requestId: string,
    ownerId: string,
    mode: BrowserAutomationInput["mode"],
  ): Promise<void> {
    let request = await this.store.get(requestId);
    const execution = request.browserExecution!;
    if (mode === "submit_and_collect") {
      if (execution.phase === "needs_login" || execution.phase === "needs_manual") {
        request = await this.store.recordBrowserProgress(requestId, ownerId, {
          phase: "preparing",
          reason: null,
        });
      }
      if (request.browserExecution!.phase !== "awaiting_browser") {
        await this.store.recordBrowserProgress(requestId, ownerId, {
          phase: "awaiting_browser",
          reason: null,
        });
      }
      return;
    }

    if (execution.phase !== "awaiting_response") {
      if (execution.phase !== "preparing" && execution.phase !== "awaiting_browser") {
        request = await this.store.recordBrowserProgress(requestId, ownerId, {
          phase: "awaiting_browser",
          reason: null,
        });
      }
      if (request.browserExecution!.phase !== "awaiting_response") {
        await this.store.recordBrowserProgress(requestId, ownerId, {
          phase: "awaiting_response",
          reason: null,
        });
      }
    }
  }

  private createHooks(
    requestId: string,
    ownerId: string,
    expectedConversationUrl?: string,
  ): BrowserAutomationHooks {
    let capability: BrowserSubmissionAttempt | undefined;
    return {
      beforeSubmission: async () => {
        if (capability !== undefined) {
          throw new ConsultError("CONFLICT", "Browser submission was already attempted");
        }
        capability = await this.store.beginBrowserSubmission(requestId, ownerId);
      },
      submissionConfirmed: async (conversationUrl) => {
        if (capability === undefined) {
          throw new ConsultError("CONFLICT", "Browser submission was not armed");
        }
        const canonicalUrl = sanitizeChatgptUrl(conversationUrl, "conversation");
        if (canonicalUrl === null || canonicalUrl !== conversationUrl
          || (expectedConversationUrl !== undefined
            && canonicalUrl !== expectedConversationUrl)) {
          throw new ConsultError("CONFLICT", "Browser submission left its proven conversation");
        }
        const current = capability;
        await this.store.confirmBrowserSubmission(
          requestId,
          ownerId,
          current,
          canonicalUrl,
        );
        capability = undefined;
      },
      heartbeat: async () => {
        await this.store.renewBrowserLease(requestId, ownerId, BROWSER_LEASE_MS);
      },
      isCancelled: async () => {
        const request = await this.store.get(requestId);
        return request.state === "cancelled" || request.state === "expired";
      },
    };
  }

  private automationInput(
    browserPackage: BrowserRequestPackage,
    request: ConsultationRequest,
    target: Target,
    mode: BrowserAutomationInput["mode"],
    session: ChromeSession,
  ): BrowserAutomationInput {
    return {
      session,
      mode,
      requestId: browserPackage.requestId,
      targetUrl: target.url,
      targetKind: target.kind,
      prompt: browserPackage.prompt,
      uploadPaths: browserPackage.uploadPaths,
      stagingDirectory: browserPackage.directory,
      maximumResponseBytes: request.budget.maxCompletionBytes,
    };
  }

  private authenticationInput(session: ChromeSession): AuthenticationProbeInput {
    return { session, projectUrl: this.projectUrl, deadlineMs: LOGIN_DEADLINE_MS };
  }

  private async importCompletion(
    requestId: string,
    ownerId: string,
    browserAttempt: number,
    browserPackage: BrowserRequestPackage,
    result: Extract<BrowserAutomationResult, { kind: "completed" }>,
  ): Promise<BrowserJobResult> {
    const canonicalUrl = sanitizeChatgptUrl(result.conversationUrl, "conversation");
    const request = await this.store.get(requestId);
    if (canonicalUrl === null || canonicalUrl !== result.conversationUrl
      || request.conversationUrl !== canonicalUrl
      || request.browserExecution?.phase !== "awaiting_response"
      || request.browserExecution.submission.certainty !== "submitted") {
      return await this.persistRecovery(
        requestId,
        ownerId,
        "needs_manual",
        request.browserExecution?.submission.certainty === "uncertain"
          ? "submission_uncertain"
          : "invalid_response",
        undefined,
        result.collectionPath,
      );
    }
    let parsed: ConsultationCompletion;
    try {
      parsed = parseBrowserCompletion(
        result.responseText,
        browserPackage.requestId,
        browserPackage.expectedRevision,
      );
    } catch {
      try {
        await this.store.persistRejectedBrowserCompletion(requestId, ownerId, result.responseText);
      } catch {}
      const terminal = await this.terminalResult(requestId);
      if (terminal !== null) return terminal;
      return await this.persistRecovery(
        requestId,
        ownerId,
        "needs_manual",
        "invalid_response",
        undefined,
        result.collectionPath,
      );
    }
    try {
      await this.store.completeBrowserOwned(
        browserPackage.requestId,
        browserPackage.expectedRevision,
        ownerId,
        browserAttempt,
        parsed,
        result.collectionPath,
      );
      return { kind: "completed", requestId };
    } catch {
      const terminal = await this.terminalResult(requestId);
      if (terminal !== null) return terminal;
      return await this.persistRecovery(
        requestId,
        ownerId,
        "needs_manual",
        "invalid_response",
        undefined,
        result.collectionPath,
      );
    }
  }

  private async persistAutomationRecovery(
    requestId: string,
    ownerId: string,
    value: Extract<BrowserAutomationResult, { kind: "recovery" }>,
  ): Promise<BrowserJobResult> {
    if (value.rejectedText !== undefined) {
      try {
        await this.store.persistRejectedBrowserCompletion(requestId, ownerId, value.rejectedText);
      } catch {}
    }
    const request = await this.store.get(requestId);
    const durableCertainty = request.browserExecution!.submission.certainty;
    if (durableCertainty === "uncertain") {
      return await this.persistRecovery(
        requestId,
        ownerId,
        "needs_manual",
        "submission_uncertain",
        "uncertain",
        value.collectionPath,
      );
    }
    if (value.certainty === "submitted" && durableCertainty !== "submitted") {
      return await this.persistRecovery(
        requestId,
        ownerId,
        "needs_manual",
        "invalid_response",
        durableCertainty,
        value.collectionPath,
      );
    }
    const phase = value.phase === "needs_login"
      && durableCertainty === "not_submitted"
      ? "needs_login"
      : "needs_manual";
    return await this.persistRecovery(
      requestId,
      ownerId,
      phase,
      value.reason,
      durableCertainty,
      value.collectionPath,
    );
  }

  private async persistRecovery(
    requestId: string,
    ownerId: string,
    phase: "needs_login" | "needs_manual",
    reason: BrowserFailureReason,
    certainty?: SubmissionCertainty,
    collectionPath?: BrowserCollectionPath,
  ): Promise<BrowserJobResult> {
    const terminal = await this.terminalResult(requestId);
    if (terminal !== null) return terminal;
    try {
      const request = await this.store.get(requestId);
      const durable = request.browserExecution!.submission.certainty;
      if (durable === "uncertain") {
        phase = "needs_manual";
        reason = "submission_uncertain";
        certainty = "uncertain";
      } else if (phase === "needs_login" && durable !== "not_submitted") {
        phase = "needs_manual";
      }
      const update = {
        phase,
        reason,
        ...(certainty === undefined ? {} : { submissionCertainty: certainty }),
        ...(collectionPath === undefined ? {} : { collectionPath }),
      };
      await this.store.recordBrowserProgress(requestId, ownerId, update);
    } catch {
      const afterFailure = await this.terminalResult(requestId);
      if (afterFailure !== null) return afterFailure;
      // Lease loss prevents further mutation, but the returned reason stays bounded.
    }
    return { kind: "recovery", requestId, phase, reason };
  }

  private async terminalResult(requestId: string): Promise<BrowserJobResult | null> {
    try {
      const request = await this.store.get(requestId);
      if (request.state === "cancelled") return { kind: "cancelled", requestId };
      if (request.state === "expired") return { kind: "expired", requestId };
      if (request.state === "completed") return { kind: "completed", requestId };
      return null;
    } catch (error) {
      return error instanceof ConsultError && error.code === "EXPIRED"
        ? { kind: "expired", requestId }
        : null;
    }
  }

  private async resultWithoutAuthority(requestId: string): Promise<BrowserJobResult> {
    const terminal = await this.terminalResult(requestId);
    return terminal ?? {
      kind: "recovery",
      requestId,
      phase: "needs_manual",
      reason: "browser_unavailable",
    };
  }

  private async monitorLease<T>(
    requestId: string,
    ownerId: string,
    operation: () => Promise<T>,
    onDetachedFulfilled?: DetachedFulfillment<T>,
  ): Promise<MonitoredOperation<T>> {
    try {
      await this.store.renewBrowserLease(requestId, ownerId, BROWSER_LEASE_MS);
    } catch {
      return { kind: "authority_lost" };
    }

    let pending: Promise<
      | { readonly kind: "ok"; readonly value: T }
      | { readonly kind: "operation_error" }
    >;
    try {
      pending = operation().then(
        (value) => ({ kind: "ok" as const, value }),
        () => ({ kind: "operation_error" as const }),
      );
    } catch {
      try {
        await this.store.renewBrowserLease(requestId, ownerId, BROWSER_LEASE_MS);
        return { kind: "operation_error" };
      } catch {
        return { kind: "authority_lost" };
      }
    }

    const controller = new AbortController();
    try {
      for (;;) {
        const heartbeat = this.leaseWait(LEASE_HEARTBEAT_MS, controller.signal).then(
          () => ({ kind: "heartbeat" as const }),
          () => ({ kind: "wait_error" as const }),
        );
        const outcome = await Promise.race([pending, heartbeat]);
        if (outcome.kind === "ok" || outcome.kind === "operation_error") {
          controller.abort();
          try {
            await this.store.renewBrowserLease(requestId, ownerId, BROWSER_LEASE_MS);
          } catch {
            return outcome.kind === "ok"
              ? { kind: "authority_lost", value: outcome.value }
              : { kind: "authority_lost" };
          }
          return outcome;
        }
        if (outcome.kind === "wait_error") {
          controller.abort();
          return await this.drainOrDetach(pending, onDetachedFulfilled);
        }
        try {
          await this.store.renewBrowserLease(requestId, ownerId, BROWSER_LEASE_MS);
        } catch {
          controller.abort();
          return await this.drainOrDetach(pending, onDetachedFulfilled);
        }
      }
    } finally {
      controller.abort();
    }
  }

  private async drainOrDetach<T>(
    pending: Promise<
      | { readonly kind: "ok"; readonly value: T }
      | { readonly kind: "operation_error" }
    >,
    onDetachedFulfilled?: DetachedFulfillment<T>,
  ): Promise<MonitoredOperation<T>> {
    const controller = new AbortController();
    let drain: Promise<{ readonly kind: "drain_elapsed" }>;
    try {
      drain = this.drainWait(OPERATION_DRAIN_MS, controller.signal).then(
        () => ({ kind: "drain_elapsed" as const }),
        () => ({ kind: "drain_elapsed" as const }),
      );
    } catch {
      drain = Promise.resolve({ kind: "drain_elapsed" as const });
    }
    try {
      const drained = await Promise.race([
        pending.then(
          (outcome) => ({ kind: "settled" as const, outcome }),
          () => ({ kind: "settled" as const, outcome: { kind: "operation_error" as const } }),
        ),
        drain,
      ]);
      if (drained.kind === "settled") {
        return drained.outcome.kind === "ok"
          ? { kind: "authority_lost", value: drained.outcome.value }
          : { kind: "authority_lost" };
      }

      // Both handlers are installed before returning. Detached operations can
      // only be consumed; they never resume this run or mutate worker state.
      void pending.then(
        (outcome) => {
          if (outcome.kind !== "ok" || onDetachedFulfilled === undefined) return;
          void Promise.resolve()
            .then(() => onDetachedFulfilled(outcome.value))
            .catch(() => undefined);
        },
        () => undefined,
      );
      return { kind: "authority_lost" };
    } finally {
      controller.abort();
    }
  }
}
