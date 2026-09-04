import { describe, expect, test } from "bun:test";
import {
  applyBrowserExecutionUpdate,
  completeBrowserExecution,
  initialBrowserExecution,
} from "../src/core/browser-execution";
import { BrowserExecutionSchema } from "../src/core/schema";

const now = "2026-08-31T10:00:00.000Z";

describe("browser execution state", () => {
  test("starts queued with no lease or submission", () => {
    expect(initialBrowserExecution(now)).toEqual({
      phase: "queued",
      reason: null,
      attempt: 0,
      lease: null,
      submission: { certainty: "not_submitted", attemptedAt: null },
      updatedAt: now,
    });
  });

  test("rejects automatic resubmission after uncertainty", () => {
    const current = BrowserExecutionSchema.parse({
      ...initialBrowserExecution(now),
      phase: "needs_manual",
      reason: "submission_uncertain",
      submission: { certainty: "uncertain", attemptedAt: now },
    });
    expect(() => applyBrowserExecutionUpdate(current, {
      phase: "preparing",
      submissionCertainty: "not_submitted",
    }, "2026-08-31T10:00:01.000Z")).toThrow("uncertain submission");
  });

  test("rejects creating uncertainty in an execution phase", () => {
    const current = applyBrowserExecutionUpdate(
      initialBrowserExecution(now),
      { phase: "preparing" },
      now,
    );
    expect(() => applyBrowserExecutionUpdate(current, {
      phase: "preparing",
      submissionCertainty: "uncertain",
    }, "2026-08-31T10:00:01.000Z")).toThrow("uncertain submission");
  });

  test("never permits submitted certainty to be downgraded", () => {
    const current = BrowserExecutionSchema.parse({
      ...initialBrowserExecution(now),
      phase: "awaiting_response",
      submission: { certainty: "submitted", attemptedAt: now },
    });

    for (const submissionCertainty of ["not_submitted", "uncertain"] as const) {
      expect(() => applyBrowserExecutionUpdate(current, {
        phase: submissionCertainty === "uncertain" ? "needs_manual" : "awaiting_response",
        submissionCertainty,
      }, "2026-08-31T10:00:01.000Z")).toThrow("submitted submission certainty");
    }
  });

  test("rejects mutations to terminal phases", () => {
    const current = applyBrowserExecutionUpdate(
      initialBrowserExecution(now),
      { phase: "cancelled", reason: "timed_out" },
      now,
    );
    expect(() => applyBrowserExecutionUpdate(current, {
      phase: "cancelled",
      incrementAttempt: true,
    }, "2026-08-31T10:00:01.000Z")).toThrow("idempotent");
  });

  test("allows only explicit manual authority to resolve uncertain recovery", () => {
    const current = applyBrowserExecutionUpdate(
      applyBrowserExecutionUpdate(initialBrowserExecution(now), {
        phase: "needs_manual",
        submissionCertainty: "uncertain",
        lease: { ownerId: "a".repeat(32), expiresAt: "2026-08-30T12:01:00.000Z" },
      }, now),
      { phase: "needs_manual" },
      now,
    );
    const completed = completeBrowserExecution(current, "manual", now);
    expect(completed).toMatchObject({
      phase: "completed",
      reason: null,
      lease: null,
      submission: { certainty: "submitted" },
    });
    expect(() => completeBrowserExecution(current, "browser", now)).toThrow();
  });

  test("requires proven response collection for browser authority", () => {
    for (const phase of ["queued", "preparing", "awaiting_browser", "needs_login", "needs_manual"] as const) {
      const current = BrowserExecutionSchema.parse({
        ...initialBrowserExecution(now),
        phase,
      });
      expect(() => completeBrowserExecution(current, "browser", now)).toThrow();
    }
    const notSubmitted = BrowserExecutionSchema.parse({
      ...initialBrowserExecution(now),
      phase: "awaiting_response",
    });
    expect(() => completeBrowserExecution(notSubmitted, "browser", now)).toThrow();
    const proven = BrowserExecutionSchema.parse({
      ...notSubmitted,
      submission: { certainty: "submitted", attemptedAt: now },
    });
    expect(completeBrowserExecution(proven, "browser", now)).toMatchObject({
      phase: "completed",
      lease: null,
      submission: { certainty: "submitted" },
    });
  });

  test("accepts browser completion replay only for a proven completed descendant", () => {
    for (const certainty of ["not_submitted", "uncertain"] as const) {
      const unproven = BrowserExecutionSchema.parse({
        ...initialBrowserExecution(now),
        phase: "completed",
        submission: { certainty, attemptedAt: now },
      });
      expect(() => completeBrowserExecution(unproven, "browser", now)).toThrow(
        "proven browser completion",
      );
    }

    const leased = BrowserExecutionSchema.parse({
      ...initialBrowserExecution(now),
      phase: "completed",
      lease: { ownerId: "a".repeat(32), expiresAt: "2026-08-31T10:01:00.000Z" },
      submission: { certainty: "submitted", attemptedAt: now },
    });
    expect(() => completeBrowserExecution(leased, "browser", now)).toThrow(
      "proven browser completion",
    );

    for (const phase of ["cancelled", "expired"] as const) {
      const terminal = BrowserExecutionSchema.parse({
        ...initialBrowserExecution(now),
        phase,
        submission: { certainty: "submitted", attemptedAt: now },
      });
      expect(() => completeBrowserExecution(terminal, "browser", now)).toThrow();
    }

    const proven = BrowserExecutionSchema.parse({
      ...initialBrowserExecution(now),
      phase: "completed",
      submission: { certainty: "submitted", attemptedAt: now },
    });
    expect(completeBrowserExecution(proven, "browser", now)).toEqual(proven);
  });
});
