# ChatGPT Consult Design

## Summary

`chatgpt-consult` will be a source-managed Bun project that lets a local coding
agent or a human request a bounded consultation from ChatGPT web without using a
local model or the OpenAI API as the consultation engine.

ChatGPT remains the conversation and model host. A project-scoped MCP server
provides selected local context to ChatGPT and receives a structured result.
The full conversational experience stays in a ChatGPT Project; the local
repository receives only private request state and deliberately published,
curated consultation records.

The design has three cooperating surfaces:

1. A local CLI and stdio MCP surface creates, follows, polls, cancels, and
   publishes consultations.
2. A Streamable HTTP MCP surface, reached from ChatGPT through Secure MCP
   Tunnel, lets ChatGPT retrieve bounded project context and complete requests.
3. An optional browser helper opens or resumes the correct ChatGPT Project chat
   using one dedicated Chrome process shared by Bun WebView and agent-browser
   over loopback CDP. The helper submits request identifiers but never scrapes
   ChatGPT responses.

## Goals

V1 will:

- Add an independent top-level `chatgpt-consult/` project to this workspace.
- Use Bun for the CLI, server runtime, browser integration, and tests.
- Use ChatGPT web and the user's ChatGPT plan as the model host.
- Give ChatGPT project-local, explicitly bounded files, diffs, images, and
  other approved attachments through MCP.
- Support first consultations and follow-ups in the same ChatGPT conversation.
- Keep private operational state under the consulted project, out of version
  control, so unrelated chats do not pollute the repository.
- Support explicit context by default and deterministic smart selection as an
  opt-in.
- Offer `lean`, `research`, `analysis`, and `connected` capability profiles.
- Let ChatGPT choose tools within the chosen profile while preserving hard
  server-side path and action limits.
- Save a structured local result without reading or scraping the ChatGPT page.
- Publish a concise Markdown consultation only through an explicit local
  action.
- Provide a small cross-agent workspace plugin that teaches Codex and Claude
  Code when and how to request a ChatGPT consultation.
- Fail safely into a manual handoff when browser automation or tunneling is
  unavailable.

## Non-goals

V1 will not:

- Claim that a ChatGPT plan is literally unlimited or bypass its usage limits.
- Use ChatGPT consumer authentication as an OpenAI API credential.
- Require an OpenAI API key or Platform credits for the ChatGPT-web path.
- Automate ChatGPT through an unsupported private network API.
- Scrape the ChatGPT DOM to recover an answer.
- Mirror an entire ChatGPT conversation byte-for-byte into the repository.
- Allow ChatGPT to edit project files, execute shell commands, commit changes,
  or publish consultation documents.
- Automatically upload arbitrary repository contents or infer permission to
  cross the pinned project root.
- Copy browser cookies, tokens, or profile files into project storage.
- Put secrets, local paths, generated runtime state, or raw chat transcripts in
  version control.
- Host a public multi-user service, administration UI, billing layer, or cloud
  persistence in the first release.
- Depend on browser automation for correctness; it is a convenience layer.
- Control which built-in ChatGPT tools or separately installed ChatGPT plugins
  are available. The server can enforce only its own tool surface.

## Product model

The user creates one ChatGPT Project for each real software project or durable
workstream. That ChatGPT Project holds the full chats, project instructions,
and any ChatGPT-native sources. A separate chat is used for each consultation
outcome, with follow-ups remaining in that chat.

The local project contains a private `.chatgpt-consult/` directory with exact
request metadata, selected-context manifests, lifecycle events, attachments,
and structured results. A useful conclusion can be deliberately exported to
`docs/consultations/`. The two stores have different responsibilities:

| Store | Authority | Contents |
| --- | --- | --- |
| ChatGPT Project | Full conversational record | User-visible chat, ChatGPT reasoning experience, web research, and ChatGPT-native tool use |
| `.chatgpt-consult/` | Local protocol record | Exact request, approved context manifest, lifecycle, attachment hashes, structured completion, and conversation URL when known |
| `docs/consultations/` | Curated repository knowledge | Intentionally published Markdown summary suitable for review and version control |

The local record must never be described as the complete raw ChatGPT chat. It
is the exact request sent through this protocol plus the model-authored result
that ChatGPT explicitly returns through `request_complete`.

## Architecture

### Project boundary

Every server process is started with exactly one resolved project root. The
root is canonicalized once and becomes an immutable capability boundary for
that process. Tools cannot select another project, browse a parent directory,
or follow a symlink outside the root.

This deliberately favors one small server instance per consulted project over
a universal daemon with access to the whole machine. User-level setup may know
where the `chatgpt-consult` checkout lives, but that machine-specific path is
never committed to a repository.

### Components

| Component | Responsibility |
| --- | --- |
| Domain core | Request schemas, lifecycle, budgets, revisions, idempotency, atomic persistence, and error taxonomy |
| Context service | Explicit selection, deterministic smart selection, path confinement, secret screening, search, chunked reads, diffs, and media metadata |
| Local stdio MCP | Small agent-facing lifecycle tool surface |
| ChatGPT HTTP MCP | Read-only project context plus structured completion over Streamable HTTP |
| CLI | Human and stable `--json` commands mirroring the local MCP operations |
| Tunnel adapter | Readiness and setup around ChatGPT Secure MCP Tunnel; no tunnel implementation is embedded |
| Browser controller | Dedicated Chrome lifecycle, CDP validation, Bun WebView connection, ChatGPT navigation, and manual fallback |
| agent-browser adapter | Optional, policy-limited CDP fallback using a separate pinned tab/session |
| Workspace skill | Routes explicit ChatGPT-consult requests to the local tool and explains consent, polling, and publishing boundaries |

### End-to-end flow

1. A local agent or human runs `consult_start` or `chatgpt-consult start` with a
   goal, capability profile, explicit selectors, and optional diff or media.
2. The core resolves the project root, validates and records the selection,
   applies budgets and secret checks, creates an expiring request, and returns
   its opaque identifier immediately.
3. If requested, the browser helper opens the configured ChatGPT Project and
   submits a compact handoff containing the request identifier and claim
   capability. If automation fails, it prints that same handoff for manual use
   and leaves the request pending.
4. ChatGPT calls `request_get` through the connected MCP server. It receives the
   question, selected capability profile, a compact context manifest, budgets,
   and response contract rather than an unconditional dump of all files.
5. ChatGPT selectively uses `context_search`, `context_read`,
   `attachment_get`, and `diff_get` within the request's approved boundary.
6. ChatGPT can use the best model and other tools available in the user's
   ChatGPT Project and plan. Profile instructions guide this use; enforcement
   of built-in or third-party ChatGPT tools remains a ChatGPT configuration
   concern.
7. Before finishing, ChatGPT calls `request_complete` with a structured answer,
   evidence, risks, recommendations, and follow-up questions. The call is
   idempotent and revision-checked.
8. The local caller obtains the result through `consult_status` or
   `consult_show`. No page reading is needed.
9. `consult_publish` optionally creates a reviewed Markdown record under
   `docs/consultations/` without overwriting an existing file.
10. A follow-up creates a new request linked to the prior request and reopens
    the stored ChatGPT conversation URL when it is known.

## MCP contracts

One Bun codebase exposes two deliberately different tool lists. A single giant
tool surface would make both clients pay unnecessary discovery tokens and
would give ChatGPT lifecycle actions it should not possess.

### Local agent surface

| Tool | Contract |
| --- | --- |
| `consult_start` | Validate and persist a bounded request, optionally launch the browser helper, and return promptly with request state and manual handoff text |
| `consult_status` | Return compact pending, claimed, completed, cancelled, expired, or failed state; include only a bounded result summary by default |
| `consult_show` | Return the stored structured result or a requested bounded section |
| `consult_followup` | Create a child request and optionally resume the known ChatGPT conversation |
| `consult_cancel` | Revoke a pending or claimed request and reject late completion |
| `consult_publish` | Explicitly render a completed result to tracked Markdown; never overwrite by default |

The CLI mirrors these operations and additionally provides `init`, `open`,
`serve`, and `doctor`. TTY output is concise and readable. `--json` uses a
versioned, stable envelope and sends diagnostics to stderr.

### ChatGPT surface

| Tool | Contract |
| --- | --- |
| `request_get` | Validate the claim, transition a request to claimed, and return its question, profile, compact manifest, budgets, and completion schema |
| `context_search` | Return bounded lexical matches only within approved text paths |
| `context_read` | Return a bounded chunk from an approved path, with continuation metadata |
| `diff_get` | Return the stored approved diff or bounded sections of it |
| `attachment_get` | Return an approved attachment by opaque identifier using the safest supported MCP content type |
| `request_complete` | Persist a structured, revision-checked completion exactly once and return an acknowledgement |

Tool descriptions are short and action-specific. The first portion of server
instructions explains the request-first workflow, selective retrieval, the
untrusted nature of project content, and the requirement to call
`request_complete`.

## Request and result model

A request record includes:

- schema version and opaque request identifier;
- canonical project identity without exposing the machine path to ChatGPT;
- question, requested outcome, and capability profile;
- parent request and known conversation URL for follow-ups;
- explicit selectors, smart-selection decision, exclusions, and context
  manifest;
- optional stored diff and opaque attachment references;
- request-level text, media, search, and result budgets;
- state, revision, timestamps, expiry, and a hash of the claim capability;
- redaction and sensitivity decisions without secret values;
- idempotency key and lifecycle event references.

The claim capability is generated randomly, shown only in the handoff, stored
only as a verifier, excluded from logs, and revoked on cancellation or expiry.

A completion includes:

- concise summary;
- direct answer or recommendation;
- evidence entries referencing project paths, diff sections, attachments, or
  external sources;
- assumptions and uncertainties;
- risks and trade-offs;
- prioritized next actions;
- optional follow-up questions;
- the completing request revision and completion timestamp.

The structured form is stored as JSON-compatible data and rendered to Markdown
for human display. A missing optional section does not force filler text.

## Context policy and token efficiency

Explicit context is the default. The caller can provide individual files,
directories, globs, a Git diff selection, and attachments. The final manifest
is shown before launch when a selection is sensitive, unusually broad, or
exceeds the normal soft budget.

Smart selection is opt-in and uses deterministic local signals rather than an
API or local language model. It can combine mentioned paths and symbols, Git
status and diff metadata, nearby imports, repository conventions, and bounded
lexical search. It never searches outside the pinned root, reports every chosen
path, and remains subject to the same exclusions and budgets as explicit
selection.

Initial defaults are conservative and configurable:

- at most 25 selected text paths;
- 64 KiB maximum per `context_read` response;
- 1 MiB cumulative text served per request;
- 50 search hits with bounded snippets;
- 10 MiB per attachment and 25 MiB total attachments;
- 256 KiB maximum structured completion;
- 24-hour request expiry.

Hard ceilings remain even if local configuration raises soft defaults. Large
files are chunked; unsupported binary files return metadata rather than raw
bytes. Content-addressed attachments are deduplicated locally.

### Capability profiles

| Profile | Intended behavior |
| --- | --- |
| `lean` | Use the question, manifest, and small explicit context; minimize retrieval and outside tools |
| `research` | Prefer current authoritative web sources when available and return citations; local context remains bounded |
| `analysis` | Permit deeper project search, chunked reads, diff inspection, and approved media analysis |
| `connected` | Permit the analysis profile plus explicitly allowlisted ChatGPT connectors or plugins configured by the user |

The selected profile affects request instructions and this server's budgets.
It cannot technically grant or revoke ChatGPT's built-in tools or other
connectors. The ChatGPT Project remains the enforcement point for those tools,
and `connected` must report its intended allowlist so the user can compare it
with actual Project configuration.

## Storage

Each consulted repository owns private runtime state:

```text
.chatgpt-consult/
  requests/<id>.json
  results/<id>.json
  results/<id>.md
  attachments/<sha256>
  events/<id>.jsonl
  locks/<id>.lock
  config.local.json
```

`chatgpt-consult init` creates the directory safely and adds
`.chatgpt-consult/` to the project's `.gitignore` only when needed. It never
overwrites unrelated ignore rules or configuration. Event records are bounded,
structured, and redact claim capabilities and content bodies.

Optional curated output lives at:

```text
docs/consultations/YYYY-MM-DD-<topic>.md
```

Writes use a same-directory temporary file, flush, and atomic rename. Request
updates use revision comparison under a per-request lock. Attachments use their
SHA-256 digest as identity and are immutable after validation.

## Browser session design

Browser support uses one dedicated `chatgpt-consult` Chrome profile stored in a
user configuration location outside repositories. Exactly one Chrome process
owns that profile.

The launcher starts visible Chrome with a dynamically selected loopback-only
remote-debugging port, a dedicated user-data directory, and safe first-run
flags. It validates process identity, profile identity, loopback listener, CDP
version response, and loopback WebSocket URL before use. It never connects to a
foreign listener or opens the profile in a second browser process.

Bun WebView is forced to its Chrome backend and attaches to the already-running
Chrome instance through its CDP WebSocket. agent-browser may attach to the same
endpoint using a distinct named session and pinned tab. The two controllers
share authenticated browser state because they control one browser process,
not because they independently open or copy the same profile directory.

The browser helper is limited to:

- opening or foregrounding the configured ChatGPT Project;
- reopening a previously stored conversation URL;
- placing the compact request handoff into the ChatGPT composer;
- submitting it after explicit invocation; and
- recording the resulting ChatGPT conversation URL when observable without
  extracting response content.

Navigation is restricted to configured ChatGPT and required OpenAI login
origins. Arbitrary script evaluation, downloads, broad page extraction, and
unsolicited file uploads are disabled. Source files and media travel through
MCP, not browser upload automation.

If Bun WebView is unavailable or incompatible, the helper can use
agent-browser. If both fail, it prints the handoff and opens the appropriate
ChatGPT page when possible. The protocol remains fully usable manually.

## Security model

### Filesystem

- Canonicalize the root once and reject absolute paths, `..` traversal, NULs,
  special devices, and symlink escapes.
- Default-deny `.env*`, private keys, common credential stores, browser
  profiles, `.git/`, dependency trees, build caches, and configurable sensitive
  patterns.
- Inspect selected text for likely secrets. Block high-confidence secrets;
  otherwise redact and require confirmation for sensitive selections.
- Validate media type by content and extension, cap sizes, and never execute or
  render active content locally.
- Treat all project content as untrusted data. No content can change the server
  root, invoke commands, select capabilities, or modify lifecycle state.

### MCP and network

- The local MCP is stdio-only.
- The ChatGPT MCP binds to loopback when used with Secure MCP Tunnel.
- Requests require an unguessable identifier, claim capability, current
  revision, and a live authenticated connector path.
- Claim verifiers and local connector credentials never enter prompts, logs, or
  committed files.
- A future remote deployment requires HTTPS and explicit authentication; it is
  not silently enabled by V1.
- ChatGPT receives only read operations plus completion of its claimed request.
- Consequential operations, including publishing, remain local and explicit.

### Browser

- Chrome CDP binds only to loopback on a non-default, dynamically selected
  port.
- The dedicated profile is a non-symlinked, user-owned directory with private
  permissions.
- The controller validates the process and endpoint before attaching.
- CDP coordinates and raw browser state are local-only and redacted from logs.
- Closing or idling out the helper can close the dedicated browser only when it
  proves ownership; it never kills an unknown process.

## Lifecycle and recovery

The protocol state machine is:

```text
pending -> claimed -> completed
   |          |
   +----------+-> cancelled
   +----------+-> expired
```

Creation and status calls are non-blocking. `consult_start` never waits for a
ChatGPT response. A caller polls with a bounded cadence or returns later.

Important recovery rules:

- Repeating creation with the same idempotency key returns the original
  request.
- Repeating `request_get` with the valid claim is safe and does not reset
  budgets.
- Repeating an identical `request_complete` returns success; a different second
  completion returns a conflict.
- Cancellation and expiry revoke the claim and reject late completions.
- Browser failure leaves the request pending and returns an actionable manual
  handoff.
- Tunnel failure does not trigger a public exposure fallback. `doctor` offers
  Secure MCP Tunnel setup, an explicitly configured authenticated HTTPS
  endpoint, or manual prompt/result handoff.
- A follow-up is a new child request, so every turn has an immutable context
  manifest and result even when the ChatGPT conversation continues.
- Corrupt or unsupported schema versions are quarantined and reported rather
  than rewritten.

## Diagnostics

`chatgpt-consult doctor` reports independent readiness checks for:

- supported Bun version and Bun WebView availability;
- package dependencies and writable private state;
- project-root confinement and ignore status;
- local stdio MCP startup;
- Streamable HTTP MCP health;
- Secure MCP Tunnel availability and connector reachability;
- Chrome availability, profile safety, and loopback CDP;
- agent-browser availability and version when fallback is enabled;
- configured ChatGPT Project URL and logged-in browser state; and
- generated workspace plugin and installed-cache drift.

Diagnostics report state and corrective commands without printing secrets,
cookies, claim capabilities, or raw project content. Browser login and ChatGPT
account checks are best-effort and are clearly distinguished from protocol
health.

## Source and workspace integration

The source-managed project layout is:

```text
chatgpt-consult/
  README.md
  package.json
  bun.lock
  bin/
    chatgpt-consult.ts
  src/
    browser/
    cli/
    context/
    core/
    mcp/
    security/
  tests/
  docs/
  plugins/
    chatgpt-consult/
      skills/
        chatgpt-consult/
          SKILL.md
```

The Bun package owns the executable and both MCP transports. It uses the
official TypeScript MCP SDK and Zod for protocol validation. Bun WebView is a
runtime feature, and agent-browser remains an optional external executable.

The root `plugins.json` remains the only marketplace source of truth. It gains
one `chatgpt-consult` entry pinned at `1.0.0`. The workspace generator creates
the Claude and Codex manifests. No generated manifest is hand-edited.

The installed workspace skill is intentionally small. It routes explicit
requests such as "consult ChatGPT" or "ask the ChatGPT Project," creates a
request through the local MCP or CLI, returns the request state without
blocking indefinitely, and publishes only when the user asks. It does not
claim ChatGPT usage is free or unlimited and does not silently initiate a
browser session for unrelated work.

User-local setup registers the discovered Bun executable path in supported
client configuration and helps connect the ChatGPT MCP endpoint. Absolute
checkout paths, profile paths, tunnel state, and account configuration stay in
local configuration.

Primary commands are:

```text
chatgpt-consult init
chatgpt-consult start
chatgpt-consult followup
chatgpt-consult status
chatgpt-consult show
chatgpt-consult cancel
chatgpt-consult publish
chatgpt-consult open
chatgpt-consult serve
chatgpt-consult doctor
```

## Testing strategy

### Unit tests

- root canonicalization, traversal rejection, and symlink escapes;
- default exclusions, secret screening, redaction, and sensitivity decisions;
- deterministic explicit and smart context selection;
- text, search, attachment, and result budgets;
- request schema parsing and migration refusal;
- lifecycle transitions, expiry, cancellation, and revision conflicts;
- idempotent creation, claiming, and completion;
- atomic writes, locking, content-addressed attachments, and overwrite refusal;
- stable JSON envelopes and bounded human output; and
- browser process, listener, profile, and endpoint classification with injected
  observations.

### Integration tests

- local stdio MCP through a simulated MCP client;
- ChatGPT Streamable HTTP MCP through a simulated authenticated client;
- request creation, selective retrieval, structured completion, follow-up, and
  publication without a browser;
- concurrent status and completion operations;
- temporary repositories containing sensitive files, large files, symlink
  escapes, binary attachments, and Git diffs; and
- MCP Inspector validation for both exposed surfaces.

### Browser tests

Browser smoke tests are explicit and use a disposable profile and alternate
port. Normal test runs do not require a ChatGPT account. A manual authenticated
acceptance test validates the dedicated persistent profile, Bun WebView CDP
attachment, agent-browser fallback, ChatGPT Project navigation, submission,
conversation resumption, and manual handoff.

### Workspace verification

The project supplies a single comprehensive Bun check command covering tests,
type checking, and project invariants. After plugin or project-script changes,
workspace validation also runs:

```sh
python3 scripts/plugins.py sync
python3 scripts/plugins.py check
```

Installation verification uses `python3 scripts/plugins.py install --force`
only after the implementation and plugin checks pass, then verifies live-cache
status. No routine check invokes mutating release operations.

## Delivery slices

1. **Core and local surface:** schemas, request store, path security, context
   selection, CLI, local stdio MCP, and unit tests.
2. **ChatGPT surface:** Streamable HTTP tools, completion protocol, tunnel
   diagnostics and setup documentation, simulated-client integration tests,
   and manual handoff.
3. **Browser convenience:** dedicated Chrome lifecycle, loopback CDP validation,
   Bun WebView attachment, agent-browser fallback, conversation URL handling,
   and opt-in browser smoke tests.
4. **Workspace integration:** skill, root catalog entry, generated manifests,
   complete documentation, acceptance runbook, repository checks, forced local
   reinstall, and installed-cache verification.

Each slice must pass its targeted tests before the next begins. The browser
slice cannot weaken or replace the manual protocol path.

## Acceptance criteria

- `chatgpt-consult/` is a documented, source-managed Bun project with a stable
  CLI and both MCP transports.
- A caller can create a bounded request from any initialized Git project and
  immediately receive an opaque identifier and state.
- The server never reads outside the pinned project root or serves a denied or
  escaped file.
- Explicit context, deterministic smart selection, diffs, images, and approved
  attachments are represented in an inspectable manifest with enforced
  budgets.
- ChatGPT can claim a request through the connected Streamable HTTP MCP,
  selectively retrieve context, and save a structured completion.
- The local caller can retrieve that completion without DOM or network
  scraping.
- A follow-up resumes the known ChatGPT conversation when possible while
  storing an immutable child request locally.
- Bun WebView and agent-browser can attach to one validated, dedicated Chrome
  process without opening the profile concurrently or exposing CDP beyond
  loopback.
- Browser or tunnel failure produces a usable manual handoff and preserves the
  pending request.
- Private state is ignored; no credentials, claim capabilities, browser state,
  raw chats, or absolute local paths are committed.
- Publishing is explicit, creates a concise reviewable Markdown document, and
  refuses accidental overwrite.
- The new workspace plugin is declared only through `plugins.json`, generated
  manifests match it, the live cache is refreshed, and workspace checks pass.
- Automated tests cover security boundaries, lifecycle, MCP contracts,
  idempotency, failure modes, and token budgets; the authenticated browser flow
  has a documented successful acceptance run.

## Deferred follow-ups

- Hosted authenticated multi-user MCP deployment.
- Shared team policy, administration, audit export, and retention controls.
- A visual dashboard for consultation history.
- Semantic or embedding-based context retrieval.
- Automatic import of a full ChatGPT transcript if OpenAI later provides a
  supported export endpoint for the relevant product surface.
- Additional browser backends and non-Chromium session sharing.
- Public package publication and declarative Bun-global installation.
- ChatGPT Workspace Agents API integration if retrievable run results and the
  required workspace administration model become a better fit.

## References

- [OpenAI MCP integration documentation](https://learn.chatgpt.com/docs/extend/mcp)
- [OpenAI plugin concepts](https://developers.openai.com/plugins/concepts/plugins)
- [OpenAI MCP server concepts](https://developers.openai.com/plugins/concepts/mcp-server)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Connect an MCP server to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT Projects](https://learn.chatgpt.com/docs/projects)
- [OpenAI API quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)
- [Bun WebView](https://bun.com/docs/runtime/webview)
- [agent-browser](https://github.com/vercel-labs/agent-browser)
