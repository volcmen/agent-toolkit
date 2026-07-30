# codex-pair

Codex CLI as Claude Code's independent second model: product shaper, grounded adviser,
plan red-teamer, technical lead, and diff reviewer. Claude remains the outer loop and sole
code author.

One persistent Codex thread per `(mode, topic)`; topic defaults to the current git branch,
so a piece of work naturally continues one discussion instead of re-explaining itself.
State lives under `~/.claude/codex-pair/state/<project-slug>/` — never in the repo you are
working on.

```
ask     read-only  gpt-5.5      / high    grounded second opinion, no verdict
shape   read-only  gpt-5.6-sol  / xhigh   shape outcomes/options before implementation
plan    read-only  gpt-5.6-sol  / xhigh   red-team a plan the calling agent wrote
lead    read-only  gpt-5.6-sol  / xhigh   author a slice spec, then review the diff against it
review  read-only  gpt-5.6-sol  / xhigh   adversarial review of a diff
```

## Lead mode — authority inversion

Codex cannot drive Claude Code or any other agent host; the caller is always the outer
loop. What `lead` inverts is *authority*, not the runtime: Codex holds scope and sign-off,
the calling agent holds the keyboard.

```
run.sh lead "<goal>"                         turn 1 ─▶ slice spec
   │        Slice · Allowed files · Do NOT touch · Invariants · Steps
   │        Targeted checks · ONE project verification · Acceptance criteria · Deferred
   ▼
the calling agent implements, inside Allowed files only
   │
   ▼
run.sh lead -p review.md "<built + check results>"    same thread ─▶ reviews its own spec
            VERDICT: APPROVED | REQUEST_CHANGES | NEEDS_REWORK
```

Both turns share one Codex thread. That is the whole point — a reviewer that authored the
spec catches scope drift a fresh reviewer cannot see. Turn framing is switched with
`-p <template>` rather than by changing mode, because state is keyed on `(mode, topic)`
and a second mode would mean a second thread with no memory of the spec.

`state.sh attach` records that a branch is under Codex lead so the loop survives a session,
and `detach` ends it. A request for one Codex run does not create this standing attachment;
the user must explicitly ask to attach or accept a proactive attachment offer. The marker is
advisory — the engine ignores it. It works only because an always-loaded rule in the host's
global instructions checks `inspect.sh status` when
substantial work starts; a marker read by nothing would be dead state.

Each result header ends with what the run cost: `fresh=<input minus cache hits>
cached=<hits> out=<output>`. `fresh + out` is the figure to compare between runs.

Every mode is read-only: **Codex thinks, the caller writes.** For Codex-authored code, use
OpenAI's own plugin (`openai/codex-plugin-cc` → `/codex:rescue`) instead; this plugin
deliberately does not compete with it.

## Layout

```
plugins/codex-pair/
  skills/codex-pair/SKILL.md      when to call, how to consume output, verdict loop
  skills/codex-pair/agents/       Codex interface manifest
  prompts/<mode>.md               role prompt per mode; followup.md for resumed turns
  scripts/run.sh                  start or resume a thread, emit a capped result
  scripts/inspect.sh              read-only result/status inspection, safe to pre-approve
  scripts/state.sh                reset threads and mutate branch attachment
  scripts/_lib.sh                 state paths, per-mode model/effort, output capping
scripts/check.sh                  offline checks: static + engine e2e vs a fake `codex`
```

`_lib.sh` locates the prompts relative to its own path, so the engine runs identically from
this checkout or from an installed plugin cache copy, with no dependence on
`CLAUDE_PLUGIN_ROOT` being exported.

## Requirements

`codex` CLI on PATH and authenticated (`codex login`), plus `jq` for thread-id extraction.
Verified against codex-cli 0.145.0.

## Checks

```bash
bash scripts/check.sh          # from this directory
```

Offline, not merely static. Alongside the static checks — shell syntax, prompt/mode parity,
verdict blocks, argument guards, and a regression guard for the `-C` bug below — the suite
drives the real engine against a **fake `codex` binary** and asserts the thread lifecycle
end to end: fresh runs capture the thread id, follow-ups resume that same thread through
`followup.md`, a dead thread falls back to exactly one fresh start, a malformed events file
still yields the answer, and capped output stays valid UTF-8 inside the 10 KB limit.

Further groups guard the things nothing else notices: prompt contracts (`ask`, `shape`, and
the `lead` spec turn emit no verdict; `shape` and `lead` forbid implementation code; every
role demands `file:line` citations), SKILL.md-vs-engine drift, conservative resume recovery,
lead phase/spec persistence, truthful model metadata, topic isolation, the exact read-only
`inspect.sh` permission, and the read-only invariant across all five modes.

It spends no Codex run, makes no network call, and redirects `$HOME` to a temp directory so
it never touches your live `~/.claude/codex-pair/state` — safe in CI and safe to run while a
real thread is open.

## Releasing a change

Claude Code serves the installed **cache copy**, not this checkout, so editing a file here
changes nothing until you push it out. Versions are pinned at `1.0.0` across the workspace —
this marketplace is a local directory and nothing consumes the version — so the refresh is
content-driven, not version-driven:

```bash
bash scripts/check.sh                                    # from this directory
cd .. && python3 scripts/plugins.py check                # whole workspace
python3 scripts/plugins.py install --force               # then start a new thread
python3 scripts/plugins.py status                        # `content` must read ok
```

`--force` uninstalls and reinstalls so edited files land with the version unchanged; plain
`install` cannot, because both `claude plugin install` and `claude plugin update` no-op when
the version already matches. `status` compares the live cache byte-for-byte against this
checkout and exits nonzero on drift, so a forgotten `--force` fails loudly instead of
silently serving stale code.

## Gotchas worth remembering

`codex exec resume` accepts **no** `-C/--cd`, unlike `codex exec`. Passing it exits 2.
Likewise, only an error that explicitly identifies a missing or expired thread may restart
fresh; treating authentication, quota, model, or transient failures as stale silently loses
lead context. `check.sh` guards both contracts.

`claude plugin install` exits 0 as a no-op when the plugin is already installed, so it never
upgrades. A version bump only reaches the cache via `claude plugin update` (which is why
`plugins.py install` now runs it unconditionally, and why `status` prints `repo` beside
`live`).

## Inspiration

The slice discipline — one vertical slice, an explicit allowed-files contract with
exclusions, targeted checks during plus exactly one project verification at the end, a
bounded correction round, hang-guard separate from reasoning budget, and per-run token
accounting — is adapted from a Codex-plans / cheap-model-writes skill. Deliberately not
ported: line-ending repair discipline (this reviewer is read-only and cannot write files)
and a standalone usage-reporting script (the useful part is one line in the result header).
