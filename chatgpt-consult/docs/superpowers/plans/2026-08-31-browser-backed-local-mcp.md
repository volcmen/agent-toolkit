# Browser-Backed Local MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the six-tool local MCP run fully automatic, bounded consultations through the user's authenticated ChatGPT web Project with `agent-browser`, headed login recovery, and no API key or public tunnel.

**Architecture:** Persist browser execution and leases beside each request, package only approved context and attachments, and run one resumable Bun worker per browser-enabled request. The worker drives a dedicated or explicitly configured CDP session through a deny-by-default `agent-browser` adapter, validates a sentinel-wrapped completion, and imports it through the existing local completion boundary.

**Tech Stack:** Bun 1.4.0+, TypeScript 5.9.2, Zod 4.5.4, MCP SDK 2.0.0, `agent-browser` 0.35.1, Chrome/Chromium CDP, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-31-browser-backed-local-mcp-design.md`

## Global Constraints

- Keep the local MCP surface at exactly `consult_start`, `consult_status`, `consult_show`, `consult_followup`, `consult_cancel`, and `consult_publish`.
- Do not require or read an OpenAI API key, Secure MCP Tunnel credential, public HTTPS endpoint, or ChatGPT Developer Mode connector.
- Bind no new network listener; browser control uses loopback CDP only.
- Use the configured ChatGPT Project URL for every root request and the proven parent conversation URL for every follow-up.
- Create no more than one ChatGPT conversation per root consultation thread; never resubmit after an uncertain submission.
- Use a dedicated persistent Chrome profile by default. Attach to another CDP session only when its loopback port is explicitly configured.
- Use headless Chrome for routine automation and the same dedicated profile headed for login, 2FA, CAPTCHA, consent, or manual recovery.
- Preserve existing context, sensitivity, attachment, completion, expiration, cancellation, and explicit-publication ceilings.
- Keep browser output bounded, deny arbitrary evaluation/download/cookie/storage/network interception, and allow uploads only from verified request staging paths.
- Keep the existing ChatGPT-facing MCP server loopback-only and dormant; do not start it from the new path.
- Preserve unrelated workspace changes, including the existing untracked root `download.html`.
- Use Bun for JavaScript tooling and pin `agent-browser` in `bun-global-tools/manifest.json`.

## File Structure

### New files

- `src/core/browser-execution.ts` — pure browser phase, lease, submission-certainty, and transition rules.
- `src/core/bundle.ts` — one bounded request-text builder shared by browser and manual workflows.
- `src/browser/protocol.ts` — browser prompt envelope and strict completion parser.
- `src/browser/package.ts` — request-specific attachment staging and complete browser package assembly.
- `src/browser/session.ts` — managed/headed/external-CDP session selection.
- `src/browser/worker.ts` — leased, idempotent browser job coordinator.
- `src/browser/runtime.ts` — production dependency construction for a worker or headed setup.
- `src/browser/worker-process.ts` — bounded detached Bun worker launcher and child entry point.
- `tests/browser-execution.test.ts` — pure execution-state tests.
- `tests/browser-protocol.test.ts` — prompt and response-envelope tests.
- `tests/browser-package.test.ts` — staging, integrity, and bundle-bound tests.
- `tests/browser-session.test.ts` — headless/headed/external-CDP selection tests.
- `tests/browser-worker.test.ts` — coordinator, login, lease, cancellation, and idempotency tests.
- `tests/browser-live.test.ts` — opt-in authenticated acceptance against the configured ChatGPT Project.

### Modified files

- `src/core/schema.ts` — persist `browserExecution`, add browser completion source and local browser config.
- `src/core/store.ts` — lease/progress mutations and browser completion import.
- `src/core/service.ts` — use the shared bundle builder and enqueue/resume automatic jobs.
- `src/browser/cdp.ts` — normalize legacy/current Chrome visibility metadata and validate explicit loopback CDP.
- `src/browser/chrome.ts` — launch and safely switch managed Chrome between headless and headed modes.
- `src/browser/agent-browser.ts` — submit, upload, collect, and classify recovery without arbitrary evaluation.
- `src/browser/handoff.ts` — retain URL sanitization/manual fallback while removing it from automatic prompt construction.
- `src/cli/args.ts` — accept `setup browser` and the private worker entry command.
- `src/cli/main.ts` — construct the browser runtime, enqueue workers, and run headed setup.
- `src/cli/render.ts` — render automatic progress and recovery instructions.
- `src/cli/doctor.ts` — make browser readiness primary and tunnel checks legacy/optional.
- `src/mcp/local.ts` and `src/mcp/results.ts` — expose structured browser progress without changing tool count.
- Existing tests under `tests/` — update assertions that currently expect remote-MCP handoff submission.
- `README.md`, `docs/CHATGPT_SETUP.md`, `docs/SECURITY.md`, `docs/ACCEPTANCE.md` — document the no-key browser flow.
- `plugins/chatgpt-consult/skills/chatgpt-consult/SKILL.md` — teach Codex and Claude to poll automatic jobs and handle login/manual recovery.
- `bun-global-tools/manifest.json` and `bun-global-tools/sync.py` — pin and verify `agent-browser` 0.35.1 through Bun.

---

### Task 1: Define the Browser Execution State Machine

**Files:**
- Create: `chatgpt-consult/src/core/browser-execution.ts`
- Modify: `chatgpt-consult/src/core/schema.ts:11-228`
- Create: `chatgpt-consult/tests/browser-execution.test.ts`
- Modify: `chatgpt-consult/tests/schema.test.ts`

**Interfaces:**
- Consumes: existing `ConsultationRequest`, `RequestState`, and strict Zod conventions.
- Produces: `BrowserExecution`, `BrowserPhase`, `BrowserFailureReason`, `SubmissionCertainty`, `initialBrowserExecution(timestamp)`, and `applyBrowserExecutionUpdate(current, input, timestamp)`.

`applyBrowserExecutionUpdate` consumes this exact pure input type:

```ts
export interface BrowserExecutionUpdate {
  phase: BrowserPhase;
  reason?: BrowserFailureReason | null;
  submissionCertainty?: SubmissionCertainty;
  attemptedAt?: string | null;
  lease?: { ownerId: string; expiresAt: string } | null;
  incrementAttempt?: boolean;
}
```

- [ ] **Step 1: Write failing schema and transition tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  applyBrowserExecutionUpdate,
  initialBrowserExecution,
} from "../src/core/browser-execution";
import { BrowserExecutionSchema } from "../src/core/schema";

const now = "2026-08-31T10:00:00.000Z";

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
```

- [ ] **Step 2: Run the focused tests and confirm missing exports fail**

Run: `cd chatgpt-consult && bun test tests/browser-execution.test.ts tests/schema.test.ts`

Expected: FAIL because `BrowserExecutionSchema` and the pure transition helpers do not exist.

- [ ] **Step 3: Add strict schemas and pure transitions**

```ts
export const BrowserPhaseSchema = z.enum([
  "queued", "preparing", "awaiting_browser", "awaiting_response",
  "needs_login", "needs_manual", "completed", "cancelled", "expired",
]);
export const BrowserFailureReasonSchema = z.enum([
  "login_required", "human_challenge", "browser_unavailable", "ui_changed",
  "upload_failed", "timed_out", "invalid_response", "submission_uncertain",
]);
export const SubmissionCertaintySchema = z.enum([
  "not_submitted", "submitted", "uncertain",
]);
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

// RequestSchema compatibility for requests created before this feature:
browserExecution: BrowserExecutionSchema.nullable().default(null),

// StoredCompletionSchema:
source: z.enum(["mcp", "manual", "browser"]),
```

Implement a closed phase-transition table in `browser-execution.ts`. Terminal
phases accept only idempotent repeats. `uncertain` can transition only to
`needs_manual`, `cancelled`, or `expired`; it can never return to a submitting
phase. Browser updates do not increment the request lifecycle `revision`.

- [ ] **Step 4: Run focused tests and type checking**

Run: `cd chatgpt-consult && bun test tests/browser-execution.test.ts tests/schema.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the state model**

```bash
git add chatgpt-consult/src/core/browser-execution.ts chatgpt-consult/src/core/schema.ts chatgpt-consult/tests/browser-execution.test.ts chatgpt-consult/tests/schema.test.ts
git commit -m "feat(chatgpt-consult): define browser execution state"
```

### Task 2: Persist Leases, Progress, and Browser Completions

**Files:**
- Modify: `chatgpt-consult/src/core/store.ts:64-929`
- Modify: `chatgpt-consult/tests/store.test.ts`

**Interfaces:**
- Consumes: `BrowserExecutionSchema`, `initialBrowserExecution`, and `applyBrowserExecutionUpdate` from Task 1.
- Produces:
  - `acquireBrowserLease(id: string, ownerId: string, durationMs?: number): Promise<ConsultationRequest>`
  - `renewBrowserLease(id: string, ownerId: string, durationMs?: number): Promise<ConsultationRequest>`
  - `recordBrowserProgress(id: string, ownerId: string, input: BrowserProgressInput): Promise<ConsultationRequest>`
  - `releaseBrowserLease(id: string, ownerId: string): Promise<ConsultationRequest>`
  - `completeBrowser(id: string, expectedRevision: number, completion: ConsultationCompletion): Promise<CompletedRequest>`

- [ ] **Step 1: Add failing lease and browser-source tests**

```ts
test("allows one live browser lease and recovers an expired lease", async () => {
  const first = await store.acquireBrowserLease(id, "a".repeat(32), 30_000);
  expect(first.browserExecution?.attempt).toBe(1);
  await expect(store.acquireBrowserLease(id, "b".repeat(32), 30_000))
    .rejects.toMatchObject({ code: "CONFLICT" });
  clock.advance(30_001);
  const recovered = await store.acquireBrowserLease(id, "b".repeat(32), 30_000);
  expect(recovered.browserExecution?.lease?.ownerId).toBe("b".repeat(32));
});

test("imports a browser completion without changing the prompt revision", async () => {
  const before = await store.get(id);
  const completed = await store.completeBrowser(id, before.revision, completion());
  expect(completed.result.source).toBe("browser");
  expect(completed.request.state).toBe("completed");
});
```

Also test wrong-owner renewal, invalid owner IDs, lease ceilings, cancellation
while leased, terminal requests, idempotent release, and event-log redaction.

- [ ] **Step 2: Run the store tests and verify the new methods are absent**

Run: `cd chatgpt-consult && bun test tests/store.test.ts`

Expected: FAIL with missing `RequestStore` browser methods.

- [ ] **Step 3: Implement lease mutations under the existing request lock**

```ts
export const BROWSER_LEASE_MS = 30_000;
export const MAX_BROWSER_LEASE_MS = 60_000;

export interface BrowserProgressInput {
  phase: BrowserPhase;
  reason?: BrowserFailureReason | null;
  submissionCertainty?: SubmissionCertainty;
  conversationUrl?: string;
}
```

Every method must call `withLock(id, ...)`, reject expired/cancelled/completed
requests where mutation is invalid, compare lease expiry using the injected
clock, and atomically rewrite the request. Lease/progress writes update
`updatedAt` but not `revision`, preserving the revision embedded in the browser
prompt. `recordBrowserProgress` canonicalizes `conversationUrl` before the
locked write and writes only closed-enum reason codes to events.

- [ ] **Step 4: Add `completeBrowser` through the existing completion authority**

Refactor the local completion helper so callers select a closed source without
duplicating validation:

```ts
private async completeTrustedLocal(
  id: string,
  expectedRevision: number,
  value: ConsultationCompletion,
  source: "manual" | "browser",
): Promise<CompletedRequest>;

async completeLocal(id, expectedRevision, value) {
  return this.completeTrustedLocal(id, expectedRevision, value, "manual");
}

async completeBrowser(id, expectedRevision, value) {
  return this.completeTrustedLocal(id, expectedRevision, value, "browser");
}
```

On completion, cancellation, or expiry, clear the lease and set the matching
terminal browser phase when `browserExecution` exists.

- [ ] **Step 5: Run focused tests and type checking**

Run: `cd chatgpt-consult && bun test tests/store.test.ts tests/browser-execution.test.ts tests/schema.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit durable execution storage**

```bash
git add chatgpt-consult/src/core/store.ts chatgpt-consult/tests/store.test.ts
git commit -m "feat(chatgpt-consult): persist browser worker leases"
```

### Task 3: Build the Bounded Browser Package and Completion Protocol

**Files:**
- Create: `chatgpt-consult/src/core/bundle.ts`
- Create: `chatgpt-consult/src/browser/protocol.ts`
- Create: `chatgpt-consult/src/browser/package.ts`
- Modify: `chatgpt-consult/src/core/service.ts:733-830`
- Create: `chatgpt-consult/tests/browser-protocol.test.ts`
- Create: `chatgpt-consult/tests/browser-package.test.ts`
- Modify: `chatgpt-consult/tests/service.test.ts`

**Interfaces:**
- Consumes: `ResolvedProject`, `RequestStore`, `ConsultationRequest`, `readApprovedBytes`, and `readStoredAttachment`.
- Produces:
  - `buildBoundedConsultationText(project, store, request, maximumBytes): Promise<string>`
  - `formatBrowserPrompt(requestId, expectedRevision, boundedText): string`
  - `parseBrowserCompletion(text, expectedRequestId, expectedRevision): ConsultationCompletion`
  - `prepareBrowserPackage(project, store, request): Promise<BrowserRequestPackage>`
  - `cleanupBrowserPackage(value: BrowserRequestPackage): Promise<void>`

- [ ] **Step 1: Write failing prompt/parser tests**

```ts
const prompt = formatBrowserPrompt("a".repeat(32), 0, "Goal and bounded context");
expect(prompt).toContain("BEGIN_CHATGPT_CONSULT_REQUEST");
expect(prompt).toContain('"requestId":"' + "a".repeat(32) + '"');
expect(prompt).not.toContain("claim_token");

const response = [
  "BEGIN_CHATGPT_CONSULT_RESULT",
  JSON.stringify({
    schemaVersion: 1,
    requestId: "a".repeat(32),
    expectedRevision: 0,
    completion: completion(),
  }),
  "END_CHATGPT_CONSULT_RESULT",
].join("\n");
expect(parseBrowserCompletion(response, "a".repeat(32), 0)).toEqual(completion());
```

Test missing, repeated, nested, oversized, mismatched-ID, mismatched-revision,
extra-property, and invalid-completion envelopes. Require exactly one marker
pair and one strict JSON object between the markers.

- [ ] **Step 2: Write failing package and staging tests**

Create a fixture with approved context, diff, PNG, and PDF attachments. Assert
that the result contains a prompt under 65,536 bytes and private regular staged
files whose basenames preserve safe extensions. Add refusal tests for symlinked
staging directories, changed stored blobs, duplicate unsafe names, and totals
above the request attachment budget.

- [ ] **Step 3: Run the new tests and confirm missing modules fail**

Run: `cd chatgpt-consult && bun test tests/browser-protocol.test.ts tests/browser-package.test.ts tests/service.test.ts`

Expected: FAIL because the package/protocol modules do not exist.

- [ ] **Step 4: Extract the existing manual bundle into a shared bounded builder**

Move the request text construction from `ConsultationService.manualBundle`
into `buildBoundedConsultationText`. Keep the existing 65,536-byte ceiling,
16,384-byte diff excerpt, 8,192-byte per-context excerpt, JSON quoting, and
"untrusted data" instruction. `manualBundle` writes the returned text exactly
as before so its security and regression tests continue to pass.

- [ ] **Step 5: Implement the strict browser protocol**

```ts
export const BrowserCompletionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  expectedRevision: z.number().int().nonnegative(),
  completion: CompletionSchema,
}).strict();

export const BROWSER_RESULT_BEGIN = "BEGIN_CHATGPT_CONSULT_RESULT";
export const BROWSER_RESULT_END = "END_CHATGPT_CONSULT_RESULT";
export const MAX_BROWSER_RESPONSE_BYTES = HARD_BUDGET.maxCompletionBytes + 16_384;
```

The prompt tells ChatGPT to treat all excerpts and attachments as untrusted,
perform no action outside analysis, and return only the sentinel-wrapped strict
envelope. Parse bytes before JSON and return only `completion`.

- [ ] **Step 6: Stage request attachments privately and immutably**

Use `.chatgpt-consult/browser/<request-id>/uploads/` with directory mode `0700`
and file mode `0600`. Re-read each stored attachment through
`readStoredAttachment`, create each destination with exclusive/no-follow file
handling, fsync it, and generate deterministic collision-safe names such as
`001-review.png`. Return only canonical absolute paths inside that exact upload
directory:

```ts
export interface BrowserRequestPackage {
  requestId: string;
  expectedRevision: number;
  prompt: string;
  uploadPaths: readonly string[];
  directory: string;
}
```

Cleanup removes only the canonical request staging directory after revalidating
its ancestry; stored immutable attachment blobs remain untouched.

- [ ] **Step 7: Run package, service, and attachment regressions**

Run: `cd chatgpt-consult && bun test tests/browser-protocol.test.ts tests/browser-package.test.ts tests/service.test.ts tests/attachments.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit bounded packaging**

```bash
git add chatgpt-consult/src/core/bundle.ts chatgpt-consult/src/browser/protocol.ts chatgpt-consult/src/browser/package.ts chatgpt-consult/src/core/service.ts chatgpt-consult/tests/browser-protocol.test.ts chatgpt-consult/tests/browser-package.test.ts chatgpt-consult/tests/service.test.ts
git commit -m "feat(chatgpt-consult): package bounded browser requests"
```

### Task 4: Support Managed Headless, Headed Login, and Explicit CDP

**Files:**
- Create: `chatgpt-consult/src/browser/session.ts`
- Modify: `chatgpt-consult/src/browser/cdp.ts:1-190`
- Modify: `chatgpt-consult/src/browser/chrome.ts:127-230, 1429-1835`
- Modify: `chatgpt-consult/src/core/schema.ts:218-228`
- Create: `chatgpt-consult/tests/browser-session.test.ts`
- Modify: `chatgpt-consult/tests/chrome.test.ts`
- Modify: `chatgpt-consult/tests/schema.test.ts`

**Interfaces:**
- Consumes: existing Chrome ownership validation and `sanitizeChatgptUrl`.
- Produces:
  - `BrowserVisibility = "headless" | "headed" | "external"`
  - `ChromeController.ensureRunning(visibility?: "headless" | "headed"): Promise<ChromeSession>`
  - `BrowserSessionManager.ensureRunning(visibility): Promise<ChromeSession>`
  - `BrowserSessionManager.switchOwnedToHeaded(): Promise<ChromeSession>`
  - `BrowserSessionManager.closeOwned(): Promise<void>`
  - optional `LocalConfig.browserCdpPort: number`

- [ ] **Step 1: Add failing Chrome mode and session-selection tests**

```ts
test("routine managed Chrome launches headless", async () => {
  const controller = new ChromeController({ adapter });
  const session = await controller.ensureRunning("headless");
  expect(adapter.spawnArgv).toContain("--headless=new");
  expect(session.visibility).toBe("headless");
});

test("login switches only an owned headless browser to headed", async () => {
  const session = await manager.switchOwnedToHeaded();
  expect(adapter.signalledPids).toEqual([ownedPid]);
  expect(adapter.lastSpawnArgv).not.toContain("--headless=new");
  expect(session.visibility).toBe("headed");
});

test("explicit CDP is loopback-only and never closed by us", async () => {
  const session = await managerWithExternalPort.ensureRunning("headless");
  expect(session).toMatchObject({ ownership: "external", visibility: "external" });
  await managerWithExternalPort.closeOwned();
  expect(adapter.signalledPids).toEqual([]);
});
```

Also cover malformed/non-loopback WebSocket URLs, foreign listeners, mode-switch
timeouts, profile conflicts, and legacy ownership records created before a
visibility field existed.

- [ ] **Step 2: Run the focused tests and confirm failures**

Run: `cd chatgpt-consult && bun test tests/browser-session.test.ts tests/chrome.test.ts tests/schema.test.ts`

Expected: FAIL because Chrome sessions do not carry visibility and managed
launch does not accept a mode.

- [ ] **Step 3: Extend ownership/session types without invalidating live legacy state**

```ts
export interface ChromeSession {
  pid: number;
  port: number;
  webSocketUrl: string;
  profileDir: string | null;
  ownership: "owned" | "external";
  visibility: BrowserVisibility;
  reused: boolean;
}
```

Keep ownership schema version 1. Treat a missing visibility field in an old
record as `headed`, because the existing launcher is headed. Write visibility
on every new ownership record and verify it against the live process argv.
Headless launch adds exactly `--headless=new`; headed launch adds no headless
flag.

- [ ] **Step 4: Implement safe mode switching and external CDP attachment**

`switchOwnedToHeaded` calls the existing ownership-proven `closeOwned`, waits
for verified exit, then starts the same canonical profile headed. It refuses
foreign or ambiguous processes. External attachment accepts only integer ports
1–65535, fetches bounded `/json/version` from `127.0.0.1`, parses it through the
existing strict WebSocket validator, marks ownership `external`, and never
signals or closes it.

Add `browserCdpPort: z.number().int().min(1).max(65535).optional()` to local
configuration. No API keys, cookies, or storage state are added.

- [ ] **Step 5: Run browser lifecycle regressions and type checking**

Run: `cd chatgpt-consult && bun test tests/browser-session.test.ts tests/chrome.test.ts tests/browser-smoke.test.ts tests/schema.test.ts && bun run typecheck`

Expected: PASS; the live smoke remains skipped unless its existing opt-in
environment variable is set.

- [ ] **Step 6: Commit browser session modes**

```bash
git add chatgpt-consult/src/browser/session.ts chatgpt-consult/src/browser/cdp.ts chatgpt-consult/src/browser/chrome.ts chatgpt-consult/src/core/schema.ts chatgpt-consult/tests/browser-session.test.ts chatgpt-consult/tests/chrome.test.ts chatgpt-consult/tests/schema.test.ts
git commit -m "feat(chatgpt-consult): add headed browser recovery"
```

### Task 5: Make `agent-browser` Submit, Upload, and Collect Safely

**Files:**
- Modify: `chatgpt-consult/src/browser/agent-browser.ts:1-380`
- Modify: `chatgpt-consult/src/browser/handoff.ts:1-290`
- Modify: `chatgpt-consult/tests/agent-browser.test.ts`
- Modify: `chatgpt-consult/tests/handoff.test.ts`

**Interfaces:**
- Consumes: `ChromeSession`, `BrowserRequestPackage`, strict ChatGPT URL sanitization.
- Produces:
  - `AgentBrowserAutomation.run(input, hooks): Promise<BrowserAutomationResult>`
  - `AgentBrowserAutomation.waitForAuthenticatedProject(input, hooks): Promise<"authenticated" | "timed_out" | "manual">`
  - exact submission callbacks used by the worker to persist certainty before and after Enter.

```ts
export interface BrowserAutomationInput {
  session: ChromeSession;
  mode: "submit_and_collect" | "collect_only";
  requestId: string;
  targetUrl: string;
  targetKind: "configured" | "conversation";
  prompt: string;
  uploadPaths: readonly string[];
  stagingDirectory: string;
  maximumResponseBytes: number;
}

export interface AuthenticationProbeInput {
  session: ChromeSession;
  projectUrl: string;
  deadlineMs: number;
}
```

- [ ] **Step 1: Replace submit-only fixtures with failing full-run tests**

```ts
export interface BrowserAutomationHooks {
  beforeSubmission(): Promise<void>;
  submissionConfirmed(conversationUrl: string): Promise<void>;
  heartbeat(): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export type BrowserAutomationResult =
  | { kind: "completed"; conversationUrl: string; responseText: string }
  | {
      kind: "recovery";
      phase: "needs_login" | "needs_manual";
      reason: BrowserFailureReason;
      certainty: SubmissionCertainty;
      conversationUrl?: string;
    };
```

Use the deterministic command runner to assert: pre-submit assistant count,
optional `upload "input[type=file]" <exact staged paths>`, one composer, callback
before `press Enter`, canonical URL confirmation, polling until the stop control
is absent, and two identical reads of the newest assistant message.

For a root request, also assert that the adapter refuses to type until it has
proved a fresh composer inside the configured Project: the current URL is the
canonical Project URL and the assistant-message count is zero. If ChatGPT opens
an existing conversation, the adapter may click exactly one unambiguous
Project-scoped new-chat control, re-snapshot, and re-run those proofs; otherwise
it returns `needs_manual/ui_changed`. A follow-up does the inverse: it requires
the exact stored conversation URL and preserves the pre-submit message count.

Add separate fixtures for login URL, login screen without composer, CAPTCHA,
consent dialog, multiple composers, upload failure, output overflow, timeout,
foreign navigation, cancelled polling, missing response, changed response, and
press failure returning `submission_uncertain`.

- [ ] **Step 2: Run the adapter tests and verify old behavior fails them**

Run: `cd chatgpt-consult && bun test tests/agent-browser.test.ts tests/handoff.test.ts`

Expected: FAIL because the adapter currently stops after pressing Enter and
forbids every upload.

- [ ] **Step 3: Narrowly extend the deny-by-default policy**

```ts
export const AGENT_BROWSER_POLICY = Object.freeze({
  default: "deny",
  allow: Object.freeze([
    "navigate", "open", "snapshot", "get", "find", "click", "fill",
    "press", "wait", "interact", "upload", "url",
  ] as const),
  deny: Object.freeze([
    "eval", "evalhandle", "addscript", "addinitscript", "addstyle", "expose",
    "setcontent", "download", "waitfordownload", "network", "route", "unroute",
    "requests", "har", "state", "cookies", "storage",
  ] as const),
});
```

The adapter receives upload paths only from `BrowserRequestPackage` and
revalidates that every canonical path is a regular file below that package's
canonical staging directory before building argv.

- [ ] **Step 4: Implement the bounded ChatGPT interaction sequence**

Use `agent-browser` 0.35.1 commands with the existing isolated session,
`--cdp <port>`, `--pin-tab`, `--content-boundaries`, JSON output, strict action
policy, clean environment, and output/deadline ceilings. Interactive snapshots
and ordinary commands retain the 12,288-byte process-output ceiling. Only the
two final response reads use `maximumResponseBytes + 16,384`, capped at
`HARD_BUDGET.maxCompletionBytes + 16,384`, for both `--max-output` and the
process reader; this supports the completion contract without flooding every
browser command.

```text
open <canonical target>
get url
snapshot -i
get count [data-message-author-role="assistant"]
upload input[type="file"] <verified files...>   # only when non-empty
snapshot -i                                     # refs are fresh after upload
fill @<single composer ref> <bounded prompt>
get url                                         # revalidate immediately before submit
press Enter                                     # after beforeSubmission() persisted uncertain
get url                                         # prove/capture conversation
snapshot -i                                     # poll generation controls
find last [data-message-author-role="assistant"] text
find last [data-message-author-role="assistant"] text
```

The two final texts must be byte-identical across consecutive polls and the
assistant count must have increased. Never use `eval`, `wait --fn`, cookies,
storage, screenshots, downloads, or network capture.

- [ ] **Step 5: Implement login/manual classification and bounded waiting**

Treat `/auth` and `/login`, or a recognized sign-in page with no composer, as
`needs_login/login_required/not_submitted`. CAPTCHA, consent, ambiguous dialog,
or UI mismatch returns `needs_manual` with a closed reason. Poll at one-second
intervals, call `heartbeat` at least every ten seconds, stop immediately when
`isCancelled` is true, cap normal response collection at ten minutes, and cap
public messages at 240 sanitized characters.

- [ ] **Step 6: Run adapter regressions and type checking**

Run: `cd chatgpt-consult && bun test tests/agent-browser.test.ts tests/handoff.test.ts tests/webview.test.ts && bun run typecheck`

Expected: PASS. `WebViewSubmitter` remains compilable but is no longer selected
by the production automatic path.

- [ ] **Step 7: Commit full browser automation**

```bash
git add chatgpt-consult/src/browser/agent-browser.ts chatgpt-consult/src/browser/handoff.ts chatgpt-consult/tests/agent-browser.test.ts chatgpt-consult/tests/handoff.test.ts
git commit -m "feat(chatgpt-consult): collect ChatGPT web responses"
```

### Task 6: Coordinate Leased, Idempotent Browser Jobs

**Files:**
- Create: `chatgpt-consult/src/browser/worker.ts`
- Create: `chatgpt-consult/tests/browser-worker.test.ts`

**Interfaces:**
- Consumes: Task 2 store APIs, Task 3 package/protocol APIs, Task 4 session manager, and Task 5 automation.
- Produces: `BrowserJob.run(requestId: string, ownerId: string): Promise<BrowserJobResult>`.

- [ ] **Step 1: Write failing happy-path and same-chat follow-up tests**

```ts
test("leases, submits once, validates, imports, and releases", async () => {
  const result = await job.run(requestId, "a".repeat(32));
  expect(result).toEqual({ kind: "completed", requestId });
  expect(automation.calls).toHaveLength(1);
  expect((await store.getCompletion(requestId))?.source).toBe("browser");
  expect((await store.get(requestId)).browserExecution?.lease).toBeNull();
});

test("follow-up collects from the proven parent conversation", async () => {
  await job.run(childId, "b".repeat(32));
  expect(automation.calls[0]?.targetUrl).toBe("https://chatgpt.com/c/proven-parent");
});
```

- [ ] **Step 2: Add failing recovery/idempotency tests**

Cover expired live lease, cancellation between actions, completion conflict,
invalid response, missing follow-up URL, known submitted URL resuming
collection-only, uncertain submission never resubmitting, upload cleanup,
heartbeat renewal, `needs_login` mode switch, successful login within 15
minutes, and login timeout retaining `needs_login`.

- [ ] **Step 3: Run the worker tests and confirm the coordinator is absent**

Run: `cd chatgpt-consult && bun test tests/browser-worker.test.ts`

Expected: FAIL because `BrowserJob` does not exist.

- [ ] **Step 4: Implement the worker contract and phase ordering**

```ts
export type BrowserJobResult =
  | { kind: "completed"; requestId: string }
  | { kind: "recovery"; requestId: string; phase: "needs_login" | "needs_manual"; reason: BrowserFailureReason }
  | { kind: "cancelled" | "expired"; requestId: string };

export class BrowserJob {
  async run(requestId: string, ownerId: string): Promise<BrowserJobResult>;
}
```

Order operations as: acquire lease; load active request; refuse a follow-up
without a proven parent conversation; prepare package; mark preparing; ensure
session; run automation; validate envelope; call `completeBrowser`; release
lease and staging in `finally`. The submission hooks persist `uncertain` before
Enter and `submitted` plus canonical conversation URL immediately after proof.

- [ ] **Step 5: Implement resume and headed-login behavior**

When certainty is `submitted`, require a canonical conversation URL and call
automation in collection-only mode. When certainty is `uncertain`, return
`needs_manual` without invoking submission. On `needs_login` with
`not_submitted`, close only owned headless Chrome, launch the same managed
profile headed, wait up to 15 minutes for an authenticated Project page while
renewing the 30-second lease every 10 seconds, then resume automatically.

Errors map only to the closed recovery reasons. Raw browser output, prompts,
absolute paths, and attachment data never enter events or public results.

- [ ] **Step 6: Run worker and dependent focused tests**

Run: `cd chatgpt-consult && bun test tests/browser-worker.test.ts tests/browser-package.test.ts tests/browser-protocol.test.ts tests/agent-browser.test.ts tests/store.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the job coordinator**

```bash
git add chatgpt-consult/src/browser/worker.ts chatgpt-consult/tests/browser-worker.test.ts
git commit -m "feat(chatgpt-consult): coordinate resumable browser jobs"
```

### Task 7: Launch Workers from the CLI, Service, and Local MCP

**Files:**
- Create: `chatgpt-consult/src/browser/runtime.ts`
- Create: `chatgpt-consult/src/browser/worker-process.ts`
- Modify: `chatgpt-consult/src/core/service.ts:45-130, 480-730`
- Modify: `chatgpt-consult/src/cli/args.ts:1-120`
- Modify: `chatgpt-consult/src/cli/main.ts:1-370`
- Modify: `chatgpt-consult/src/cli/render.ts:1-130`
- Modify: `chatgpt-consult/src/mcp/local.ts:1-280`
- Modify: `chatgpt-consult/src/mcp/results.ts`
- Modify: `chatgpt-consult/tests/service.test.ts`
- Modify: `chatgpt-consult/tests/cli.test.ts`
- Modify: `chatgpt-consult/tests/local-mcp.test.ts`
- Modify: `chatgpt-consult/tests/stdio-mcp.test.ts`

**Interfaces:**
- Consumes: `BrowserJob` and all production dependencies from Tasks 1–6.
- Produces:
  - `BrowserWorkerLauncher.start(requestId): Promise<void>`
  - private `worker <request-id> <owner-id>` CLI dispatch
  - `setup browser` headed login command
  - automatic enqueue from `start`, `followup`, and `open`/resume.

- [ ] **Step 1: Write failing service and launcher tests**

```ts
test("open start enqueues after durable request creation", async () => {
  const started = await service.start(startInput({ open: true }));
  expect(workerLauncher.ids).toEqual([started.requestId]);
  expect(await store.get(started.requestId)).toMatchObject({
    browserExecution: { phase: "queued" },
  });
});

test("open resumes the existing request instead of rotating a remote claim", async () => {
  await service.open(requestId);
  expect(workerLauncher.ids).toEqual([requestId]);
  expect(await store.get(requestId)).toMatchObject({ claimHash: originalClaimHash });
});
```

Test child-spawn failure, lease-handshake timeout, non-open queue behavior,
cancelled/completed resume refusal, and sanitized public output.

- [ ] **Step 2: Write failing CLI and six-tool MCP tests**

Add tests that `setup browser` launches the dedicated profile headed at the
canonical Project URL; private worker arguments accept exactly a 32-hex request
and owner ID; `consult_start {open:true}` returns queued automatic progress;
`consult_status` exposes the structured phase/reason/certainty; follow-up with
`open:true` enqueues; and `listTools()` still returns exactly the six existing
local names in the existing order.

- [ ] **Step 3: Run integration-focused tests and confirm failures**

Run: `cd chatgpt-consult && bun test tests/service.test.ts tests/cli.test.ts tests/local-mcp.test.ts tests/stdio-mcp.test.ts`

Expected: FAIL because the service still invokes the submit-only launcher
synchronously and `setup browser` is unknown.

- [ ] **Step 4: Build production runtime and bounded child launcher**

`createBrowserRuntime(project, config)` constructs `RequestStore`,
`ContextService`, `BrowserSessionManager`, `AgentBrowserAutomation`, and
`BrowserJob` from the current checkout. `BrowserWorkerLauncher.start` generates
a 32-hex owner ID, spawns:

```text
bun run <absolute-current-bin> worker <request-id> <owner-id>
```

with stdin ignored, bounded stderr, no API-key environment variables, and no
shell. The parent polls private state for at most two seconds and returns only
after the matching live lease appears; otherwise it reports
`browser_unavailable`. After that handshake, call `child.unref()` so a short
CLI invocation can exit while the bounded worker continues. The child exits on
a terminal or recovery result and never starts an HTTP server.

- [ ] **Step 5: Replace synchronous handoff submission with enqueue/resume**

`ConsultationService` receives a `BrowserWorkerLauncher`. `start(open:true)`
initializes queued execution and launches the worker after request persistence.
`followup(open:true)` inherits and requires the proven conversation URL.
`open(id)` means resume and does not rotate the remote claim. Manual `handoff`
and `import-result` remain separate fallback commands.

Extend `StatusResult` with:

```ts
browser?: {
  phase: BrowserPhase;
  reason: BrowserFailureReason | null;
  attempt: number;
  submissionCertainty: SubmissionCertainty;
  conversationUrl?: string;
};
```

- [ ] **Step 6: Wire CLI setup, private worker dispatch, and local MCP output**

`setup browser` resolves the project config, calls
`sessionManager.ensureRunning("headed")`, and opens only the canonical Project
URL with the safe adapter. Human rendering says to sign in directly and rerun
or allow the active worker to continue. The private worker command is omitted
from help and rejects all options. MCP tool names and input schemas stay stable;
text results instruct callers to poll `consult_status`, run `setup browser` on
`needs_login`, and use manual handoff only on `needs_manual`.

- [ ] **Step 7: Run service, CLI, and MCP regressions**

Run: `cd chatgpt-consult && bun test tests/service.test.ts tests/cli.test.ts tests/local-mcp.test.ts tests/stdio-mcp.test.ts tests/skill.test.ts && bun run typecheck`

Expected: PASS and exactly six local MCP tools.

- [ ] **Step 8: Commit local integration**

```bash
git add chatgpt-consult/src/browser/runtime.ts chatgpt-consult/src/browser/worker-process.ts chatgpt-consult/src/core/service.ts chatgpt-consult/src/cli/args.ts chatgpt-consult/src/cli/main.ts chatgpt-consult/src/cli/render.ts chatgpt-consult/src/mcp/local.ts chatgpt-consult/src/mcp/results.ts chatgpt-consult/tests/service.test.ts chatgpt-consult/tests/cli.test.ts chatgpt-consult/tests/local-mcp.test.ts chatgpt-consult/tests/stdio-mcp.test.ts
git commit -m "feat(chatgpt-consult): run browser jobs from local MCP"
```

### Task 8: Make Browser Automation the Documented, Diagnosed Bun Path

**Files:**
- Modify: `bun-global-tools/manifest.json`
- Modify: `bun-global-tools/sync.py`
- Modify: `chatgpt-consult/src/cli/doctor.ts`
- Modify: `chatgpt-consult/src/cli/setup.ts`
- Modify: `chatgpt-consult/README.md`
- Modify: `chatgpt-consult/docs/CHATGPT_SETUP.md`
- Modify: `chatgpt-consult/docs/SECURITY.md`
- Modify: `chatgpt-consult/docs/ACCEPTANCE.md`
- Modify: `chatgpt-consult/plugins/chatgpt-consult/skills/chatgpt-consult/SKILL.md`
- Modify: `chatgpt-consult/tests/doctor.test.ts`
- Modify: `chatgpt-consult/tests/setup.test.ts`
- Modify: `chatgpt-consult/tests/skill.test.ts`
- Modify: `chatgpt-consult/tests/cli.test.ts`

**Interfaces:**
- Consumes: the completed browser-backed CLI/MCP behavior.
- Produces: reproducible `agent-browser` 0.35.1 installation, browser-first doctor output, and matching Codex/Claude skill guidance.

- [ ] **Step 1: Write failing doctor/setup/skill assertions**

Assert that doctor treats `agent-browser`, managed Chrome, project URL, and
browser login as the primary path; missing tunnel configuration is `skip`
rather than `warn`; setup guidance contains `setup browser` and contains no
required API-key/tunnel instruction; and the skill says automatic jobs are
polled until terminal/recovery state.

- [ ] **Step 2: Run documentation-contract tests and verify old guidance fails**

Run: `cd chatgpt-consult && bun test tests/doctor.test.ts tests/setup.test.ts tests/skill.test.ts tests/cli.test.ts`

Expected: FAIL because current setup and doctor make the remote tunnel primary.

- [ ] **Step 3: Pin `agent-browser` in the Bun global manifest**

Add this sorted package entry:

```json
{
  "name": "agent-browser",
  "version": "0.35.1",
  "binaries": ["agent-browser"]
}
```

Extend the sync health check with `run(["agent-browser", "--version"])` and
require stdout to equal `agent-browser 0.35.1`. Run
`python3 bun-global-tools/sync.py apply`, then verify that `command -v
agent-browser` resolves under `~/.bun/bin`, not Homebrew or npm.

- [ ] **Step 4: Rewrite setup, doctor, security, and acceptance guidance**

Make the default flow:

```bash
consult init --chatgpt-project-url https://chatgpt.com/g/g-p-example/project
consult setup clients --apply
consult setup browser
consult doctor
consult start "Review the queue retry policy" --profile lean --file src/queue.ts --open
```

Explain that the user enters credentials only in headed ChatGPT, routine work
is headless, follow-ups reuse the same chat, manual handoff remains available,
and publishing is explicit. Move `serve chatgpt` and Secure MCP Tunnel into a
clearly labeled legacy/optional compatibility section. State that the remote
server is never started automatically.

- [ ] **Step 5: Update the installed skill source**

Keep economical profile selection and explicit bounded files. For `open:true`,
the skill must poll `consult_status`; call `consult_show` only after
`completed`; tell the user to finish headed login on `needs_login`; use the
returned recovery guidance on `needs_manual`; and call `consult_publish` only
after explicit approval.

- [ ] **Step 6: Run docs/contracts and workspace plugin validation**

Run:

```bash
cd chatgpt-consult && bun test tests/doctor.test.ts tests/setup.test.ts tests/skill.test.ts tests/cli.test.ts && bun run typecheck
cd .. && python3 scripts/plugins.py check
python3 bun-global-tools/sync.py check --deep
```

Expected: PASS.

- [ ] **Step 7: Commit tooling, docs, and skill changes**

```bash
git add bun-global-tools/manifest.json bun-global-tools/sync.py chatgpt-consult/src/cli/doctor.ts chatgpt-consult/src/cli/setup.ts chatgpt-consult/README.md chatgpt-consult/docs/CHATGPT_SETUP.md chatgpt-consult/docs/SECURITY.md chatgpt-consult/docs/ACCEPTANCE.md chatgpt-consult/plugins/chatgpt-consult/skills/chatgpt-consult/SKILL.md chatgpt-consult/tests/doctor.test.ts chatgpt-consult/tests/setup.test.ts chatgpt-consult/tests/skill.test.ts chatgpt-consult/tests/cli.test.ts
git commit -m "docs(chatgpt-consult): make browser consultation primary"
```

### Task 9: Prove the Full Local MCP and Authenticated Browser Lifecycle

**Files:**
- Create: `chatgpt-consult/tests/browser-live.test.ts`
- Modify: `chatgpt-consult/tests/e2e.test.ts`
- Modify: `chatgpt-consult/tests/browser-smoke.test.ts`
- Modify: `chatgpt-consult/docs/ACCEPTANCE.md`

**Interfaces:**
- Consumes: the completed six-tool local MCP, worker process, headed setup, and publication boundary.
- Produces: deterministic no-account end-to-end coverage and one explicit opt-in live acceptance test.

- [ ] **Step 1: Add a failing simulated local-MCP browser lifecycle**

Extend `tests/e2e.test.ts` with a deterministic automation fake that calls the
real local MCP tools: start with `open:true`, wait for completed status, show the
browser-sourced result, follow up with `open:true`, assert the same canonical
conversation URL, attach a small image, cancel a separate pending job, and
publish only after an explicit tool call. Assert `serve chatgpt` and the HTTP
MCP factory are never invoked.

- [ ] **Step 2: Run the simulated end-to-end test and close integration gaps**

Run: `cd chatgpt-consult && bun test tests/e2e.test.ts tests/browser-smoke.test.ts`

Expected before final integration fixes: FAIL at the first unimplemented
lifecycle assertion. Make only the minimal corrections in the owning module,
then rerun until PASS.

- [ ] **Step 3: Add the opt-in live acceptance test**

`tests/browser-live.test.ts` is skipped unless
`CHATGPT_CONSULT_BROWSER_ACCEPTANCE=1`. It resolves the current checkout,
loads the already configured canonical Project URL through `readLocalConfig`,
creates a temporary Git fixture, and initializes that fixture with the same URL
without printing it. It then runs a lean root request, polls for at most ten
minutes, validates/shows the result, sends one follow-up and asserts the same
conversation URL, sends one small text attachment, runs a separate manual
import fallback, explicitly publishes into the temporary fixture, and removes
only that temporary fixture afterward.

The test must never read API-key variables, start `serve chatgpt`, invoke
`tunnel-client`, authorize connectors, or publish into the real workspace.

- [ ] **Step 4: Run the complete automated suite**

Run:

```bash
cd chatgpt-consult
bun run check
cd ..
python3 scripts/plugins.py check
```

Expected: all automated tests pass; only the opt-in authenticated test is
skipped.

- [ ] **Step 5: Refresh and verify both live plugin installations**

Run:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

Expected: PASS with Codex and Claude live copies matching this checkout.

- [ ] **Step 6: Verify and stop any legacy local server before live acceptance**

Run read-only process/listener checks first:

```bash
lsof -nP -iTCP:43891 -sTCP:LISTEN
pgrep -fl tunnel-client
```

If port 43891 is owned by the earlier `chatgpt-consult serve chatgpt` from this
checkout, terminate only that verified PID and confirm the listener is gone. If
the owner cannot be proven, stop and report it rather than signaling it. Do not
start a replacement server or tunnel.

- [ ] **Step 7: Open headed login only if the acceptance profile requires it**

Run: `cd chatgpt-consult && bun run ./bin/chatgpt-consult.ts setup browser`

Expected: the configured ChatGPT Project opens in the dedicated headed profile.
If ChatGPT asks for authentication, the account owner completes login, 2FA,
CAPTCHA, and consent directly in that window; no credential is entered into the
terminal or persisted by ChatGPT Consult.

- [ ] **Step 8: Run the authenticated no-key acceptance**

Run the live test with the configured Project URL and with API-key variables
removed from that process environment:

```bash
cd chatgpt-consult
env -u OPENAI_API_KEY -u OPENAI_ORG_ID -u OPENAI_PROJECT_ID \
  CHATGPT_CONSULT_BROWSER_ACCEPTANCE=1 \
  bun test tests/browser-live.test.ts --timeout 900000
```

Expected: the test uses the canonical value already stored in
`.chatgpt-consult/config.local.json` without logging or committing it, and root
consultation, automatic import, same-chat follow-up, bounded attachment, manual
fallback, and explicit temporary publication all pass.

- [ ] **Step 9: Verify no public/tunnel/API path was used**

Run:

```bash
lsof -nP -iTCP:43891 -sTCP:LISTEN
pgrep -fl tunnel-client
git status --short
```

Expected: no legacy listener, no tunnel process, no committed private config or
browser state, and only the pre-existing unrelated `download.html` remains
untracked.

- [ ] **Step 10: Commit final end-to-end coverage**

```bash
git add chatgpt-consult/tests/browser-live.test.ts chatgpt-consult/tests/e2e.test.ts chatgpt-consult/tests/browser-smoke.test.ts chatgpt-consult/docs/ACCEPTANCE.md
git commit -m "test(chatgpt-consult): prove browser-backed consultations"
```

- [ ] **Step 11: Run final verification from a clean feature diff**

Run:

```bash
cd chatgpt-consult && bun run check
cd ..
python3 scripts/plugins.py check
python3 scripts/plugins.py status
python3 bun-global-tools/sync.py check --deep
git diff --check HEAD~9..HEAD
git status --short
```

Expected: every command passes and the status contains only the unrelated
untracked root `download.html`.
