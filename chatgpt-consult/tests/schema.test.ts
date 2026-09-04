import { describe, expect, test } from "bun:test";
import {
  CompletionSchema,
  DEFAULT_BUDGET,
  HARD_BUDGET,
  LocalConfigSchema,
  RequestSchema,
  resolveBudget,
  resolveRequestedProfile,
} from "../src/core/schema";

const validRequest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "request-1",
  projectId: "project-1",
  projectName: "Example project",
  goal: "Review the request schema",
  profile: "analysis",
  parentId: null,
  conversationUrl: null,
  state: "pending",
  revision: 0,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  expiresAt: "2026-08-31T00:00:00.000Z",
  claimHash: null,
  idempotencyKey: "idempotency-1",
  budget: DEFAULT_BUDGET,
  servedTextBytes: 0,
  servedSearchHits: 0,
  contextManifest: {
    selectors: ["src/core/schema.ts"],
    paths: [],
    smartSelection: false,
    exclusions: [],
  },
  diff: null,
  attachments: [],
  sensitivity: [],
  connectorAllowlist: [],
  ...overrides,
});

describe("domain schemas", () => {
  test("pins conservative token and byte budgets", () => {
    expect(DEFAULT_BUDGET).toEqual({
      maxPaths: 25,
      maxReadBytes: 65_536,
      maxServedTextBytes: 1_048_576,
      maxSearchHits: 50,
      maxAttachmentBytes: 10_485_760,
      maxAttachmentTotalBytes: 26_214_400,
      maxCompletionBytes: 262_144,
      expiresAfterMs: 86_400_000,
    });
  });

  test("rejects an invalid lifecycle state", () => {
    expect(() => RequestSchema.parse(validRequest({ state: "running" })))
      .toThrow();
  });

  test("accepts requests without browser execution for compatibility", () => {
    expect(RequestSchema.parse(validRequest()).browserExecution).toBeNull();
  });

  test("requires a direct answer in a completion", () => {
    expect(() => CompletionSchema.parse({ summary: "short" })).toThrow();
  });

  test("accepts a valid downward budget override", () => {
    expect(resolveBudget({ maxPaths: 10 })).toMatchObject({ maxPaths: 10 });
  });

  test("rejects a budget override above its hard ceiling", () => {
    expect(() => resolveBudget({ maxPaths: HARD_BUDGET.maxPaths + 1 })).toThrow();
  });

  test("persists deterministic selection reasons and sensitivity metadata", () => {
    const request = RequestSchema.parse(validRequest({
      contextManifest: {
        selectors: ["src/core/schema.ts"],
        paths: [{
          path: "src/core/schema.ts",
          sha256: "a".repeat(64),
          bytes: 123,
          mimeType: "text/typescript",
          selectionReason: ["explicit:0"],
          sensitivity: { decision: "allowed", reasons: [] },
        }],
        smartSelection: false,
        exclusions: [],
      },
    }));

    expect(request.contextManifest.paths[0]).toMatchObject({
      selectionReason: ["explicit:0"],
      sensitivity: { decision: "allowed", reasons: [] },
    });
  });

  test("persists diff truncation and attachment sensitivity metadata", () => {
    const request = RequestSchema.parse(validRequest({
      diff: {
        baseRef: "HEAD",
        headRef: "WORKTREE",
        sha256: "b".repeat(64),
        bytes: 456,
        truncated: true,
      },
      attachments: [{
        id: "c".repeat(64),
        name: "notes.txt",
        sha256: "c".repeat(64),
        bytes: 12,
        mimeType: "text/plain",
        sensitivity: { decision: "allowed", reasons: ["credential_assignment"] },
      }],
    }));

    expect(request.diff?.truncated).toBe(true);
    expect(request.attachments[0]?.sensitivity).toEqual({
      decision: "allowed",
      reasons: ["credential_assignment"],
    });
  });

  test("bounds persisted request and local-config connector allowlists", () => {
    const connectors = Array.from({ length: 101 }, (_, index) => `connector-${index}`);
    expect(() => RequestSchema.parse(validRequest({ connectorAllowlist: connectors })))
      .toThrow();
    expect(() => LocalConfigSchema.parse({
      schemaVersion: 1,
      defaultProfile: "connected",
      connectorAllowlist: connectors,
      budget: {},
    })).toThrow();
  });

  test.each([
    ["files", { files: ["src/queue.ts"], attachments: [], diff: "none" as const }],
    ["attachments", { files: [], attachments: ["notes.txt"], diff: "none" as const }],
    ["a working diff", { files: [], attachments: [], diff: "working" as const }],
  ])("resolves an omitted profile carrying %s to analysis", (_name, context) => {
    expect(resolveRequestedProfile(undefined, context)).toBe("analysis");
  });

  test("resolves an omitted profile with no context to nothing, leaving the caller's fallback in force", () => {
    expect(resolveRequestedProfile(undefined, { files: [], attachments: [], diff: "none" })).toBeUndefined();
  });

  test("never overrides an explicitly requested profile with a context-bearing derivation", () => {
    expect(resolveRequestedProfile("lean", { files: ["src/queue.ts"], attachments: [], diff: "none" }))
      .toBe("lean");
  });

  test("accepts only integer loopback CDP port numbers in local configuration", () => {
    const base = {
      schemaVersion: 1 as const,
      defaultProfile: "lean" as const,
      connectorAllowlist: [],
      budget: {},
    };
    expect(LocalConfigSchema.parse({ ...base, browserCdpPort: 9222 }).browserCdpPort).toBe(9222);
    for (const browserCdpPort of [0, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => LocalConfigSchema.parse({ ...base, browserCdpPort })).toThrow();
    }
  });
});
