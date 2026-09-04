# Browser-backed acceptance

Use this checklist for a no-key end-to-end verification with the account owner.
The live steps create bounded test conversations in the configured ChatGPT
Project. Authentication, 2FA, CAPTCHA, and consent are completed only in the
headed browser.

## Automated prerequisites

- [x] `python3 bun-global-tools/sync.py check --deep` verifies Bun-owned
      `agent-browser` 0.35.1 and its `~/.bun/bin` command path.
- [x] `bun run check` passes; only explicitly opt-in live tests are skipped.
- [x] `python3 scripts/plugins.py check` passes from the workspace root.
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
- [ ] One follow-up with `--open` completes in the same canonical conversation.
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

## Legacy/optional compatibility

Testing `serve chatgpt`, its loopback health endpoint, a Secure MCP Tunnel, or
ChatGPT Developer Mode is a separate compatibility exercise. None is a
prerequisite for browser-backed acceptance, and none is started automatically.

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
