# Security model

ChatGPT Consult is a bounded local consultation bridge, not a general-purpose
repository or browser-control surface.

- **Project boundary:** selected paths are canonicalized beneath the Git
  repository. Traversal, symlinks, special files, ignored sensitive paths, and
  hidden state are rejected.
- **Context boundary:** file counts, search hits, bytes, diffs, and attachments
  have hard limits. Explicit selectors are retained; smart selection can only
  backfill the remaining budget. Active-content attachments such as HTML and
  SVG are denied.
- **Secret boundary:** likely credentials, private keys, tokens, and sensitive
  filenames are blocked by default. `allow_sensitive` is an explicit narrow
  override, not a general bypass.
- **Local MCP boundary:** Codex and Claude receive exactly six consultation
  tools. They can request and inspect work, but private completion does not
  authorize publication or another external action.
- **Browser boundary:** `agent-browser` uses loopback CDP, a dedicated managed
  Chrome profile by default, a deny-by-default action policy, canonical
  ChatGPT URLs, unambiguous controls, bounded output, and request-specific
  allowlisted upload paths. Arbitrary evaluation, downloads, cookies, storage,
  and network interception are prohibited.
- **Authentication boundary:** the user enters credentials only in headed
  ChatGPT. The worker never reads credentials, cookies, tokens, or browser
  storage, and never bypasses 2FA, CAPTCHA, or consent.
- **Conversation boundary:** one root request creates at most one Project chat.
  Follow-ups require the proven parent URL. An uncertain submission becomes
  manual recovery and is never automatically resubmitted.
- **State boundary:** requests, staged uploads, browser progress, and results
  remain under ignored private `.chatgpt-consult/` state with constrained
  permissions. Staging is verified before upload and cleaned without deleting
  immutable source blobs.
- **Network boundary:** the recommended browser-backed path binds no new
  listener and starts no remote server or tunnel. An explicitly configured CDP
  endpoint must be loopback-only.
- **Publication boundary:** curated repository files are created only after an
  explicit `publish` action.
- **Logging boundary:** diagnostics redact queries, credentials, claims, and
  local paths. Logs and acceptance evidence omit prompts, attachments, browser
  profiles, and raw consultation transcripts.

## Legacy remote compatibility

The dormant ChatGPT-facing MCP binds to `127.0.0.1`, rejects foreign Host and
Origin values, and exposes only a short-lived claimed request. Remote access
requires a separately configured authenticated HTTPS tunnel. This compatibility
server and its tunnel are optional and are never started automatically.

If they were started deliberately, stop both when finished. Remove private
request state only through deliberate local cleanup; never commit
`.chatgpt-consult/` or a browser profile.

`chatgpt-consult doctor` is non-mutating. It does not replace the workspace's
generated-manifest, Bun-global, or installed-plugin drift checks.
