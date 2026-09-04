# Connect ChatGPT web

The recommended integration uses `agent-browser` and the user's authenticated
ChatGPT web session. Codex and Claude use the local MCP; ChatGPT does not need
to connect back to this machine. No OpenAI API key, public URL, tunnel, or
Developer Mode is required.

## Browser-backed setup

From the repository being consulted:

```bash
chatgpt-consult init --chatgpt-project-url https://chatgpt.com/g/g-p-example/project
chatgpt-consult setup clients --apply
chatgpt-consult setup browser
chatgpt-consult doctor
```

The Project URL is stored only in ignored `.chatgpt-consult` state.
`setup browser` opens a dedicated persistent profile headed. Sign in and complete
2FA, CAPTCHA, or consent directly in ChatGPT. The tool does not read browser
credentials, cookies, tokens, or storage.

Routine work launches the same managed profile headlessly. To use a separately
managed loopback CDP browser, configure it explicitly with
`setup browser --cdp <port>`; `setup browser --managed` returns to the dedicated
profile.

## Run and recover a consultation

```bash
chatgpt-consult start "Review the queue retry policy" \
  --profile lean \
  --file src/queue.ts \
  --open
chatgpt-consult status <id>
```

Poll status while the phase is `queued`, `preparing`, `awaiting_browser`, or
`awaiting_response`.

- `completed`: run `chatgpt-consult show <id>`.
- `needs_login`: run `chatgpt-consult setup browser`, finish login there, then
  run `chatgpt-consult open <id>` if the active worker did not resume.
- `needs_manual`: follow the returned recovery guidance. Do not resubmit an
  uncertain request.
- `cancelled` or `expired`: start a new request only if consultation is still
  needed.

Use `--attachment` only for explicitly approved bounded files. A follow-up with
`--open` reuses the root request's proven conversation instead of creating a
new ChatGPT chat.

The manual fallback uses the same local validation boundary:

```bash
chatgpt-consult handoff <id>
chatgpt-consult import-result <id> --input result.json
chatgpt-consult show <id>
```

Publishing remains separate and requires explicit approval:

```bash
chatgpt-consult publish <id>
```

## Legacy/optional remote MCP compatibility

The older ChatGPT-facing MCP remains loopback-only for compatibility. It is
never started by setup, doctor, a local MCP request, or the browser worker. If
this legacy path is intentionally needed, start and verify it manually:

```bash
chatgpt-consult serve chatgpt
curl --fail --silent http://127.0.0.1:43891/health
```

Its MCP URL is `http://127.0.0.1:43891/mcp`. Remote ChatGPT access requires an
authenticated HTTPS tunnel configured outside this project; never expose port
43891 directly. Follow OpenAI's current
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and enable Developer Mode only for this optional compatibility route. Confirm
the remote tool order: `request_get`, `context_search`, `context_read`,
`diff_get`, `attachment_get`, `request_complete`.
