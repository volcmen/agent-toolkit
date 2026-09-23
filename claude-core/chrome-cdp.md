# Browser & web

Read, fetch, automate web. Pick lightest layer that works.

## 1. Read-only fetch & research (no browser)

- Single page / docs / article → `WebFetch`. Clutter-stripped markdown → **defuddle** skill.
- Open-ended question, many sources → `WebSearch`, or **deep-research** skill for cited, fact-checked report.
- Prefer these when only need to *read* — cheaper, faster than browser.

## 2. Interactive automation — PREFERRED: `agent-browser` + CDP (headed)

Default engine for click/type/extract/navigate real browser. Dedicated **headed** Chrome on DevTools `127.0.0.1:9222`, profile `~/chrome-cdp-profile/` (own cookies/logins, separate from main Chrome). `agent-browser` = fast native CLI (Chrome via CDP, no Playwright/Puppeteer) — **deterministic** subcommands, no LLM key, no agent loop, low token cost. Killer feature: **a11y-tree snapshots with compact `@eN` refs** (~200-400 tokens vs raw HTML).

- **Binary:** `~/.bun/bin/agent-browser` (Bun global install, on PATH; currently 0.35.1).
- **Version-matched docs ship with CLI:** `agent-browser skills get core --full` (full command
  reference + patterns), `agent-browser skills list` (specialized: electron, slack, dogfood,
  vercel-sandbox, agentcore). Prefer over guessing flags. Upstream skill:
  <https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md>.

### ALWAYS CDP mode — never let agent-browser launch its own browser

CDP mode = attach to already-running Chrome instead of launching one. Docs:
<https://github.com/vercel-labs/agent-browser#cdp-mode>. Two ways, both fine:

- `agent-browser connect 9222` — **default**. Persistent; later commands in that session reuse
  it, no flag repeat.
- `agent-browser --cdp 9222 <cmd>` — per-command, stateless. Use in one-shot scripts, hooks,
  cron, or after `close`. Also takes full `ws://`/`wss://` URL for remote CDP.

`--auto-connect` is NOT the path — discovery is best-effort (DevToolsActivePort probe). State
the port.

### Two-step bring-up (run once per session)

1. **Ensure headed Chrome up (idempotent):** `fish -c chrome-cdp` — delegates to
   `Chrome CDP.app` helper, launches or reuses headed Chrome on :9222, profile
   `~/chrome-cdp-profile`. Prints `launched PID n` / `reused PID n`, exit 0. Spotlight
   "Chrome CDP" is same path. First use of site: log in that window once; profile persists.
2. **Attach over CDP:** `agent-browser connect 9222`. Verify real Chrome:
   `agent-browser eval 'navigator.userAgent'` must NOT contain "Headless"
   (expect genuine `Chrome/151…`).

### Shutting it down — `fish -c chrome-cdp-stop`, never `pkill`

> **⚠️ Never `pkill` / `kill -9` this Chrome.** Chrome batches cookie writes and only
> flushes the jar during graceful shutdown. SIGKILL abandons that batch — persistent
> logins silently vanish while history, Local Storage and saved passwords survive, so
> the profile *looks* healthy. This is how the ChatGPT session was lost (2026-09-20).

`fish -c chrome-cdp-stop` sends SIGTERM to the :9222 browser process and waits for it to exit
on a 30 s deadline; if Chrome ignores SIGTERM it reports failure and leaves the process running
rather than escalating to SIGKILL. Idempotent: prints `not running`, exit 0, when nothing is up.
It matches on **both** the port and `--user-data-dir`, so it can never hit main Chrome.

Don't use `profile.exit_type` in `Default/Preferences` as a shutdown check. It reads `Crashed`
for the whole time Chrome is running (startup sentinel) and only flips to `Normal` after
longer sessions, so it reports false failures on a short one. Verified 2026-09-20: a cookie
set in-page is absent from `Default/Cookies` until shutdown — it survives `chrome-cdp-stop`
and is permanently lost on `kill -9`, regardless of what `exit_type` says.

### Cookie-jar backup and recovery

Every successful `chrome-cdp-stop` copies `Default/Cookies` to
`~/chrome-cdp-backups/Cookies-<timestamp>.db`, skipping the copy when the jar is byte-identical
to the newest backup and keeping the newest 10. The jar is one SQLite file encrypted with this
machine's stable `Chrome Safe Storage` keychain key, so a plain file copy round-trips every
cookie — httpOnly, Secure, SameSite and all.

`fish -c chrome-cdp-restore [backup.db]` puts one back: newest by default, or an explicit path.
It refuses while Chrome is running (restoring under a live browser would be overwritten on exit),
stashes the jar it replaces under `~/chrome-cdp-backups/replaced/`, and clears any stale
`-journal`/`-wal` that would otherwise roll the restored file back on open. Idempotent: restoring
an already-matching jar is a no-op.

**`agent-browser state save/load` is not a substitute.** `state save` does read the live jar
(including cookies not yet flushed), but `state load` and `--state` only set a path for a
browser agent-browser launches *itself* — verified 2026-09-20, neither injects into an already
running CDP browser, and a restore through them silently does nothing.

> **⚠️ Attach, don't self-launch.** Without `connect` / `--cdp`, agent-browser launches its **own**
> Chromium — **headless by default** → UA `HeadlessChrome/…` → bot-walls (Yad2 / PerimeterX /
> ShieldSquare) trap it, and nothing is visible on screen. Every browser task starts with
> `connect 9222` or carries `--cdp 9222`.
>
> `connect` prints `launched browser` even when attaching — wording is misleading, not a
> self-launch. Confirm with the UA check, or that the target shows in
> `curl -s 127.0.0.1:9222/json/list`.

**Per-session isolation:** `--session` gets its own browser, so each needs its own attach:
`agent-browser --session my-task connect 9222`, or `--session my-task --cdp 9222 <cmd>`.

### The core loop (snapshot-and-ref)

```
agent-browser open <url>        # 1. navigate
agent-browser snapshot -i       # 2. see interactive elements → @e1, @e2, … refs
agent-browser click @e3         # 3. act on a ref
agent-browser snapshot -i       # 4. RE-snapshot after any page change
```

**Refs go stale moment page changes** (navigation, submit, dynamic re-render, dialog).
Re-`snapshot` before next ref interaction.

### Driving it (deterministic primitives)

- **Read:** `snapshot -i` (interactive-only a11y tree w/ refs), `snapshot -i --json` (structured —
  best for reasoning over content), `get text @ref` / `get attr @ref <name>` / `get url` / `get title`,
  `eval "<expr>"`.
- **Navigate:** `open <url>`, `back`, `forward`, `reload`, `scroll up|down|left|right [px]`,
  `scrollintoview <sel|@ref>`.
- **Interact (refs from `snapshot`, or CSS selectors):** `click @ref`, `dblclick`, `type <sel> <text>`,
  `fill <sel> <text>` (clears first), `press <key>` (`Enter`, `Tab`, `Control+a`), `keyboard type <text>`
  (real keystrokes, no selector), `hover`, `focus`, `check`/`uncheck`, `select <sel> <val…>`,
  `drag <src> <dst>`, `upload <sel> <files…>`.
- **Find without snapshot:** `find role|text|label|placeholder|alt|title|testid|first|last|nth <value> <action> [text]`.
- **Wait:** `wait <sel|ms>`. Don't `sleep`-guess — wait on element/condition.
- **Screenshot:** `screenshot [path]`, `--full` (full scroll height), `--annotate` (numbered `[N]`
  labels keyed to `@eN` refs — for multimodal). Prefer `snapshot` over screenshot — text beats vision
  on tokens; screenshot only when layout/visual bug matters.
- **Complex JS:** inline `eval "…"` for **simple expressions only**. Anything with quotes/special
  chars → `eval --stdin` (heredoc) or `eval -b <base64>`.
- **Tabs:** `tab` (list, stable `tabId`s), `tab new <url>`, `tab t2` (switch), `tab close t2`.
- **Parallel browsers:** `--session <name>` = isolated browser (own cookies/tabs/refs);
  `AGENT_BROWSER_SESSION=name` sets shell default.
- **Persist auth across runs:** log in once in the headed window, then `fish -c chrome-cdp-stop`
  — that flush is what makes it durable, and it takes the backup. Recover with
  `chrome-cdp-restore`. See "Cookie-jar backup and recovery" above.
- **Network:** `network route "**/api/x" --body '…'|--abort`, `network requests`, `network har start|stop`.
- **Record:** `record start demo.webm` … `record stop`.
- Never trigger `alert` / `confirm` / `prompt` dialogs — they block the page.
- **If command misbehaves:** `agent-browser close` (releases session) then re-`connect 9222`
  (`close --all` closes every session). `close` never kills the :9222 Chrome — re-attach, don't
  re-launch.

### Workflows & gotchas

- **Authenticated sites (Gmail/GitHub/Yad2/Facebook/WhatsApp/ChatGPT):** `~/chrome-cdp-profile/`
  keeps cookies — log in **once** in headed window, persists across sessions *provided every
  shutdown goes through `chrome-cdp-stop`*.
- **⚠️ Don't co-attach two CDP automation clients to same :9222 browser.** Two clients fight over
  active target → agent-browser can drift to `about:blank` or logged-out context mid-run
  (verified 2026-06-19). One engine at a time; `close` one before driving with another.
- **`eval` of `innerText` returns empty on *backgrounded* tab** (Chrome skips layout for hidden
  tabs). Use `textContent`, or foreground tab — but **prefer `snapshot`/`@ref` reads**, unaffected.
- **`eval` does not await Promises.** Async work: fire `fetch().then(j=>window.__x=j)`, `wait`,
  then `eval window.__x`.
- **Element not found?** Likely below fold or in closed shadow root / iframe. `scroll down` then
  re-`snapshot`. Iframes auto-inlined in snapshot (refs work transparently). Stubborn
  nodes → drop to `eval`.
- **Verify before destructive/irreversible clicks** — re-`snapshot` so ref still points where you
  think; never type blind into send/submit.

## 3. Fallback — claude-in-chrome MCP (my MAIN Chrome profile)

Use ONLY when task needs my **everyday** Chrome — its real cookies/logins/open tabs —
which separate CDP profile (layer 2) does NOT have. claude-in-chrome extension drives
main profile in-place.

- Tools deferred: load with ONE ToolSearch call first —
  `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp`
  (add `read_console_messages` / `read_network_requests` / `form_input` / `gif_creator` /
  `javascript_tool` to same call when task needs them).
- Call `tabs_context_mcp` FIRST to see current tabs; create new tab with `tabs_create_mcp`
  rather than reusing unless I ask.
- Prefer text/DOM reads (`read_page` / `get_page_text`) over screenshots.
- Never trigger `alert` / `confirm` / `prompt` dialogs — they block all further extension events.

## Profile boundary (why two engines)

Chrome 136+ (mine is 151) **blocks `--remote-debugging-port` on default profile**, so CDP
only attaches to *separate* `--user-data-dir`. That's `~/chrome-cdp-profile/` used by layer 2 —
its logins NOT my main profile's. So: reach for **layer 2 (agent-browser/CDP)** by default; fall
back to **layer 3 (claude-in-chrome)** only when task must run inside main profile's live
session. Log into sites you need *once* inside CDP profile, they persist there.

### Exactly one automation profile — `~/chrome-cdp-profile` on :9222

Never launch a second Chrome on another port or `--user-data-dir` to work around a problem.
A second profile means a second set of logins, and neither gets maintained.

`chatgpt-consult` is configured with `browserCdpPort: 9222` in
`~/.config/chatgpt-consult/config.json`, so `BrowserSessionManager.ensureRunning` short-circuits
to `attachExternal(9222)` and shares this profile. Its *managed* mode (own Chrome, own
`chrome-profile/`) only activates if that key goes missing — if `chatgpt-consult doctor` ever
reports the `cdp` row as anything but `SKIP`, a stray managed profile has come back.
