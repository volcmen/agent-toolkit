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
| ChatGPT Project | Receives one root conversation per consultation thread; follow-ups reuse its proven conversation URL. |

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

Follow-ups reuse the same ChatGPT conversation. Private completion does not
grant write authority:

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
