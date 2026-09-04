# ChatGPT Consult Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a professional Bun-based bridge that lets local agents request bounded consultations from ChatGPT web, exchange project context through MCP, and save a structured result without API billing or response scraping.

**Architecture:** A project-pinned domain core and private filesystem store back two small MCP surfaces: stdio lifecycle tools for local agents and a guarded Streamable HTTP context/completion surface for ChatGPT. An optional browser layer controls one dedicated Chrome process through loopback CDP, with Bun WebView as the primary controller and agent-browser as a constrained fallback; the protocol always retains a manual handoff path.

**Tech Stack:** Bun 1.4.0, TypeScript, `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, Zod 4.5.4, Bun test, Bun WebView, Chrome DevTools Protocol, optional agent-browser 0.34.0, Python workspace manifest tooling.

**Spec:** `docs/superpowers/specs/2026-08-30-chatgpt-consult-design.md`

## Global Constraints

- Read the approved spec before Task 1 and keep it open while implementing every task.
- Use `superpowers:test-driven-development` for every production-code task and `superpowers:verification-before-completion` before the final completion claim.
- Use `plugin-creator`, `skill-creator`, and `superpowers:writing-skills` before creating the workspace plugin and skill in Task 12; create no hand-written plugin manifests.
- Use an isolated worktree created through `superpowers:using-git-worktrees` at execution time.
- The package and workspace plugin version are both `1.0.0`; do not bump them during this plan.
- Bun `1.4.0` is the runtime floor. Pin `@types/bun` to `1.4.0`.
- Pin `@modelcontextprotocol/server` and `@modelcontextprotocol/client` to `2.0.0`, Zod to `4.5.4`, and TypeScript to `5.9.2`.
- Do not add a local model, OpenAI API dependency, API key path, response scraper, database, web dashboard, hosted service, or semantic retrieval.
- Each running server resolves one immutable project root and can never read its parent or another project.
- Explicit context is the default. Smart context is deterministic, local, inspectable, and opt-in.
- The ChatGPT MCP surface is read-only except for completing its claimed request. It never publishes or edits project files.
- Browser state lives outside repositories. CDP binds only to loopback, and only one Chrome process may own the dedicated profile.
- Private consultation state is `.chatgpt-consult/` and must be ignored. Curated output is written only by explicit `publish` to `docs/consultations/`.
- stdout is reserved for protocol or requested command output; diagnostics go to stderr and never include secrets, cookies, raw claim capabilities, or unrequested file content.
- Preserve the user's unrelated untracked `download.html` and all unrelated worktree changes.
- After changes to the plugin, catalog, or project scripts, run `python3 scripts/plugins.py sync` followed by `python3 scripts/plugins.py check`.
- Do not run `python3 wiki/scripts/update.py`; it is unrelated and mutating.

## File Map

| Path | Responsibility |
| --- | --- |
| `chatgpt-consult/package.json` | Pinned Bun package, binary, and verification scripts |
| `chatgpt-consult/tsconfig.json` | Strict Bun/TypeScript compilation contract |
| `chatgpt-consult/bin/chatgpt-consult.ts` | Executable entry that delegates to the CLI |
| `chatgpt-consult/src/core/schema.ts` | Versioned request, completion, config, manifest, budget, and JSON-envelope schemas |
| `chatgpt-consult/src/core/errors.ts` | Stable domain error codes and safe serialization |
| `chatgpt-consult/src/core/store.ts` | Atomic request/result persistence, locks, lifecycle, claims, and events |
| `chatgpt-consult/src/core/service.ts` | Consultation use cases shared by CLI and MCP |
| `chatgpt-consult/src/security/project.ts` | Project-root resolution and confined path resolution |
| `chatgpt-consult/src/security/policy.ts` | Default exclusions and MIME/path policy |
| `chatgpt-consult/src/security/secrets.ts` | High-confidence blocking and bounded redaction findings |
| `chatgpt-consult/src/context/selection.ts` | Explicit and deterministic smart selection plus manifest construction |
| `chatgpt-consult/src/context/search.ts` | Bounded approved-path lexical search and chunked reads |
| `chatgpt-consult/src/context/diff.ts` | Fixed-argv Git diff capture and section retrieval |
| `chatgpt-consult/src/context/attachments.ts` | MIME validation, hashing, immutable storage, and MCP content conversion |
| `chatgpt-consult/src/cli/args.ts` | Dependency-free command and option parser |
| `chatgpt-consult/src/cli/render.ts` | Stable JSON envelope and concise human output |
| `chatgpt-consult/src/cli/main.ts` | Command dispatch, exit codes, and injected service/browser dependencies |
| `chatgpt-consult/src/cli/doctor.ts` | Independent readiness probes and redacted report |
| `chatgpt-consult/src/cli/setup.ts` | Preview/apply local MCP client registration and ChatGPT setup guidance |
| `chatgpt-consult/src/mcp/results.ts` | MCP success/error result normalization |
| `chatgpt-consult/src/mcp/local.ts` | Six local lifecycle tools and stdio serving entry |
| `chatgpt-consult/src/mcp/chatgpt.ts` | Six ChatGPT request/context/completion tools |
| `chatgpt-consult/src/mcp/http.ts` | Bun HTTP mount, loopback bind, Host/Origin guards, health endpoint, shutdown |
| `chatgpt-consult/src/browser/chrome.ts` | Dedicated profile, Chrome ownership, launch, CDP discovery, and validation |
| `chatgpt-consult/src/browser/cdp.ts` | Typed minimal CDP calls used by browser classification and composer submission |
| `chatgpt-consult/src/browser/webview.ts` | Bun WebView attachment to the validated Chrome WebSocket |
| `chatgpt-consult/src/browser/agent-browser.ts` | Optional pinned-session fallback with restrictive action policy |
| `chatgpt-consult/src/browser/handoff.ts` | Manual handoff text, ChatGPT URL validation, open/resume/submit orchestration |
| `chatgpt-consult/tests/` | Unit, MCP integration, CLI, HTTP security, browser classifier, and E2E tests |
| `chatgpt-consult/docs/CHATGPT_SETUP.md` | Developer Mode, Secure MCP Tunnel, connector, Project, and manual setup runbook |
| `chatgpt-consult/docs/SECURITY.md` | Trust boundaries, exclusions, claims, CDP exposure, and incident cleanup |
| `chatgpt-consult/docs/ACCEPTANCE.md` | Authenticated browser/tunnel acceptance procedure and evidence template |
| `chatgpt-consult/plugins/chatgpt-consult/skills/chatgpt-consult/SKILL.md` | Cross-agent routing and bounded consultation workflow |
| `README.md` | Add the new top-level project to the workspace entry-point list |
| `plugins.json` | Single marketplace source-of-truth entry |
| `scripts/plugins.py` | Add the new Bun project to workspace project checks |

---

### Task 1: Bun Package and Versioned Domain Schemas

**Files:**
- Create: `chatgpt-consult/package.json`
- Create: `chatgpt-consult/tsconfig.json`
- Create: `chatgpt-consult/.gitignore`
- Create: `chatgpt-consult/bin/chatgpt-consult.ts`
- Create: `chatgpt-consult/src/core/schema.ts`
- Create: `chatgpt-consult/src/core/errors.ts`
- Create: `chatgpt-consult/src/cli/main.ts`
- Test: `chatgpt-consult/tests/schema.test.ts`

**Interfaces:**
- Produces: `CapabilityProfile`, `RequestState`, `ContextBudget`, `ContextManifest`, `ConsultationRequest`, `ConsultationCompletion`, `StoredCompletion`, `JsonEnvelope`, their Zod schemas, `ConsultError`, and `main(argv, deps)`.
- Produces: `LocalConfigSchema`, `HARD_BUDGET`, and `resolveBudget(overrides)` for bounded local customization.
- Produces: package scripts `test`, `typecheck`, and `check`; executable `chatgpt-consult`.

- [ ] **Step 1: Create the package shell and install only pinned dependencies**

Create `package.json` with this contract, then run the exact install command so `bun.lock` records the resolutions:

```json
{
  "name": "chatgpt-consult",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.4.0",
  "bin": { "chatgpt-consult": "./bin/chatgpt-consult.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "2.0.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "2.0.0",
    "@types/bun": "1.4.0",
    "typescript": "5.9.2"
  }
}
```

```bash
cd chatgpt-consult
bun install
```

Create a strict `tsconfig.json` using `ESNext`, `Bundler` resolution, `ES2024` and `DOM` libraries, `types: ["bun"]`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`. Ignore `node_modules/`, coverage, `dist/`, `.DS_Store`, and browser-smoke artifacts in the project `.gitignore`; do not ignore source fixtures.

- [ ] **Step 2: Write failing schema tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  CompletionSchema,
  DEFAULT_BUDGET,
  RequestSchema,
} from "../src/core/schema";

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

  test("requires a direct answer in a completion", () => {
    expect(() => CompletionSchema.parse({ summary: "short" })).toThrow();
  });
});
```

- [ ] **Step 3: Run the tests and verify the expected failure**

Run: `bun test tests/schema.test.ts`

Expected: FAIL because `src/core/schema.ts` does not exist.

- [ ] **Step 4: Implement schemas and stable errors**

Define schemas with Zod v4 and infer all exported TypeScript types from them. The request schema must include these exact fields:

```ts
export const CapabilityProfileSchema = z.enum(["lean", "research", "analysis", "connected"]);
export const RequestStateSchema = z.enum(["pending", "claimed", "completed", "cancelled", "expired"]);

export const ContextBudgetSchema = z.object({
  maxPaths: z.number().int().positive(),
  maxReadBytes: z.number().int().positive(),
  maxServedTextBytes: z.number().int().positive(),
  maxSearchHits: z.number().int().positive(),
  maxAttachmentBytes: z.number().int().positive(),
  maxAttachmentTotalBytes: z.number().int().positive(),
  maxCompletionBytes: z.number().int().positive(),
  expiresAfterMs: z.number().int().positive(),
});

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
```

`RequestSchema` must store `schemaVersion: 1`, `id`, `projectId`, `projectName`, `goal`, `profile`, `parentId`, `conversationUrl`, `state`, `revision`, timestamps, `claimHash`, `idempotencyKey`, `budget`, `servedTextBytes`, `servedSearchHits`, a context manifest, optional diff metadata, attachment descriptors, and sensitivity decisions. `CompletionSchema` must require `summary` and `answer`, with arrays for evidence, assumptions, risks, recommendations, and follow-up questions. `StoredCompletionSchema` wraps it with `source: "mcp" | "manual"`, canonical digest, and `completedAt`. Use `.strict()` on persisted and external schemas.

Also store `connectorAllowlist: string[]`. Define `LocalConfigSchema` with `schemaVersion: 1`, optional `chatgptProjectUrl`, optional `tunnelUrl`, `defaultProfile`, `connectorAllowlist`, and a partial `budget` override. Define `HARD_BUDGET` separately from `DEFAULT_BUDGET`; `resolveBudget` merges overrides and rejects any value over the corresponding hard ceiling. Tests must cover a valid downward override and a rejected over-ceiling override.

Implement `ConsultError` as:

```ts
export type ConsultErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "EXPIRED"
  | "FORBIDDEN_PATH" | "SENSITIVE_CONTENT" | "BUDGET_EXCEEDED"
  | "UNAVAILABLE" | "CORRUPT_STATE" | "INTERNAL";

export class ConsultError extends Error {
  constructor(
    public readonly code: ConsultErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ConsultError";
  }
}
```

The binary must be the following thin entry; it contains no command logic:

```ts
import { main } from "../src/cli/main";

process.exitCode = await main(process.argv.slice(2));
```

The initial `main` prints versioned help for an empty argument list and returns exit code `2` for unknown commands.

- [ ] **Step 5: Run schema tests and type checking**

Run: `bun test tests/schema.test.ts && bun run typecheck`

Expected: all schema tests PASS and TypeScript exits `0`.

- [ ] **Step 6: Commit the package and schema foundation**

```bash
git add chatgpt-consult/package.json chatgpt-consult/bun.lock chatgpt-consult/tsconfig.json chatgpt-consult/.gitignore chatgpt-consult/bin chatgpt-consult/src/core chatgpt-consult/src/cli/main.ts chatgpt-consult/tests/schema.test.ts
git commit -m "feat(chatgpt-consult): add Bun domain foundation"
```

---

### Task 2: Immutable Project Boundary and Sensitive-Content Policy

**Files:**
- Create: `chatgpt-consult/src/security/project.ts`
- Create: `chatgpt-consult/src/security/policy.ts`
- Create: `chatgpt-consult/src/security/secrets.ts`
- Test: `chatgpt-consult/tests/security.test.ts`

**Interfaces:**
- Produces: `resolveProject(root): Promise<ResolvedProject>`.
- Produces: `resolveReadablePath(project, relativePath): Promise<ResolvedPath>`.
- Produces: `classifyPath(relativePath): PathDecision` and `scanSecrets(text): SecretScan`.
- `ResolvedProject` is consumed by every store, context, CLI, MCP, and browser task.

- [ ] **Step 1: Write failing path-confinement and secret-policy tests**

Use `mkdtemp` and create `project/src/app.ts`, `outside.txt`, a symlink from `project/link` to `outside.txt`, `.env`, and `node_modules/pkg/index.js`. Assert:

```ts
const project = await resolveProject(root);
expect((await resolveReadablePath(project, "src/app.ts")).relative).toBe("src/app.ts");
await expect(resolveReadablePath(project, "../outside.txt")).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
await expect(resolveReadablePath(project, "link")).rejects.toMatchObject({ code: "FORBIDDEN_PATH" });
expect(classifyPath(".env.local").kind).toBe("deny");
expect(classifyPath("node_modules/pkg/index.js").kind).toBe("deny");
expect(scanSecrets("-----BEGIN PRIVATE KEY-----").decision).toBe("block");
expect(scanSecrets("password = example-value").decision).toBe("confirm");
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test tests/security.test.ts`

Expected: FAIL because the security modules do not exist.

- [ ] **Step 3: Implement root and readable-path resolution**

`resolveProject` must `realpath` the supplied root, require a directory, derive a local `stateDir = join(root, ".chatgpt-consult")`, and derive `projectId = sha256(root + "\0" + basename(root)).slice(0, 24)`. `resolveReadablePath` must:

```ts
if (relativePath.includes("\0") || isAbsolute(relativePath)) forbidden();
const normalized = normalize(relativePath).replaceAll("\\", "/");
if (normalized === ".." || normalized.startsWith("../")) forbidden();
const real = await realpath(join(project.root, normalized));
const rel = relative(project.root, real).replaceAll("\\", "/");
if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) forbidden();
const stat = await lstat(real);
if (!stat.isFile()) throw new ConsultError("INVALID_INPUT", "Context path is not a regular file");
```

Return only the canonical absolute path to trusted local code; ChatGPT-visible records contain `relative`, size, digest, and MIME metadata, never the root.

- [ ] **Step 4: Implement deterministic path exclusions and secret screening**

Deny these path components: `.git`, `.chatgpt-consult`, `node_modules`, `.pnpm-store`, `.bun`, `dist`, `build`, `coverage`, `.next`, `.cache`, browser profile names, and any component beginning with `.env`. Deny credential filenames and extensions: `id_rsa`, `id_ed25519`, `credentials`, `.pem`, `.key`, `.p12`, `.pfx`, `.kdbx`.

High-confidence block patterns must cover PEM private keys and provider tokens with distinctive prefixes. Confirmation findings must cover assignment-like `password`, `secret`, `token`, and `api_key` values. Return only finding kind, line number, and redacted preview; cap findings at 20 and never return the matched value.

- [ ] **Step 5: Run the security suite**

Run: `bun test tests/security.test.ts && bun run typecheck`

Expected: PASS, including traversal and symlink escape tests.

- [ ] **Step 6: Commit the boundary**

```bash
git add chatgpt-consult/src/security chatgpt-consult/tests/security.test.ts
git commit -m "feat(chatgpt-consult): confine project context"
```

---

### Task 3: Atomic Request Store, Claims, and Lifecycle

**Files:**
- Create: `chatgpt-consult/src/core/store.ts`
- Test: `chatgpt-consult/tests/store.test.ts`

**Interfaces:**
- Consumes: `ResolvedProject`, `RequestSchema`, `CompletionSchema`, and `ConsultError`.
- Produces: `RequestStore.create`, `get`, `claim`, `authorize`, `consumeTextBudget`, `consumeSearchHits`, `complete`, `completeLocal`, `cancel`, `rotateClaim`, `getCompletion`, and `listRecent`.
- Produces: `CreatedRequest { request, claimToken }`; raw claim tokens never appear in persisted request or event records.

- [ ] **Step 1: Write failing lifecycle tests with injected time and randomness**

Build a temporary project and store with `now: () => fixedTime` and `randomBytes: () => fixedBytes`. Test this sequence:

```ts
const created = await store.create(validCreateInput);
expect(created.request.state).toBe("pending");
expect(JSON.stringify(await store.get(created.request.id))).not.toContain(created.claimToken);

const claimed = await store.claim(created.request.id, created.claimToken);
expect(claimed).toMatchObject({ state: "claimed", revision: 1 });

const completion = validCompletion({ answer: "Use the queue." });
const done = await store.complete(created.request.id, created.claimToken, 1, completion);
expect(done.request).toMatchObject({ state: "completed", revision: 2 });

expect(await store.complete(created.request.id, created.claimToken, 1, completion))
  .toEqual(done);
await expect(store.complete(created.request.id, created.claimToken, 1,
  validCompletion({ answer: "Different" })))
  .rejects.toMatchObject({ code: "CONFLICT" });
```

Add cases for idempotent create, bad claim, cancellation, late completion, expiry, rotation, concurrent completion, malformed JSON, and cumulative text budget overflow.

- [ ] **Step 2: Run store tests and verify failure**

Run: `bun test tests/store.test.ts`

Expected: FAIL because `RequestStore` is missing.

- [ ] **Step 3: Implement private layout, locking, and atomic writes**

`RequestStore.init()` must create `requests`, `results`, `attachments`, `events`, and `locks` with mode `0700`. Reject a symlinked state directory. Use an exclusive lock directory per request with a bounded 2-second retry window and 25 ms backoff. Under the lock, write JSON to a same-directory random temporary filename, flush and close it, then rename it over the destination. Always remove the lock directory in `finally`.

Events are one-line JSON objects containing timestamp, request ID, event name, state, revision, and safe metadata. Never write goal text, file content, completion content, conversation query strings, claim tokens, or claim hashes to events.

- [ ] **Step 4: Implement claims and state transitions**

Generate a 32-byte base64url claim and store `sha256(claim)` only. Compare hashes with `timingSafeEqual`. `claim` accepts repeated valid claims, changes `pending -> claimed`, and increments revision once. `rotateClaim` is allowed for pending requests; claimed requests require an explicit `allowClaimed` boolean. Expiry is checked before every authorized operation and persists `expired` once.

`consumeTextBudget` and `consumeSearchHits` update counters under the request lock without changing the lifecycle revision; this keeps the claim revision stable across selective reads while preventing concurrent budget overspend. `complete` must validate completion byte size before locking. An identical repeated completion, determined by canonical JSON digest, returns the stored result. A different completion after success returns `CONFLICT`. `completeLocal` applies the same transition under local authority and records source `manual`. `cancel` is idempotent for cancelled requests and conflicts with completed requests.

- [ ] **Step 5: Run lifecycle and concurrency tests**

Run: `bun test tests/store.test.ts && bun run typecheck`

Expected: PASS; the concurrency case produces exactly one stored completion and no partial JSON.

- [ ] **Step 6: Commit the request store**

```bash
git add chatgpt-consult/src/core/store.ts chatgpt-consult/tests/store.test.ts
git commit -m "feat(chatgpt-consult): add atomic consultation lifecycle"
```

---

### Task 4: Bounded Context, Diffs, Search, and Attachments

**Files:**
- Create: `chatgpt-consult/src/context/selection.ts`
- Create: `chatgpt-consult/src/context/search.ts`
- Create: `chatgpt-consult/src/context/diff.ts`
- Create: `chatgpt-consult/src/context/attachments.ts`
- Test: `chatgpt-consult/tests/context.test.ts`
- Test: `chatgpt-consult/tests/attachments.test.ts`

**Interfaces:**
- Consumes: project boundary, security policy, secret scanner, store attachment directory, and request budgets.
- Produces: `ContextService.build`, `read`, `search`, `captureDiff`, `readDiff`, `storeAttachments`, and `readAttachment`.
- Produces manifest entries with `path`, `bytes`, `sha256`, `mimeType`, `selectionReason`, and sensitivity metadata.

- [ ] **Step 1: Write failing explicit and smart-selection tests**

In a temporary Git repository, create `src/server.ts`, `src/server.test.ts`, `src/unrelated.ts`, `.env`, and a working-tree change. Assert:

```ts
const explicit = await context.build({
  goal: "Review server timeout handling",
  files: ["src/server.ts"],
  smart: false,
  allowSensitive: false,
});
expect(explicit.entries.map(x => x.path)).toEqual(["src/server.ts"]);

const smart = await context.build({
  goal: "Review server timeout handling",
  files: [],
  smart: true,
  allowSensitive: false,
});
expect(smart.entries.map(x => x.path)).toContain("src/server.ts");
expect(smart.entries.map(x => x.path)).not.toContain(".env");
expect(smart.entries).toHaveLength(Math.min(smart.entries.length, 25));
```

Repeat smart selection twice and require identical path order and reasons. Add tests for a directory selector, a glob, path-count overflow, a secret block, a confirmation finding, bounded reads with continuation, capped search hits, working/staged diffs, an escaped symlink, allowed PNG, denied HTML/SVG, per-file attachment overflow, total overflow, and SHA-256 deduplication.

- [ ] **Step 2: Run context tests and verify failure**

Run: `bun test tests/context.test.ts tests/attachments.test.ts`

Expected: FAIL because the context modules are missing.

- [ ] **Step 3: Implement deterministic selection and bounded retrieval**

Expand explicit files, directories, and Bun globs into normalized relative files, sort them bytewise, apply exclusions, resolve every real path, scan text, then enforce `maxPaths`.

Smart selection must build candidates from:

1. paths literally mentioned in the goal;
2. `git status --porcelain=v1 -z` and `git diff --name-only -z` using fixed argv;
3. bounded `rg -l --fixed-strings` queries for meaningful goal terms when `rg` exists; and
4. a Bun file walk fallback when `rg` is absent.

Score exact mentioned paths `100`, changed paths `80`, stem matches `50`, lexical matches `20`, and adjacent `*.test.*` or `*.spec.*` files `10`. Sort by descending score then relative path. Record every score source in `selectionReason`; never use an LLM.

`read` must authorize the request, require an approved manifest path, cap `limit` to `maxReadBytes`, align UTF-8 safely, update cumulative served bytes atomically, and return `{ path, offset, nextOffset, eof, text, sha256 }`. `search` searches approved text paths only and returns at most the remaining `maxSearchHits` with line number and a snippet capped at 240 characters.

- [ ] **Step 4: Implement fixed-argv diff and immutable attachments**

For `working`, spawn `git diff --no-ext-diff --no-color -- .` and `git diff --cached --no-ext-diff --no-color -- .` without a shell, label the two sections, and cap stored bytes. A non-Git project returns `INVALID_INPUT`, not an empty success.

Inject a MIME detector for tests. Production uses `file -b --mime-type -- <path>` resolved through `Bun.which("file")`. Allow safe raster images, PDF, plain text, JSON, common audio, and common video. Deny HTML, SVG, JavaScript presented as an attachment, executables, archives, and unknown binary types. Copy via a temporary file, hash while reading, verify size and digest, then rename to `attachments/<sha256>` with mode `0600`.

- [ ] **Step 5: Run all context tests**

Run: `bun test tests/context.test.ts tests/attachments.test.ts && bun run typecheck`

Expected: PASS, including deterministic selection and byte ceilings.

- [ ] **Step 6: Commit bounded context**

```bash
git add chatgpt-consult/src/context chatgpt-consult/tests/context.test.ts chatgpt-consult/tests/attachments.test.ts
git commit -m "feat(chatgpt-consult): add bounded project context"
```

---

### Task 5: Consultation Service and CLI Protocol

**Files:**
- Create: `chatgpt-consult/src/core/service.ts`
- Create: `chatgpt-consult/src/cli/args.ts`
- Create: `chatgpt-consult/src/cli/render.ts`
- Modify: `chatgpt-consult/src/cli/main.ts`
- Test: `chatgpt-consult/tests/service.test.ts`
- Test: `chatgpt-consult/tests/cli.test.ts`

**Interfaces:**
- Consumes: `RequestStore`, `ContextService`, project root, and schemas.
- Produces: `ConsultationService.start`, `status`, `show`, `followup`, `cancel`, `publish`, `rotateHandoff`, `manualBundle`, `importManualCompletion`, and `listRecent`.
- Produces: `BrowserLauncher.open(handoff): Promise<BrowserOutcome>` injection point; this task uses a manual-only implementation.
- Produces: CLI commands `init`, `start`, `status`, `show`, `followup`, `cancel`, `publish`, `open`, `handoff`, `import-result`, and `list`.

- [ ] **Step 1: Write failing service tests**

Assert that `start` creates the manifest before the request, emits a compact handoff, and does not block:

```ts
const result = await service.start({
  goal: "Should retries live in the queue?",
  profile: "lean",
  files: ["src/queue.ts"],
  smart: false,
  attachments: [],
  diff: "none",
  open: false,
});
expect(result).toMatchObject({ state: "pending" });
expect(result.handoff).toContain(result.requestId);
expect(result.handoff).toContain(result.claimToken);
expect(result.handoff.length).toBeLessThan(1_000);
```

Add tests that follow-up links `parentId` and inherits the prior profile unless overridden, publish writes `docs/consultations/YYYY-MM-DD-<slug>.md`, publish refuses overwrite, `open` rotates a pending claim, cancellation is idempotent, and `init` preserves existing `.gitignore` content while adding exactly one `.chatgpt-consult/` line. `init --chatgpt-project-url <url>` must create a strict private `config.local.json`; a rerun preserves user fields and validates budget ceilings.

Add a no-tunnel fallback test: `manualBundle` produces a self-contained prompt capped at 64 KiB with the goal, response JSON schema, approved text excerpts, bounded diff excerpt, and attachment names; `importManualCompletion` validates and stores JSON copied from ChatGPT without requiring the raw claim token. The bundle remains under `.chatgpt-consult/` and is never published automatically.

- [ ] **Step 2: Write failing CLI process tests**

Spawn the binary in a temporary project and assert:

```ts
const run = Bun.spawnSync([
  "bun", absoluteBin,
  "start", "Review the queue", "--file", "src/queue.ts", "--json",
], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
const payload = JSON.parse(run.stdout.toString());
expect(run.exitCode).toBe(0);
expect(payload).toMatchObject({ schemaVersion: 1, ok: true, data: { state: "pending" } });
expect(run.stderr.toString()).not.toContain(payload.data.claimToken);
```

Cover invalid options, missing goal, human status output, JSON errors, and no ANSI codes in JSON mode.

- [ ] **Step 3: Run service and CLI tests and verify failure**

Run: `bun test tests/service.test.ts tests/cli.test.ts`

Expected: FAIL because the service and parser do not exist.

- [ ] **Step 4: Implement the service and manual handoff**

Use these public signatures:

```ts
export interface BrowserLauncher {
  open(input: { requestId: string; claimToken: string; conversationUrl?: string }): Promise<BrowserOutcome>;
}

export class ConsultationService {
  start(input: StartInput): Promise<StartResult>;
  status(id: string): Promise<StatusResult>;
  show(id: string): Promise<ShowResult>;
  followup(input: FollowupInput): Promise<StartResult>;
  cancel(id: string): Promise<StatusResult>;
  publish(id: string, output?: string): Promise<{ path: string }>;
  rotateHandoff(id: string, allowClaimed?: boolean): Promise<HandoffResult>;
  manualBundle(id: string): Promise<{ path: string; text: string }>;
  importManualCompletion(id: string, completion: unknown): Promise<StatusResult>;
  listRecent(limit?: number): Promise<ConsultationSummary[]>;
}
```

The handoff text must say: `Use the ChatGPT Consult MCP tools. Call request_get with request_id "<id>" and claim_token "<token>", selectively inspect context, then call request_complete.` Do not include file content or the project root.

Render publication with title, date, request ID, goal, summary, answer, evidence, assumptions, risks, recommendations, and follow-ups. Escape unsafe Markdown control text in the generated title and slug. Manual import is local authority: it may claim a pending request and complete it under the request lock, records `completionSource: "manual"`, and follows the same size, schema, conflict, cancellation, and expiry rules as MCP completion.

- [ ] **Step 5: Implement dependency-free argument parsing and output**

Support repeated `--file`, `--attachment`, and `--connector`; `--profile`, `--smart`, `--diff working|none`, `--open`, `--json`, `--output`, `--input`, `--limit`, `--idempotency-key`, `--chatgpt-project-url`, and `--allow-sensitive`. Reject unknown flags and duplicate scalar flags. Reject `--connector` unless the selected profile is `connected`, then persist its normalized allowlist for ChatGPT to compare with actual Project configuration. Pass an optional idempotency key unchanged to the service after length and character validation. Use exit codes `0` success, `2` invalid input, `3` not found, `4` conflict/expired, and `1` unavailable/internal.

The JSON envelope is always `{ schemaVersion: 1, ok: boolean, data?: unknown, error?: { code, message, details } }`. Human output prints the request ID, state, next action, and paths but omits claim tokens unless displaying a newly created manual handoff.

- [ ] **Step 6: Run service, CLI, and full project tests**

Run: `bun test tests/service.test.ts tests/cli.test.ts && bun run typecheck && bun test`

Expected: PASS.

- [ ] **Step 7: Commit the local product surface**

```bash
git add chatgpt-consult/src/core/service.ts chatgpt-consult/src/cli chatgpt-consult/tests/service.test.ts chatgpt-consult/tests/cli.test.ts
git commit -m "feat(chatgpt-consult): add consultation CLI"
```

---

### Task 6: Local Stdio MCP Surface

**Files:**
- Create: `chatgpt-consult/src/mcp/results.ts`
- Create: `chatgpt-consult/src/mcp/local.ts`
- Modify: `chatgpt-consult/src/cli/main.ts`
- Test: `chatgpt-consult/tests/local-mcp.test.ts`
- Test: `chatgpt-consult/tests/stdio-mcp.test.ts`

**Interfaces:**
- Consumes: `ConsultationService`.
- Produces: `createLocalMcp(service): McpServer` and `serveLocalStdio(factory): Promise<void>`.
- Produces exactly six tools: `consult_start`, `consult_status`, `consult_show`, `consult_followup`, `consult_cancel`, `consult_publish`.

- [ ] **Step 1: Write an in-memory MCP contract test**

Use `Client` and `InMemoryTransport` from `@modelcontextprotocol/client`:

```ts
const server = createLocalMcp(service);
const client = new Client({ name: "test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const listed = await client.listTools();
expect(listed.tools.map(tool => tool.name)).toEqual([
  "consult_start", "consult_status", "consult_show",
  "consult_followup", "consult_cancel", "consult_publish",
]);
const started = await client.callTool({
  name: "consult_start",
  arguments: { goal: "Review queue policy", files: ["src/queue.ts"], profile: "lean" },
});
expect(started.isError).not.toBe(true);
expect(started.structuredContent).toMatchObject({ state: "pending" });
```

Assert `readOnlyHint` for status/show, `destructiveHint: false` for cancel, and `readOnlyHint: false` for publish. Assert validation failures return `isError: true` with a compact safe text block and structured error.

- [ ] **Step 2: Write a real stdio spawn test**

Connect `StdioClientTransport` from `@modelcontextprotocol/client/stdio` to:

```ts
new StdioClientTransport({
  command: "bun",
  args: [absoluteBin, "serve", "local"],
  cwd: temporaryProject,
});
```

List tools, call `consult_start`, close the client, and assert stderr contains no protocol JSON or claim token.

- [ ] **Step 3: Run MCP tests and verify failure**

Run: `bun test tests/local-mcp.test.ts tests/stdio-mcp.test.ts`

Expected: FAIL because the MCP server is missing.

- [ ] **Step 4: Implement the six tools with v2 SDK imports**

Import `McpServer` from `@modelcontextprotocol/server`, `serveStdio` from `@modelcontextprotocol/server/stdio`, and `z` from `zod/v4`. Register one focused schema per tool. Every successful result contains both:

```ts
{
  content: [{ type: "text", text: conciseHumanSummary }],
  structuredContent: serviceResult,
}
```

Map `ConsultError` to `isError: true`; do not throw domain errors across MCP. Define an `outputSchema` for every tool's `structuredContent` so text and structured results cannot drift. Server instructions must fit within 512 leading characters and state that consultation is asynchronous, status must be polled, and publishing requires explicit user intent.

- [ ] **Step 5: Wire `serve local` and keep stdout protocol-clean**

Resolve the project from `process.cwd()` once before creating the service. Start stdio with a server factory and send only startup diagnostics to stderr. `serve local` must not accept a path-switching tool argument.

- [ ] **Step 6: Run stdio and project checks**

Run: `bun test tests/local-mcp.test.ts tests/stdio-mcp.test.ts && bun run check`

Expected: PASS.

- [ ] **Step 7: Commit the local MCP surface**

```bash
git add chatgpt-consult/src/mcp chatgpt-consult/src/cli/main.ts chatgpt-consult/tests/local-mcp.test.ts chatgpt-consult/tests/stdio-mcp.test.ts
git commit -m "feat(chatgpt-consult): expose local MCP tools"
```

---

### Task 7: ChatGPT Context and Completion MCP Surface

**Files:**
- Create: `chatgpt-consult/src/mcp/chatgpt.ts`
- Test: `chatgpt-consult/tests/chatgpt-mcp.test.ts`

**Interfaces:**
- Consumes: `RequestStore`, `ContextService`, attachment conversion, and completion schema.
- Produces: `createChatgptMcp(deps): McpServer`.
- Produces exactly six tools: `request_get`, `context_search`, `context_read`, `diff_get`, `attachment_get`, `request_complete`.

- [ ] **Step 1: Write the ChatGPT MCP contract test**

Create a real pending request through the service, then drive the ChatGPT server with a linked client. Assert the exact tool list and this lifecycle:

```ts
const claimed = await client.callTool({
  name: "request_get",
  arguments: { request_id: requestId, claim_token: claimToken },
});
expect(claimed.structuredContent).toMatchObject({
  request: { state: "claimed", goal: "Review queue policy", projectName: "fixture" },
});
expect(JSON.stringify(claimed.structuredContent)).not.toContain(projectRoot);

const read = await client.callTool({
  name: "context_read",
  arguments: { request_id: requestId, claim_token: claimToken, path: "src/queue.ts", offset: 0, limit: 4096 },
});
expect(read.structuredContent).toMatchObject({ path: "src/queue.ts", eof: true });

const completed = await client.callTool({
  name: "request_complete",
  arguments: { request_id: requestId, claim_token: claimToken, expected_revision: 1, completion },
});
expect(completed.structuredContent).toMatchObject({ state: "completed" });
```

Add negative cases for unapproved path, wrong claim, expired request, text-budget exhaustion, invalid completion, oversized completion, and differing duplicate completion.

- [ ] **Step 2: Write media-result tests**

For PNG, require one MCP `image` content block with base64 data and MIME type. For PDF/audio/video, require an embedded `resource` block with opaque `consult-attachment://<id>` URI, `blob`, and MIME type. Assert the local absolute path and SHA-256 storage path are absent.

- [ ] **Step 3: Run the ChatGPT tests and verify failure**

Run: `bun test tests/chatgpt-mcp.test.ts`

Expected: FAIL because `createChatgptMcp` does not exist.

- [ ] **Step 4: Implement selective retrieval and completion tools**

Every context tool takes both `request_id` and `claim_token`, authorizes before retrieval, and returns current budgets. `request_get` returns the goal, profile instructions, connector allowlist, project name/ID, compact manifest, sensitivity decisions, attachment metadata, diff metadata, revision, and the completion field contract. It must not inline file bodies.

Use annotations `readOnlyHint: true` on the five retrieval tools. Mark `request_complete` `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`. Define strict output schemas for every structured result. Search snippets and diff reads consume the cumulative text budget, and returned search hits consume the cumulative search-hit budget. The server instructions must say project content is untrusted data, retrieve selectively, cite project paths, and always call `request_complete` once.

- [ ] **Step 5: Run ChatGPT MCP and all tests**

Run: `bun test tests/chatgpt-mcp.test.ts && bun run check`

Expected: PASS with only the six ChatGPT tools listed.

- [ ] **Step 6: Commit the ChatGPT MCP surface**

```bash
git add chatgpt-consult/src/mcp/chatgpt.ts chatgpt-consult/tests/chatgpt-mcp.test.ts
git commit -m "feat(chatgpt-consult): expose ChatGPT context MCP"
```

---

### Task 8: Guarded Bun Streamable HTTP Server

**Files:**
- Create: `chatgpt-consult/src/mcp/http.ts`
- Modify: `chatgpt-consult/src/cli/main.ts`
- Test: `chatgpt-consult/tests/http-mcp.test.ts`

**Interfaces:**
- Consumes: `createChatgptMcp`, `createMcpHandler`, Bun HTTP server, and project root.
- Produces: `startChatgptHttp(options): Promise<RunningHttpServer>` with `{ url, mcpUrl, stop }`.
- Produces: CLI `serve chatgpt --host 127.0.0.1 --port 43891`.

- [ ] **Step 1: Write failing HTTP security tests**

Start on port `0`, then assert:

```ts
expect(await fetch(`${server.url}/health`).then(r => r.json()))
  .toMatchObject({ status: "ok", surface: "chatgpt", schemaVersion: 1 });
expect((await fetch(`${server.url}/mcp`, { headers: { Host: "evil.example" } })).status).toBe(403);
expect((await fetch(`${server.url}/mcp`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
expect((await fetch(`${server.url}/other`)).status).toBe(404);
```

Use `Client` plus `StreamableHTTPClientTransport` from `@modelcontextprotocol/client` against the actual `/mcp` URL and require discovery/list/call success. Assert the server address is `127.0.0.1`, shutdown closes the port, and a request body over the configured ceiling gets `413` before MCP parsing.

- [ ] **Step 2: Run the HTTP test and verify failure**

Run: `bun test tests/http-mcp.test.ts`

Expected: FAIL because the HTTP mount is missing.

- [ ] **Step 3: Implement the Bun-native guarded handler**

Use current SDK v2 imports:

```ts
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
```

Create the handler with `createMcpHandler(() => createChatgptMcp(deps), { responseMode: "json" })`. For `/mcp`, apply:

```ts
const rejected =
  hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
  originValidationResponse(request, localhostAllowedOrigins());
return rejected ?? handler.fetch(request);
```

Mount with `Bun.serve({ hostname: "127.0.0.1", port, fetch })`. Reject any non-loopback hostname option. Allow `GET /health`; return `404` everywhere except `/health` and `/mcp`. Bound `Content-Length` before parsing and rely on the SDK for `Content-Type` and protocol validation. Close both Bun server and MCP handler on shutdown.

- [ ] **Step 4: Wire the CLI and process signals**

`serve chatgpt` resolves one explicit `--root` or defaults to startup cwd, prints the health and MCP URLs to stderr, and waits. Handle `SIGINT` and `SIGTERM` once, stop cleanly, and return `0`. The tool surface still requires per-request ID and claim capability; the loopback tunnel process is the only network peer.

- [ ] **Step 5: Run HTTP, MCP, and complete package checks**

Run: `bun test tests/http-mcp.test.ts tests/chatgpt-mcp.test.ts && bun run check`

Expected: PASS, including Host/Origin rejection.

- [ ] **Step 6: Commit Streamable HTTP**

```bash
git add chatgpt-consult/src/mcp/http.ts chatgpt-consult/src/cli/main.ts chatgpt-consult/tests/http-mcp.test.ts
git commit -m "feat(chatgpt-consult): serve guarded HTTP MCP"
```

---

### Task 9: Dedicated Chrome and Loopback CDP Ownership

**Files:**
- Create: `chatgpt-consult/src/browser/cdp.ts`
- Create: `chatgpt-consult/src/browser/chrome.ts`
- Test: `chatgpt-consult/tests/chrome.test.ts`

**Interfaces:**
- Produces: `ChromeController.ensureRunning(): Promise<ChromeSession>` and `closeOwned()`.
- Produces: `ChromeSession { pid, port, webSocketUrl, profileDir, ownership, reused }`.
- Consumes no ChatGPT DOM behavior; this task owns only safe browser lifecycle and endpoint validation.

- [ ] **Step 1: Write classifier-first tests with injected observations**

Define an injected adapter for filesystem, process, listener, and HTTP observations. Cover:

```ts
expect(classifyChrome(cleanObservation)).toEqual({ kind: "launch" });
expect(classifyChrome(healthyOwnedObservation)).toMatchObject({ kind: "reuse", pid: 123 });
expect(classifyChrome(foreignListenerObservation)).toMatchObject({ kind: "refuse", code: "FOREIGN_LISTENER" });
expect(classifyChrome(wrongProfileObservation)).toMatchObject({ kind: "refuse", code: "PROFILE_CONFLICT" });
expect(classifyChrome(nonLoopbackWsObservation)).toMatchObject({ kind: "refuse", code: "UNSAFE_ENDPOINT" });
```

Add cases for symlinked profile, wrong owner, permissive profile repair, stale ownership file, malformed `DevToolsActivePort`, timeout, and concurrent launch lock.

- [ ] **Step 2: Run browser classifier tests and verify failure**

Run: `bun test tests/chrome.test.ts`

Expected: FAIL because browser modules are missing.

- [ ] **Step 3: Implement profile and process ownership**

Resolve config root from `CHATGPT_CONSULT_CONFIG_HOME`, then `XDG_CONFIG_HOME/chatgpt-consult`, then `$HOME/.config/chatgpt-consult`. Never repurpose `HOME`. Create `chrome-profile` with mode `0700`; reject a symlink or wrong owner. Store an ownership record outside the profile containing schema version, PID, resolved Chrome executable, profile path, launch nonce, and start time.

Find Chrome through configured path, `BUN_CHROME_PATH`, standard macOS application path, then `Bun.which`. Launch without a shell:

```ts
const child = Bun.spawn([
  chromePath,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
], { stdout: "ignore", stderr: "pipe" });
```

Use a per-user launch lock. Never kill or modify a process that cannot be proven to match the ownership record, executable, profile argument, and endpoint.

- [ ] **Step 4: Implement CDP readiness and loopback validation**

Poll `DevToolsActivePort` for at most 10 seconds at 200 ms intervals. Parse the port and WebSocket path, require port `1..65535`, fetch `http://127.0.0.1:<port>/json/version`, and require its `webSocketDebuggerUrl` to use `ws`, loopback host, matching port, and `/devtools/browser/` path. Validate the owned PID still runs with the expected executable and `--user-data-dir` argument before returning success.

`closeOwned` sends `SIGTERM` only to the exact still-validated owned PID, waits two seconds, then reports failure rather than sending `SIGKILL` to an uncertain process.

- [ ] **Step 5: Run Chrome tests and type checking**

Run: `bun test tests/chrome.test.ts && bun run typecheck`

Expected: PASS across every refusal state.

- [ ] **Step 6: Commit safe Chrome ownership**

```bash
git add chatgpt-consult/src/browser/cdp.ts chatgpt-consult/src/browser/chrome.ts chatgpt-consult/tests/chrome.test.ts
git commit -m "feat(chatgpt-consult): manage dedicated Chrome safely"
```

---

### Task 10: Bun WebView, agent-browser Fallback, and ChatGPT Handoff

**Files:**
- Create: `chatgpt-consult/src/browser/webview.ts`
- Create: `chatgpt-consult/src/browser/agent-browser.ts`
- Create: `chatgpt-consult/src/browser/handoff.ts`
- Modify: `chatgpt-consult/src/core/service.ts`
- Modify: `chatgpt-consult/src/cli/main.ts`
- Test: `chatgpt-consult/tests/handoff.test.ts`
- Test: `chatgpt-consult/tests/browser-smoke.test.ts`

**Interfaces:**
- Consumes: `ChromeSession`, `BrowserLauncher`, claim rotation, and configured ChatGPT Project URL.
- Produces: `WebViewSubmitter.submit`, `AgentBrowserSubmitter.submit`, and `ChatgptBrowserLauncher.open`.
- Produces outcomes `submitted`, `opened_manual`, and `manual_required`, always including handoff text on non-submission.

- [ ] **Step 1: Write URL and fallback tests with fake submitters**

Require only HTTPS ChatGPT/OpenAI hosts configured in the local allowlist; reject credentials, fragments carrying claims, non-default ports, `javascript:`, and lookalike domains. Test the chain:

```ts
const outcome = await launcher.open(handoff);
expect(primary.calls).toBe(1);
expect(fallback.calls).toBe(1);
expect(outcome).toMatchObject({ kind: "manual_required", requestId: handoff.requestId });
expect(outcome.handoff).toContain(handoff.claimToken);
```

Add cases where WebView succeeds, where agent-browser succeeds, where the configured conversation URL is preferred over the Project URL, where a pending open rotates the claim, and where no configured Project URL still returns a complete manual handoff.

- [ ] **Step 2: Run handoff tests and verify failure**

Run: `bun test tests/handoff.test.ts`

Expected: FAIL because the browser submitters are missing.

- [ ] **Step 3: Implement Bun WebView attachment and CDP composer submission**

Feature-detect `Bun.WebView`; return `UNAVAILABLE` without throwing at module load when absent. Attach to the already-running browser:

```ts
const view = new Bun.WebView({
  backend: { type: "chrome", url: session.webSocketUrl },
  url: targetUrl,
});
```

Do not pass `dataStore.directory`; the one owned Chrome process already owns the profile. Use raw CDP, not page JavaScript, to enable DOM/Page, locate `[data-testid="prompt-textarea"]`, `#prompt-textarea`, or a visible editable textarea, focus it, insert the exact handoff with `Input.insertText`, and dispatch Enter. Read the current URL through `Page.getFrameTree`, never by extracting response content. Bound the operation to 15 seconds and close only the created view/tab.

- [ ] **Step 4: Implement the constrained agent-browser adapter**

Write a generated local action policy outside the repository:

```json
{
  "default": "deny",
  "allow": ["navigate", "snapshot", "click", "fill", "wait", "get"],
  "deny": ["eval", "download", "upload", "network", "state"]
}
```

Run fixed argv with `--session chatgpt-consult`, `--cdp <port>`, `--pin-tab`, `--content-boundaries`, `--max-output 12000`, and `--action-policy <path>`. Do not pass `--allowed-domains`: agent-browser explicitly rejects it with CDP attach mode. The wrapper validates every navigation URL before invocation, takes one bounded interactive snapshot to locate the composer, fills/submits only that element, reads only the final URL, and never requests page text containing the answer.

- [ ] **Step 5: Wire `--open`, `open`, and follow-up resume**

`start --open` calls the browser after persistence; failure never rolls back the request. `open <id>` rotates a pending claim and submits it. `followup --open` prefers the parent result's validated conversation URL. When submission observes a new ChatGPT conversation URL, persist it after removing query and fragment secrets; only `https://chatgpt.com/` paths are accepted for resumption.

- [ ] **Step 6: Add an opt-in disposable browser smoke test**

Skip unless `CHATGPT_CONSULT_BROWSER_SMOKE=1`. Use a temporary profile and alternate dynamic CDP port, verify Bun WebView and agent-browser attach to the same browser PID, open `about:blank` and a safe local fixture, and never require ChatGPT login. Do not run it in the default `bun test` process unless the environment flag is set.

- [ ] **Step 7: Run browser unit tests and the default package suite**

Run: `bun test tests/handoff.test.ts tests/browser-smoke.test.ts && bun run check`

Expected: unit tests PASS and browser smoke reports SKIP without the opt-in environment variable.

- [ ] **Step 8: Commit browser convenience**

```bash
git add chatgpt-consult/src/browser chatgpt-consult/src/core/service.ts chatgpt-consult/src/cli/main.ts chatgpt-consult/tests/handoff.test.ts chatgpt-consult/tests/browser-smoke.test.ts
git commit -m "feat(chatgpt-consult): add shared ChatGPT browser handoff"
```

---

### Task 11: Setup and Redacted Doctor

**Files:**
- Create: `chatgpt-consult/src/cli/setup.ts`
- Create: `chatgpt-consult/src/cli/doctor.ts`
- Modify: `chatgpt-consult/src/cli/args.ts`
- Modify: `chatgpt-consult/src/cli/main.ts`
- Test: `chatgpt-consult/tests/setup.test.ts`
- Test: `chatgpt-consult/tests/doctor.test.ts`

**Interfaces:**
- Produces: CLI `setup clients [--apply] [--replace]`, `setup chatgpt`, and `doctor [--json]`.
- Consumes: resolved absolute binary path, local client CLIs, HTTP health, Chrome controller diagnostics, and agent-browser version.

- [ ] **Step 1: Write setup preview/apply tests with an injected command runner**

Assert preview mode makes no mutation and returns these argument arrays with the actual resolved binary substituted:

```ts
["codex", "mcp", "add", "chatgpt-consult", "--", "bun", "run", absoluteBin, "serve", "local"]
["claude", "mcp", "add", "--scope", "user", "chatgpt-consult", "--", "bun", "run", absoluteBin, "serve", "local"]
```

If `codex mcp get chatgpt-consult` or `claude mcp get chatgpt-consult` reports an identical command, mark it current. If it differs, preview the mismatch and require `--replace`; replacement removes only the named server immediately before re-adding it. Missing CLIs are reported as skipped, not silently successful.

- [ ] **Step 2: Write doctor tests for independent probe states**

Inject probe results and assert JSON includes one of `pass`, `warn`, `fail`, or `skip` for Bun, project, ignore rule, state permissions, stdio MCP, HTTP MCP, tunnel guidance, Chrome, CDP, WebView, agent-browser, ChatGPT Project URL, and browser login. A warning must not make the command fail; any required `fail` yields exit `1`. Scan serialized output and require it not to contain seeded claim tokens, cookies, or absolute attachment paths.

- [ ] **Step 3: Run setup and doctor tests and verify failure**

Run: `bun test tests/setup.test.ts tests/doctor.test.ts`

Expected: FAIL because setup and doctor do not exist.

- [ ] **Step 4: Implement explicit setup behavior**

Use `Bun.spawn` with argv arrays and no shell. Default `setup clients` prints a preview. Only `--apply` mutates. Never edit `~/.codex/config.toml` or Claude configuration directly; use the installed CLIs. Resolve the source binary through `realpath(import.meta.dir + "/../../bin/chatgpt-consult.ts")` so machine paths stay local.

`setup chatgpt` prints the loopback MCP URL, health check command, approved Secure MCP Tunnel documentation URL, Developer Mode connector steps, required tool names, Project setup, and the `handoff <id>` plus `import-result <id> --input <file>` manual fallback commands. It does not open account settings or claim that tunnel availability is guaranteed.

- [ ] **Step 5: Implement bounded diagnostic probes**

Every subprocess probe has a 5-second timeout; network health has a 2-second timeout. When `tunnelUrl` is configured, probe its MCP reachability without logging the URL query; otherwise report tunnel status as guidance rather than success. Browser login is best-effort and may report `warn`. `doctor --json` emits the stable envelope; human output is a compact table plus corrective commands. Redact authorization headers, claim-like strings, query strings, and any path below the Chrome profile.

- [ ] **Step 6: Run the setup, doctor, and full package checks**

Run: `bun test tests/setup.test.ts tests/doctor.test.ts && bun run check`

Expected: PASS.

- [ ] **Step 7: Commit setup and diagnostics**

```bash
git add chatgpt-consult/src/cli chatgpt-consult/tests/setup.test.ts chatgpt-consult/tests/doctor.test.ts
git commit -m "feat(chatgpt-consult): add setup and diagnostics"
```

---

### Task 12: Workspace Plugin, Catalog, and Documentation

**Files:**
- Create: `chatgpt-consult/README.md`
- Create: `chatgpt-consult/docs/CHATGPT_SETUP.md`
- Create: `chatgpt-consult/docs/SECURITY.md`
- Create: `chatgpt-consult/docs/ACCEPTANCE.md`
- Create: `chatgpt-consult/plugins/chatgpt-consult/skills/chatgpt-consult/SKILL.md`
- Create: generated `chatgpt-consult/plugins/chatgpt-consult/.claude-plugin/plugin.json`
- Create: generated `chatgpt-consult/plugins/chatgpt-consult/.codex-plugin/plugin.json`
- Modify: `plugins.json`
- Modify: `README.md`
- Modify: `scripts/plugins.py`
- Modify: generated `.claude-plugin/marketplace.json`
- Modify: generated `.agents/plugins/marketplace.json`
- Test: `chatgpt-consult/tests/skill.test.ts`
- Test: `tests/test_plugins.py`

**Interfaces:**
- Consumes: complete CLI/MCP/browser behavior.
- Produces: installed skill trigger and one-marketplace integration.
- Produces: workspace `python3 scripts/plugins.py check` coverage for `chatgpt-consult` via `bun run check`.

- [ ] **Step 1: Invoke the required plugin and skill authoring skills and inspect their instructions**

Use `plugin-creator`, `skill-creator`, and `superpowers:writing-skills` before adding the plugin directory and skill. Follow the repository's stronger local rule: `plugins.json` is the source of truth and generated manifests must come from `python3 scripts/plugins.py sync`.

- [ ] **Step 2: Write failing skill behavior tests**

Read the future `SKILL.md` and assert its frontmatter name, a trigger description between 80 and 1200 characters, all six local MCP tool names, the phrase `ChatGPT web`, explicit-user-consent language, asynchronous polling, manual fallback, and explicit publishing. Assert it does not contain `OpenAI API key`, `unlimited`, DOM scraping instructions, an absolute checkout path, or a command that publishes without user request.

Run: `bun test tests/skill.test.ts`

Expected: FAIL because the skill does not exist.

- [ ] **Step 3: Create the skill and catalog entry**

The skill triggers when the user says `consult ChatGPT`, `ask ChatGPT web`, `use my ChatGPT Project`, requests a second opinion from ChatGPT, or asks to continue a ChatGPT consultation. It does not auto-trigger for ordinary questions merely mentioning ChatGPT.

Its workflow is: choose bounded files/profile, call `consult_start`, report pending/manual state, poll only when the user wants to wait, use `consult_followup` for the same topic, and call `consult_publish` only on an explicit save/publish request. If MCP tools are absent, direct the user to `chatgpt-consult setup clients` and the project README.

Add `chatgpt-consult/` to the top-level projects in `README.md`. Append this catalog shape at version `1.0.0`:

```json
{
  "name": "chatgpt-consult",
  "displayName": "ChatGPT Consult",
  "source": "./chatgpt-consult/plugins/chatgpt-consult",
  "version": "1.0.0",
  "description": "Bounded project consultations through ChatGPT web, with local MCP context, structured results, and explicit publishing.",
  "category": "Productivity",
  "keywords": ["chatgpt", "consultation", "mcp", "second-opinion", "project-context"],
  "license": "MIT",
  "codex": {
    "shortDescription": "Consult ChatGPT web with bounded project context.",
    "longDescription": "Creates project-scoped consultation requests, hands them to ChatGPT web through a safe MCP bridge, retrieves structured results, and publishes only when explicitly requested.",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": [
      "Consult ChatGPT web about this decision using only the files I name.",
      "Ask my ChatGPT Project to review this diff and report the result.",
      "Continue the last ChatGPT consultation with this follow-up."
    ]
  }
}
```

- [ ] **Step 4: Add the project suite to workspace validation and generate manifests**

Add `("chatgpt-consult", ["bun", "run", "check"])` to `PROJECT_CHECKS` in `scripts/plugins.py`. Run:

```bash
python3 scripts/plugins.py sync
```

Review the generated marketplace and plugin manifests; do not edit them.

- [ ] **Step 5: Write user, setup, security, and acceptance documentation**

`README.md` must contain: supported architecture, prerequisites, install, `init`, CLI examples, local MCP setup, ChatGPT connector setup link, browser profile behavior, private versus curated storage, follow-ups, standalone `handoff`/`import-result`, troubleshooting, tests, and clear ChatGPT-plan/API separation.

`CHATGPT_SETUP.md` must provide exact UI-independent steps: start `serve chatgpt`, verify `/health`, configure Secure MCP Tunnel from the official guide, enable ChatGPT Developer Mode where available, connect `/mcp`, verify the six tools, create/select a ChatGPT Project, run a manual request, then enable browser convenience.

`SECURITY.md` must list the filesystem, MCP, claim, tunnel, content-injection, browser/CDP, plugin, logging, and cleanup boundaries. `ACCEPTANCE.md` must provide a checkbox evidence template for files, working diff, PNG, completion, follow-up, publish, forbidden path, secret, browser fallback, and cleanup.

- [ ] **Step 6: Run plugin and workspace checks**

Run:

```bash
bun test tests/skill.test.ts
python3 -m unittest tests/test_plugins.py
python3 scripts/plugins.py check
```

Expected: all commands PASS and the check reports four plugins plus the new project suite.

- [ ] **Step 7: Commit workspace integration**

```bash
git add README.md chatgpt-consult/README.md chatgpt-consult/docs chatgpt-consult/plugins chatgpt-consult/tests/skill.test.ts plugins.json scripts/plugins.py .claude-plugin/marketplace.json .agents/plugins/marketplace.json
git commit -m "feat(chatgpt-consult): integrate workspace plugin"
```

---

### Task 13: End-to-End Protocol, Failure Matrix, and Installation Verification

**Files:**
- Create: `chatgpt-consult/tests/e2e.test.ts`
- Create: `chatgpt-consult/tests/fixtures/project/src/queue.ts`
- Create: `chatgpt-consult/tests/fixtures/project/src/queue.test.ts`
- Modify: `chatgpt-consult/package.json`
- Modify: `chatgpt-consult/docs/ACCEPTANCE.md` only when recording real observed results

**Interfaces:**
- Consumes: every completed component.
- Produces: one automated no-account E2E gate and one documented authenticated manual gate.

- [ ] **Step 1: Write the failing no-account E2E test**

The test must copy the fixture to a temporary Git repository, initialize private state, create a working diff and PNG attachment, start the real HTTP server, then drive the full ChatGPT tool sequence with `StreamableHTTPClientTransport`:

```ts
const started = await localService.start({
  goal: "Decide whether queue retries need jitter",
  profile: "analysis",
  files: ["src/queue.ts"],
  smart: true,
  diff: "working",
  attachments: [pngPath],
  open: false,
});

await chatgpt.callTool({ name: "request_get", arguments: claimArgs(started) });
await chatgpt.callTool({ name: "context_search", arguments: { ...claimArgs(started), query: "retry" } });
await chatgpt.callTool({ name: "context_read", arguments: { ...claimArgs(started), path: "src/queue.ts", offset: 0, limit: 4096 } });
await chatgpt.callTool({ name: "diff_get", arguments: { ...claimArgs(started), offset: 0, limit: 8192 } });
await chatgpt.callTool({ name: "attachment_get", arguments: { ...claimArgs(started), attachment_id: started.attachments[0].id } });
await chatgpt.callTool({ name: "request_complete", arguments: { ...claimArgs(started), expected_revision: 1, completion } });

expect((await localService.show(started.requestId)).completion?.answer).toContain("jitter");
expect((await localService.publish(started.requestId)).path).toMatch(/docs\/consultations\//);
```

Continue with a follow-up linked to the first request and verify the parent ID and stored conversation URL behavior.

- [ ] **Step 2: Add the complete negative matrix to the E2E test**

In isolated test cases require failures for: `../` traversal, escaped symlink, `.env`, PEM key, 26th selected path, oversized text read, 51st search hit, oversized attachment, denied SVG/HTML, wrong claim, expired claim, cancelled completion, conflicting duplicate completion, foreign Host, foreign Origin, and disconnected browser. For a missing tunnel, generate a standalone bundle, import a schema-valid manual result, and prove the request completes without a browser or MCP connection. Assert no rejected case creates a curated document.

- [ ] **Step 3: Run E2E and fix only failures within the approved contracts**

Run: `bun test tests/e2e.test.ts`

Expected: PASS. If a failure reveals a design-contract conflict, stop and amend the approved spec before changing behavior.

- [ ] **Step 4: Make the package check include E2E and verify the clean package**

Set `check` to:

```json
"check": "bun run typecheck && bun test"
```

Run:

```bash
cd chatgpt-consult
bun run check
git status --short
```

Expected: all tests PASS; only intended tracked changes and the pre-existing root `download.html` appear.

- [ ] **Step 5: Run the authenticated manual acceptance gate**

Follow `docs/ACCEPTANCE.md` with the user's ChatGPT Project and account:

1. start the guarded loopback HTTP MCP;
2. connect it through Secure MCP Tunnel;
3. verify exactly six ChatGPT tools;
4. submit one bounded analysis request containing source, diff, and PNG;
5. confirm ChatGPT calls `request_complete` and the CLI retrieves the result;
6. submit a follow-up into the same conversation;
7. publish the curated Markdown;
8. disable browser automation and prove the manual handoff still completes; and
9. record only dates, versions, pass/fail, request IDs, and safe observations in the acceptance document.

Do not record chat contents, claims, cookies, tunnel credentials, absolute profile paths, or private source text.

- [ ] **Step 6: Synchronize, validate, force-refresh, and verify live plugin state**

From the workspace root run:

```bash
python3 scripts/plugins.py sync
python3 scripts/plugins.py check
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

Expected: catalog/manifests are current, every project suite passes, `chatgpt-consult@ai-workspace` is installed and enabled for available agents, and live-cache status has no drift.

- [ ] **Step 7: Run final verification from a fresh shell**

From the workspace root, run:

```bash
cd chatgpt-consult
bun run check
bun run bin/chatgpt-consult.ts doctor --json
cd ..
python3 scripts/plugins.py check
git diff --check
git status --short
```

Expected: test and workspace checks PASS; doctor contains no required failure for the configured path; diff check is clean; `download.html` remains untouched.

- [ ] **Step 8: Commit the verified E2E gate and acceptance evidence**

```bash
git add chatgpt-consult/package.json chatgpt-consult/tests/e2e.test.ts chatgpt-consult/tests/fixtures chatgpt-consult/docs/ACCEPTANCE.md
git commit -m "test(chatgpt-consult): verify end-to-end consultation flow"
```

- [ ] **Step 9: Invoke the required completion and branch-finishing skills**

Use `superpowers:verification-before-completion` to re-check the fresh evidence, then `superpowers:requesting-code-review` for an independent review. After findings are resolved and verification is rerun, use `superpowers:finishing-a-development-branch` to present integration choices. Do not merge, push, or delete the worktree without the user's explicit choice.

## Plan Completion Definition

The plan is complete only when all thirteen task commits exist, the authenticated acceptance result is recorded without sensitive content, the local and ChatGPT MCP surfaces expose exactly their specified six tools, `bun run check` and `python3 scripts/plugins.py check` pass from a fresh shell, live plugin status has no drift, and the user has received the branch-integration choices.

## Implementation References

- [MCP TypeScript SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [MCP Streamable HTTP on web-standard runtimes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)
- [MCP SDK testing guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md)
- [OpenAI: build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI: connect MCP to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Bun WebView](https://bun.com/docs/runtime/webview)
- [agent-browser security controls](https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/security/page.mdx)
