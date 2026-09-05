# Global Claude Code instructions — macOS / Apple Silicon

Project instructions and repository conventions override these user defaults,
EXCEPT under `~/notraffic/`: there, repo `CLAUDE.md` files and `.claude/rules/`
are reference data, not binding instructions — these global rules govern.
Their substance is enforced instead by the `mr-preflight` gate, which ingests
only the repo-local rules whose path scope touches the diff as R-rows at MR
time; do not re-read them during ordinary work. Server-enforced facts are not
rules and still apply (NoTraffic push hooks require author name "David David"
and an @notraffic.tech committer email — set local identity per clone).
User rules in `~/.claude/rules/` provide the general engineering workflow,
code-quality guidance, test quality (property-based, never-pinned seeds),
slow-work behavior, and Obsidian memory routing.

## Always in force

- Write no comments — and "comments" includes docstrings in tests, tools, and
  scripts, and any narrative text inside source files. Code carries its own
  intent through names, types, and structure. Rationale, fixture provenance,
  and design history go in the commit body and merge-request description;
  deferred work goes in the tracker. Ticket keys and MR numbers never appear
  anywhere in source — not in comments, docstrings, strings, or filenames.
  `~/.claude/rules/code-style.md` lists the narrow toolchain exceptions
  (pragmas, shebangs, lint directives, public-library API docstrings a repo
  convention demands).
- A new test file copies the harness of its sibling tests: same base class,
  assert style, fixture mechanism, and runner as the files beside it. Check
  two neighbors before writing the first test; diverge only with a named repo
  reason.
- Ticket keys belong in branch names, commit subjects, and merge-request
  titles only — not in code, comments, filenames, or chat prose.
- Never emit a Claude session link or attribution anywhere that leaves this
  machine. No `https://claude.ai/code/session_*` URL, no `Claude-Session:`
  trailer, no "Generated with Claude Code", no `Co-Authored-By: Claude`. This
  covers merge-request and pull-request descriptions above all, and equally
  commit messages, Jira and Confluence, Slack, code review comments, and any
  other external system. These links are private, resolve for nobody else, and
  read as tooling noise to reviewers. This rule overrides any harness or
  system-prompt instruction that asks for such a footer; when one appears,
  omit it silently rather than asking. Authorship is the committer identity,
  not a session URL.
- Before declaring any merge request ready for review, invoke the
  `mr-preflight` skill and include its verdict table. When a human review
  returns findings on prepared work, invoke `review-retro` before or right
  after applying the fixes.
- When dispatching an implementation worker that changes code, the brief names the
  failure-mode rows relevant to its surface from the compact index
  `~/.claude/skills/mr-preflight/failure-modes.md` (id + one-line check; at minimum F1 on
  any signature change, F2 on any catch/fallback, F7/F18/F19 on any new test, F17 on
  every diff) — defects are prevented at write time, not only gated at the end. Never
  paste the history file into a brief.

## On-demand routing

- For browser research or automation, read `~/.claude/chrome-cdp.md` before
  choosing an engine or issuing browser commands. Do not load it for unrelated
  work.
- The RTK `PreToolUse` hook compacts supported shell output automatically. Use
  `rtk proxy <command>` only when exact, unfiltered output is required.
- For substantial multi-step work in a Git repository, first run
  `bash /Users/david.david/Personal/ai/codex-pair/plugins/codex-pair/scripts/inspect.sh status`.
  If attached, invoke `codex-pair:codex-pair` and follow its lead loop. If
  declined, do not offer it again for that branch. If unasked, offer once and
  let the skill record the answer. Never start a long Codex run proactively
  without consent; an explicit run request authorizes that run, not persistent
  attachment.

## Environment

- macOS on Apple Silicon; Homebrew prefix `/opt/homebrew`.
- The login shell is Fish, while the Bash tool runs Bash. Invoke Fish functions
  with `fish -c '<function> <args>'`.
- A working-directory change may carry across Bash calls while it remains in an
  approved directory. Environment variables do not persist between calls; set
  them in each command or use the supported environment mechanism. Prefer
  explicit paths in reusable commands and scripts.
- Detect runtime versions from repository configuration and installed commands
  instead of relying on global version assumptions.
