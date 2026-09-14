# Browser-backed acceptance

Use this checklist for a no-key end-to-end verification with the account owner.
The live steps create bounded test conversations in the configured ChatGPT
Project. Authentication, 2FA, CAPTCHA, and consent are completed only in the
headed browser.

## Automated prerequisites

- [x] `python3 bun-global-tools/sync.py check --deep` verifies Bun-owned
      `agent-browser` 0.35.1 and its `~/.bun/bin` command path.
- [x] `bun run check` passes; only explicitly opt-in live tests are skipped.
- [x] `python3 scripts/plugins.py check` passes from `main`.
- [x] `chatgpt-consult doctor --json` reports the browser-backed required
      checks without requiring a tunnel.
- [x] The local MCP still exposes exactly `consult_start`, `consult_status`,
      `consult_show`, `consult_followup`, `consult_cancel`, and
      `consult_publish`.

## Authenticated browser lifecycle

- [ ] `chatgpt-consult setup browser` opens only the configured ChatGPT Project
      in the dedicated headed profile.
- [x] A lean root request with explicit non-sensitive context and `--open`
      reaches `completed`; status is polled rather than treated as synchronous.
- [x] `chatgpt-consult show <id>` returns a browser-sourced validated result.
- [x] One follow-up with `--open` completes in the same canonical conversation.
- [ ] A `chat_mode: new` follow-up completes in a different conversation
      inside the same Project with a bounded parent summary.
- [ ] One small explicitly approved attachment is uploaded from bounded private
      staging and completes.
- [ ] A separate request exercises `handoff` plus `import-result` without
      bypassing completion validation.
- [ ] No curated output exists before explicit `chatgpt-consult publish <id>`;
      publication creates only the requested temporary output.
- [ ] Login recovery uses `needs_login`; UI or uncertain-submission recovery
      uses `needs_manual` and does not create a duplicate prompt or chat.

## Negative evidence

- [x] The live acceptance process has `OPENAI_API_KEY`, `OPENAI_ORG_ID`, and
      `OPENAI_PROJECT_ID` removed from its environment.
- [x] No process listens on legacy port 43891, and no tunnel client runs.
- [x] `serve chatgpt`, connector authorization, Developer Mode, and Secure MCP
      Tunnel are not invoked by the browser-backed test.
- [x] No private config, request state, browser profile, attachment staging, or
      transcript is committed.

Record only pass/fail, timestamps, sanitized request IDs, and phase/source
names. Never capture account cookies, credentials, full claims, browser-profile
data, private source, or raw consultation transcripts.

## Parallel verification

Run the real browser lifecycle with synthetic context:

```bash
CHATGPT_CONSULT_BROWSER_ACCEPTANCE=1 bun test tests/browser-live.test.ts --timeout 3000000
```

It starts two independent local MCP clients against the same signed-in Chrome,
requires distinct completed conversations, then checks a same-conversation
follow-up, attachment, and fresh-chat follow-up. Every returned conversation
must belong to the configured Project. It also validates local manual import
and temporary publication. No new login profile or credentials are created.

`tests/browser-concurrency.test.ts` forces interleaved navigation, submission,
cancellation, diagnostics and authentication probes in a shared daemon
namespace. The installed agent-browser also namespaces daemons by the private
temporary home, so a fixed session name alone is not proof of a live collision.
The explicit attempt session ID makes isolation independent of that behavior.

The optional disposable transport smoke test exercises the production CDP
page client and agent-browser against a temporary Chrome. On macOS it uses a
mock Keychain solely for the disposable test profile, plus short temporary
paths that fit Unix socket limits. Normal consultations retain the existing
Chrome profile and Keychain. See the upstream [tab pinning contract](https://agent-browser.dev/cdp-mode)
and [Chromium test launch guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md).

For local diagnosis of synthetic acceptance failures only, setting
`CHATGPT_CONSULT_BROWSER_KEEP=1` retains the temporary request fixture. It is
off by default; remove retained fixtures after inspecting them.

## Legacy/optional compatibility

Testing `serve chatgpt`, its loopback health endpoint, a Secure MCP Tunnel, or
ChatGPT Developer Mode is a separate compatibility exercise. None is a
prerequisite for browser-backed acceptance, and none is started automatically.

## Response delivery record — 2026-09-14

- Three previously answered Claude Code consultations had failed with
  `invalid_response`. Their saved response envelopes contained literal citation
  line breaks inside JSON strings; one also contained two formulas with
  unescaped quotation marks. The existing authenticated Project chats worked.
- Two existing answers were collected from their original conversations with
  the corrected parser. The remaining answer was recovered through validated
  manual import after escaping the two formula literals. All three are now
  completed, with their browser/manual provenance preserved and exactly one
  submission event each. No original request was resent.
- A fresh local stdio MCP client using Claude Code's configured launch command
  retrieved all three full results. Text and structured completions matched
  exactly. Private requests and answer contents remain outside this repository.
- Regression coverage exercises citation whitespace, fenced payloads, quoted
  code, invalid identities and revisions, malformed envelopes, polling and
  event collection, collection without submission, and delivery through MCP.
  All 312 affected tests pass; independent review reports no findings.
- A separate synthetic attachment check stopped with `submission_uncertain`
  and was cancelled without a resend. Attachment acceptance remains pending.
- A subsequent text-only format check reached `rate_limited` and was cancelled
  without a resend. Live testing stopped and the shared cooldown was retained.
  The new prompt's fenced rendering has regression coverage but remains
  unverified against a newly generated live response. No login was requested.
- The complete workspace gate passed on `main`, including all project suites.
  Both agents' installed plugins were refreshed and content status verified.

## Acceptance record — 2026-09-13

- Shared authentication and independent parallel roots: **PASS**. Separate
  local MCP clients completed requests `58745a1978f024a406bdd3d30c4f7ed4`
  and `c3236839f649d1fe42a606f4ad631b50` in distinct conversations using the
  existing Chrome session. No additional login was required.
- Same-conversation follow-up: **PASS before the final submission-proof
  changes**, request `97bf15aa1da70a2e2c6ff2fbc2db1ef0`. A later attempt showed
  that full prompt text comparisons reject ChatGPT's Markdown rendering;
  the final implementation checks the stable request ID/revision header.
- Attachment lifecycle: **NOT YET VERIFIED AFTER THE FIX**. Request
  `c3c664b3c2b6ca955a39024ab8d87025` was marked submitted without a posted user
  message and eventually timed out. The implementation now targets the
  general-file upload input, waits for Send readiness, clicks Send, and
  verifies a follow-up's posted request header. Local regression tests cover
  delayed uploads, missing messages, Markdown rendering, and no duplicate send.
- Full live rerun: **STOPPED** after the user reported ChatGPT's “Too many
  requests” conversation-access warning. Both active synthetic requests were
  cancelled and their worker leases released. Repeated live tests may have
  contributed. Do not infer that the account limit has cleared from local test
  results; the complete attachment/manual/publication sequence remains pending.
- Rate-limit recovery: **LOCAL TESTS PASS**. The warning becomes `rate_limited`,
  and independent workers using the same configuration and CDP port share a
  five-minute cooldown before opening further tabs. Blocked reads do not
  extend it. The policy does not guarantee the website will recover in five
  minutes and does not authenticate, reload, or resend automatically.
- Project organization and fresh chats: **LOCAL TESTS PASS; LIVE RERUN PENDING**.
  Configuration requires a Project URL and new repository configuration
  preserves the shared Chrome setting. Requests retain their Project binding;
  ordinary or foreign conversation URLs cannot be continued automatically.
  `auto` rolls over after six recorded exchanges, `new` deliberately starts
  fresh, and `continue` overrides the threshold. Fresh chats carry a bounded
  parent summary, not its full answer or old file payloads. Regression tests
  cover sibling counting, idempotent routing, configuration changes, two MCP
  clients creating fresh chats, and worker recovery in the new conversation.
  No additional live consultations were sent after the rate-limit warning.
- Disposable browser transport: **PASS**, using the production CDP page client
  and agent-browser. The smoke-only mock Keychain avoids the macOS prompt;
  the normal Chrome profile and Keychain are retained.
- Concurrency regression: **PASS** for interleaved roots, cancellation of one
  while another completes, concurrent diagnostics, and authentication probes.
  Mutation back to a fixed session name fails all four shared-namespace cases;
  this is robustness coverage, not proof that the old name alone caused the
  user's live problem.
- Independent pre-push review found six defects, corrected with local
  regression coverage: event-collector rate-limit detection, rollover while
  the final exchange is active, retries of legacy requests without thread
  metadata, JSON-escaped submission-proof transport limits, replacement of
  obsolete configured URLs, and CLI cooldown guidance. Rate limits during
  uncertain submission confirmation also pause peers without clearing
  uncertainty or permitting another send. CI now installs the frozen Consult
  dependencies with the required Bun 1.4.0. The final independent review reports
  no remaining findings; its affected test run passes all 351 tests.
- Local project gate: **PASS**, typecheck plus 1,061 tests, two opt-in skips.
  Skill validation, plugin refresh/status for both agents, and whitespace
  validation also pass.
- Workspace validation in the main development checkout: the catalog,
  workspace, wiki, codex-pair, and
  ChatGPT Consult checks pass. Two unrelated existing `claude-core` tests fail,
  including its always-on context byte budget. No unrelated workspace edits
  were changed.
- Scoped push branch validation: **PASS**. The branch contains Consult and its
  unpublished prerequisites on the remote main baseline. The catalog,
  workspace, wiki, codex-pair, ChatGPT Consult, and shared-agents
  checks all pass. Its Consult implementation matches the reviewed checkout.

## Acceptance record — 2026-09-01

- Automated local protocol, lifecycle, and security coverage: **PASS**. The
  deterministic test uses the six real local MCP tools and covers a browser
  root request, same-conversation follow-up, image attachment, cancellation,
  and explicit-only publication. The live test is opt-in and skipped by
  default.
- Live process isolation: **PASS**. All nine bounded invocations removed the
  three API credential variables. No legacy listener, tunnel, remote MCP,
  connector authorization, Developer Mode, or real-workspace publication was
  used.
- Authenticated browser-backed lifecycle: **PARTIAL / EXTERNAL UI BLOCKER**.
  Observed request phases were `needs_manual` and `completed`; one root request
  completed with source `browser`, and its validated result was shown. Three
  attempts reached submission. A complete root, same-chat follow-up,
  attachment, manual fallback, and publication sequence did not finish in one
  invocation.
- Final bounded attempt: **FAIL CLOSED BEFORE SUBMISSION** with
  `ui_changed` / `not_submitted`. A proven fresh pinned tab reached the
  authenticated configured Project, but the settled page exposed neither a
  recognized composer nor the scoped Project new-chat control. The exact
  request-owned target was closed afterward; ambiguous pre-existing tabs were
  not modified. A separate disposable-tab diagnostic proved exact-target open
  and close with zero net tab growth.
- Manual next action: close or reload duplicate ChatGPT Project tabs in the
  dedicated browser, or provide a clean authenticated loopback CDP session,
  then rerun the opt-in live command. Do not resubmit any durable
  `submission_uncertain` request. Poll only for the exact `needs_manual` /
  `submission_uncertain` / `uncertain` / `workerActive: true` tuple; otherwise
  use manual recovery.
