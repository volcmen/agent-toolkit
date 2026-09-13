# Browser-Backed Local MCP Design

**Date:** 2026-08-31
**Status:** Approved design, pending implementation plan

## Summary

ChatGPT Consult will use the user's authenticated ChatGPT web subscription
through `agent-browser`. Codex and Claude will continue to call the existing
local MCP tools. ChatGPT itself will not connect to a local or remote MCP
server, so the default workflow needs no OpenAI API key, Secure MCP Tunnel,
public HTTPS endpoint, or ChatGPT Developer Mode connector.

Routine consultations will be fully automatic. The system will create a
bounded request, submit it in the configured ChatGPT Project, wait for the
answer, validate it, and import it into private local state. A headed browser
and the existing manual handoff/import workflow will remain recovery paths.

## Goals

- Let Codex and Claude consult the user's signed-in ChatGPT web account through
  the stable local MCP interface.
- Complete routine consultation, response collection, validation, and import
  without user interaction.
- Use a dedicated persistent browser profile, opening it headed only for login,
  2FA, CAPTCHA, consent, or manual recovery.
- Keep every new consultation inside the configured ChatGPT Project.
- Reuse one ChatGPT conversation for all follow-ups in a consultation thread.
- Preserve bounded context, explicit attachment selection, local privacy, and
  explicit publication.
- Avoid duplicate prompts and duplicate chats when a browser action has an
  uncertain outcome.

## Non-goals

- Calling OpenAI model APIs or consuming API credits.
- Making the local MCP endpoint reachable from ChatGPT or the public internet.
- Automating CAPTCHA, 2FA, login credentials, connector authorization, or
  other account-security challenges.
- Providing a general-purpose browser-control MCP server.
- Automatically publishing, committing, messaging, or executing instructions
  contained in a ChatGPT response.
- Removing the existing ChatGPT-facing MCP implementation in this slice. It
  remains loopback-only compatibility code, is not started automatically, and
  is removed from the default setup and acceptance path.

## Selected Approach

The browser adapter will remain an internal component of `chatgpt-consult`:

```text
Codex or Claude
      |
      | local MCP
      v
ChatGPT Consult service and request store
      |
      | bounded browser job
      v
agent-browser -> dedicated Chrome profile -> configured ChatGPT Project
```

This approach reuses the existing local MCP tools, request state machine,
context selection, attachment controls, completion schema, and publication
boundary. A separate browser MCP would add a process and security boundary
without improving this use case. A ChatGPT-facing remote MCP would reintroduce
public reachability and tunnel authentication, contrary to the no-key design.

## External Contract

The local MCP tool names and their user-facing roles remain unchanged:

- `consult_start` creates a bounded consultation and optionally starts browser
  execution.
- `consult_status` reports asynchronous progress or a recovery state.
- `consult_show` returns a validated completed result.
- `consult_followup` creates a child request and reuses the parent conversation.
- `consult_cancel` stops pending browser work without deleting its record.
- `consult_publish` writes curated output only after explicit user approval.

Starting a consultation with browser execution enabled remains asynchronous.
Submission success alone no longer counts as consultation completion. The
request reaches `completed` only after a response passes local validation and
is imported atomically.

The CLI will expose `chatgpt-consult setup browser` to open the dedicated
profile headed for initial login and `chatgpt-consult open <request-id>` to
resume a recoverable request. Users will not manipulate browser profiles or CDP
ports directly.

## Components

### 1. Browser session manager

The session manager owns browser availability, not credentials. It will:

- Reuse an explicitly configured, healthy Chrome CDP endpoint when present.
- Otherwise launch or reconnect to a dedicated persistent profile managed by
  ChatGPT Consult.
- Launch the managed profile headless for routine jobs. An explicitly
  configured CDP session retains the visibility mode chosen by its owner.
- Reopen the same managed profile headed when login or human recovery is
  required.
- Return a typed recovery state instead of reading cookies, passwords, tokens,
  or browser storage.

It must never copy or directly reuse the user's ordinary Chrome profile. An
existing CDP session is used only when the user explicitly configured it.
Before switching an automation-owned managed profile from headless to headed,
the controller closes and verifies termination of its own headless process so
Chrome never opens the profile concurrently.

### 2. Browser job coordinator

The coordinator turns one stored request into one idempotent browser job. It
records phase transitions before actions whose result could be ambiguous:

1. Resolve and validate the configured ChatGPT Project URL.
2. Prepare the immutable prompt and allowlisted staged attachments.
3. Open the parent conversation for a follow-up, or the Project's new-chat
   surface for a root request.
4. Verify the active ChatGPT origin and expected project/conversation context.
5. Upload only the staged files for this request.
6. Fill and submit the prompt once.
7. Capture and persist the resulting canonical conversation URL.
8. Wait for a stable assistant response.
9. Pass the extracted response to the completion importer.

The coordinator is the only component allowed to advance a browser-backed
request. A per-request lock prevents concurrent workers from submitting the
same request.

### 3. Worker lifetime and lease

Both the local MCP server and the CLI may initiate a consultation, so browser
execution cannot depend on the initiating command remaining connected. A
browser-enabled start persists the request first and then launches one bounded
Bun worker from the same verified checkout. The start call returns after the
worker has acquired its request lease; `consult_status` remains a passive read.

The private request store records a renewable worker lease and browser phase,
not merely a process ID. A worker may act only while it owns an unexpired lease.
If it exits, the lease eventually expires and `chatgpt-consult open
<request-id>` may acquire a new lease and resume from the last proven phase.
Cancellation changes durable request state; workers check that state between
browser operations and release automation-owned resources before exiting.
Process identifiers are never trusted without the existing ownership checks.

### 4. Prompt and attachment packager

The browser prompt replaces the current instruction to call ChatGPT-facing MCP
tools. It contains the consultation goal, profile, bounded textual context,
diff when selected, attachment manifest, response requirements, and an opaque
request identifier. It does not contain the former remote-MCP claim token.

Text remains subject to existing context budgets. Attachments remain opt-in,
immutable after selection, size checked, and staged under private ignored
project state. Upload permission is scoped to the resolved staged paths for the
active request rather than granted globally.

The requested answer format will use a small, explicit envelope with sentinel
markers and the request identifier. ChatGPT may include prose inside the
envelope, but it cannot select local paths or change the completion state.

### 5. Response collector

The collector uses bounded `agent-browser` navigation, accessibility snapshots,
element interaction, waits, and text reads. It does not use arbitrary page
evaluation. It will:

- Detect login, CAPTCHA, consent, and unexpected-interaction screens.
- Identify exactly one active composer before submission.
- Detect the response associated with the submitted prompt.
- Wait for generation controls to disappear and for the final response to be
  unchanged across consecutive observations.
- Enforce response size and elapsed-time ceilings.
- Return the canonical conversation URL and extracted envelope.

Selectors will prefer accessible roles and names. ChatGPT UI changes that make
the target ambiguous produce `ui_changed` or `needs_manual`; the collector does
not guess or click unrelated controls.

### 6. Completion importer

The importer extends the existing manual import boundary and remains the sole
authority for completion. It verifies:

- The envelope and completion schema.
- Exact request identifier and current request state.
- Maximum answer and metadata sizes.
- Valid canonical ChatGPT conversation URL.
- Absence of claim material or unsupported state transitions.

Validated results are written atomically to private state with a browser source
marker. Malformed, mismatched, oversized, or suspicious results do not become
completed consultations.

## Conversation and Follow-up Semantics

A root request creates no more than one new conversation in the configured
ChatGPT Project. The captured canonical URL is persisted on the request thread.
A follow-up must navigate to that URL and add one message to the same chat.

If the parent has no proven conversation URL, the follow-up does not silently
start another chat. It enters manual recovery or asks the caller to start a new
root consultation explicitly. Status polling and process retries never create
messages.

The automation does not rename, archive, or delete ChatGPT chats. Keeping one
conversation per consultation thread is the mechanism for limiting Project
noise.

## State Model

Existing durable request states remain authoritative. Each request gains a
persisted `browserExecution` record containing a phase, sanitized reason code,
attempt number, renewable lease, submission certainty, and any validated
conversation URL. Browser UI is never the source of truth.

The browser phase is one of `queued`, `preparing`, `awaiting_browser`,
`awaiting_response`, `needs_login`, `needs_manual`, `completed`, `cancelled`,
or `expired`.

Recovery and failure reasons are the closed set `browser_unavailable`,
`ui_changed`, `upload_failed`, `timed_out`, and `invalid_response`, plus login
and manual-intervention reasons. The submission-certainty value is one of
`not_submitted`, `submitted`, or `uncertain`. Local status rendering and MCP
structured output expose these fields without exposing private prompt data.

## Idempotency and Recovery

Before prompt submission, a failed step may be retried within a bounded retry
budget. Once submission is attempted, the worker must persist enough evidence
to distinguish these outcomes:

- submission definitely did not occur;
- submission occurred and has a known conversation URL;
- outcome is uncertain.

Only the first outcome permits automatic resubmission. The second resumes
collection from the recorded conversation. The uncertain outcome switches to
`needs_manual` to prevent duplicate prompts or chats.

Manual recovery opens the same managed profile and known conversation when
possible. The existing `handoff` and `import-result` commands remain available;
manual imports pass through the same completion validator. Cancellation stops
the active worker and closes only automation-owned resources. It preserves the
profile, request record, and any known conversation URL.

## Browser Security Policy

The default policy remains deny-by-default. It permits only the operations
needed for this flow: open/navigate, inspect accessibility state, interact with
unambiguous controls, fill, press, wait, read bounded visible text, and upload
the request's allowlisted staged files.

The following remain prohibited:

- arbitrary JavaScript or script injection;
- cookie, local-storage, credential, or token extraction;
- downloads and arbitrary filesystem access;
- network interception, request capture, or routing changes;
- navigation outside canonical `https://chatgpt.com` URLs;
- following links or acting on instructions contained in ChatGPT output;
- authorizing connectors, plugins, purchases, publication, or external actions.

The configured Project URL and captured conversation URLs are canonicalized
with the existing strict URL rules. Browser output is bounded before parsing.
Public errors and logs omit prompts, attachment contents, claim material, and
sensitive absolute paths. Screenshots are not captured by default.

## Authentication Experience

Authentication is a browser concern, not an API credential flow. When the
managed profile is not signed in, the system returns `needs_login` and opens
the same profile headed. The browser worker watches for a valid ChatGPT Project
page for up to 15 minutes and resumes the request automatically after login. If
that window expires or the worker exits, the user runs
`chatgpt-consult open <request-id>` to resume the same request. The user signs
in directly on ChatGPT and completes any account challenge.

No code reads the entered credentials. A CAPTCHA or consent page is never
bypassed. Routine jobs reuse the resulting persistent session until ChatGPT
requires authentication again.

## Legacy Remote MCP Boundary

`serve chatgpt`, its six ChatGPT-facing tools, and Secure MCP Tunnel support are
not used by the browser-backed flow. They remain loopback-only and opt-in during
this implementation slice to avoid combining a transport migration with a
destructive compatibility removal. Default documentation, setup, doctor output,
and acceptance testing will describe the local-MCP-plus-browser path.

The implementation must not start the remote server or tunnel as a side effect.
Removing the legacy boundary can be considered after browser-backed acceptance
passes and is a separate compatibility decision.

## Testing Strategy

### Unit tests

- Session selection and explicit-CDP validation.
- ChatGPT Project and conversation URL canonicalization.
- Prompt bounds, sentinel parsing, and request-ID matching.
- Attachment staging, immutable-source checks, allowlisted upload paths, MIME
  and size ceilings.
- Stable-response detection and output/time ceilings.
- Typed recovery classification and public-error redaction.
- Completion schema and atomic import behavior.

### Simulated browser tests

A deterministic command runner will cover:

- authenticated root consultation and successful import;
- `needs_login`, CAPTCHA/consent, changed UI, unavailable browser, timeout,
  failed upload, malformed response, and cancellation;
- known submission resumed from its conversation URL;
- uncertain submission refusing automatic resubmission;
- follow-up reuse of the parent conversation;
- rejection of foreign navigation, multiple composers, non-allowlisted upload,
  oversized output, and mismatched request IDs.

### Regression and workspace validation

- Run the full Bun test/check suite.
- Run `python3 scripts/plugins.py check` after project/plugin changes.
- Force-refresh the pinned plugin cache with
  `python3 scripts/plugins.py install --force`, then verify
  `python3 scripts/plugins.py status`.
- Verify Codex and Claude discover the unchanged six local consultation tools.

### Authenticated acceptance

Using the dedicated headed profile when login is required:

1. Start only the local MCP integration; do not start a tunnel or public server.
2. Run one small automatic consultation in the configured ChatGPT Project.
3. Confirm the result is automatically collected, validated, and shown locally.
4. Send a follow-up and confirm it appears in the same conversation.
5. Run one bounded, non-sensitive file attachment consultation.
6. Exercise a manual recovery/import path.
7. Publish only after an explicit command and verify the output separately.
8. Confirm no OpenAI API key was configured or consumed, no public listener was
   created, and no tunnel process ran.

If account authentication is required during acceptance, the user completes it
in headed Chrome; this is an expected recovery step, not a failed test.

## Documentation Changes

The README, ChatGPT setup guide, security model, acceptance guide, CLI help, and
installed skill will be updated so that:

- local MCP plus `agent-browser` is the primary and recommended workflow;
- headed login and automatic resumption are explained;
- the browser automation limitations and manual fallback are explicit;
- no step asks for an OpenAI API key or Secure MCP Tunnel;
- legacy remote MCP instructions are clearly optional rather than required;
- economical `lean` consultation and explicit context remain the defaults.

## Completion Criteria

The change is complete when all automated tests and workspace checks pass and
an authenticated acceptance run demonstrates automatic root consultation,
automatic result import, same-chat follow-up, bounded file upload, manual
fallback, and explicit publication without an API key, public endpoint, or
tunnel. No completion claim may be made solely from simulated browser tests.
