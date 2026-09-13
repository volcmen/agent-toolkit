# ChatGPT Consult

ChatGPT Consult gives Codex and Claude a bounded second opinion from the user's
signed-in ChatGPT web account. The agents call a six-tool local MCP; a private
Bun worker drives `agent-browser` against one configured ChatGPT Project,
validates the answer, and stores it under the current project. Results remain
private until the user explicitly publishes them.

The recommended path uses the existing ChatGPT web subscription. It does not
call the OpenAI API, consume API credits, require an API key, expose a public
endpoint, or require ChatGPT Developer Mode.

## Architecture

| Boundary | Responsibility |
| --- | --- |
| Local MCP | Lets Codex or Claude start, inspect, continue, cancel, and explicitly publish consultations. |
| Request store | Keeps bounded requests, browser progress, and results under ignored `.chatgpt-consult/` state. |
| Browser worker | Uses pinned `agent-browser` with loopback CDP and a dedicated persistent Chrome profile. |
| ChatGPT Project | Groups consultation chats; related follow-ups continue or start fresh with a bounded summary. |

Independent consultations can run in parallel, including from separate Codex
and Claude clients. Each browser attempt has its own pinned tab, automation
session, and private temporary workspace. All attach to the same signed-in
Chrome profile, reusing its existing credentials; starting another consultation
does not require another login. These sessions isolate tab control, not account
cookies or ChatGPT usage limits.

A detected ChatGPT rate-limit warning returns `needs_manual` / `rate_limited`
and starts a five-minute local cooldown shared by workers using the same Chrome
CDP port and configuration root. New automatic attempts stop before opening a
tab; they do not extend the cooldown or retry automatically. Keep the existing
login and wait for the site's restriction to clear before resuming. Five
minutes is a conservative local policy, not a guarantee about ChatGPT's limit.

Only one unfinished automatic consultation may write to a given conversation.
A simultaneous follow-up returns `CONFLICT` with the existing request ID before
creating another request. Wait for that request to finish, then continue the
thread; use a new consultation for an independent question. Diagnostic
probes also use isolated sessions and close only their exact created tab.

Attachment requests wait for an enabled Send button and click it explicitly.
Follow-ups become `submitted` only after the newly posted user message matches
the current request ID and revision. An unchanged conversation URL cannot prove submission;
failure to observe the message returns `submission_uncertain` without sending
it again. Rejected responses remain in private bounded diagnostics.

## Install and sign in

Prerequisites are Bun 1.4.0 or newer, Git, Chrome or Chromium, and a supported
Codex or Claude CLI. In this workspace, `agent-browser` 0.35.1 is installed and
verified through the Bun-global manifest:

```bash
python3 bun-global-tools/sync.py apply
```

Set up the project:

```bash
cd chatgpt-consult
bun install --frozen-lockfile
CHATGPT_CONSULT_BIN="$PWD/bin/chatgpt-consult.ts"
consult() { bun run "$CHATGPT_CONSULT_BIN" "$@"; }

cd /path/to/project
consult init --chatgpt-project-url https://chatgpt.com/g/g-p-example/project
consult setup clients --apply
consult setup browser
consult doctor
```

`setup browser` opens the dedicated profile headed. Enter credentials and
complete login, 2FA, CAPTCHA, or consent only in ChatGPT. ChatGPT Consult never
reads those credentials. Routine consultations reuse that profile headlessly;
an explicitly configured loopback CDP session is also supported.

`init` writes `.chatgpt-consult/config.local.json` for one project. To consult
from any directory without a per-project `init`, put the same JSON in
`~/.config/chatgpt-consult/config.json` (or under `CHATGPT_CONSULT_CONFIG_HOME`).
A project file always wins over the global one. `browserCdpPort` in either file
attaches the worker to an already signed-in Chrome on that loopback port instead
of the managed profile, which is the recommended setup on a desktop where the
sterile profile cannot pass account login checks.

Use the URL of an actual ChatGPT Project, such as
`https://chatgpt.com/g/g-p-example/project`. Home, ordinary conversation,
custom GPT, and settings URLs are rejected. Run `init --chatgpt-project-url`
in each repository to organize its consultations in a different Project;
new local configuration preserves the global Chrome connection settings.
Changing the Project does not require a different login. A saved consultation
keeps its original Project even if the repository configuration later changes.
`init --chatgpt-project-url` can also replace an older non-Project URL while
preserving the existing browser settings.

## Consult

Use the cheapest sufficient profile and only the context the question needs:

```bash
consult start "Review the queue retry policy" \
  --profile lean \
  --file src/queue.ts \
  --open

consult status <id>
consult show <id>
consult followup <id> "Check cancellation races too" --file src/queue.ts --open
consult followup <id> "Explore a different design" --chat-mode new --open
```

`--open` starts asynchronous browser work; the MCP tools start it by default
and accept `open: false` to only queue. Poll `status` until `completed`, or
until it returns `needs_login`, `needs_manual`, `cancelled`, or `expired`. Run
`show` only after completion. On `needs_login`, finish authentication in the
headed profile and resume the same request with `consult open <id>`. On
`needs_manual`, continue polling only for the exact tuple: phase
`needs_manual`, reason `submission_uncertain`, `submissionCertainty` equal to
`uncertain`, and `workerActive` equal to `true`. This is the same live attempt
confirming its submission, never authority to send it again. For any mismatch,
follow the returned manual-recovery guidance and never resubmit uncertain work.

Profiles are `lean`, `analysis`, `research`, and `connected`. Prefer explicit
`--file` selectors. `--smart` retains explicit selectors and only backfills the
remaining bounded path budget. Diffs and attachments are opt-in, and sensitive
content remains blocked unless `--allow-sensitive` is deliberately supplied.

Use `start` for an unrelated topic. For related completed work, `followup`
accepts `--chat-mode` (MCP: `chat_mode`):

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Continues inside the saved Project until six recorded exchanges; then starts a fresh Project chat. Missing or outside-Project conversations also start fresh. |
| `new` | Starts a fresh chat in the same Project with a bounded summary of the parent consultation. Use for a changed direction or crowded context. |
| `continue` | Explicitly keeps the proven Project conversation, overriding the exchange threshold. |

Queued exchanges reserve slots so parallel callers cannot overfill the same
thread. Fresh chats retain the local parent link and carry only the prior
goal, summary, and a few risks and recommendations; old full answers, files,
and attachments are not copied. Status shows the Project, mode, reason, and
exchange number. Browser submission and recovery check Project membership;
an unexpected redirect stops the attempt. This policy neither retries
uncertain work nor bypasses account usage limits.

Private completion does not grant write authority:

```bash
consult publish <id>
```

Run `publish` only after explicit approval; optionally select the destination
with `--output`.

## Manual recovery

The bounded manual path remains available without browser automation:

```bash
consult handoff <id>
consult import-result <id> --input result.json
consult show <id>
```

## Legacy/optional remote compatibility

`consult serve chatgpt`, the loopback ChatGPT-facing MCP, Secure MCP Tunnel,
and ChatGPT Developer Mode are compatibility features only. The recommended
browser-backed workflow never starts the remote server or a tunnel
automatically. See [docs/CHATGPT_SETUP.md](docs/CHATGPT_SETUP.md) only if that
legacy integration is intentionally required.

## Verify

```bash
(cd "$(dirname "$CHATGPT_CONSULT_BIN")/.." && bun run check)
consult doctor --json

# From the Personal AI workspace root:
python3 scripts/plugins.py check
python3 scripts/plugins.py status
python3 bun-global-tools/sync.py check --deep
```

`doctor` is non-mutating and reports the browser-backed path before optional
compatibility checks. See [docs/SECURITY.md](docs/SECURITY.md) for trust
boundaries and [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for end-to-end checks.
