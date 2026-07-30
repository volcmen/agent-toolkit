---
name: codex-pair
description: "Bring Codex CLI into Claude Code as an independent second model: ask for grounded judgment, shape product direction, red-team an implementation plan, act as technical lead for a bounded slice, or review a diff. Use when the user says ask/codex pair/codex shape/codex plan/codex lead/codex review, wants a second opinion or different model, asks to red-team reasoning, needs product and technical trade-offs shaped before implementation, wants Codex to scope work that Claude implements, or wants an independent pre-push review. Offer it after 2+ failed attempts, before presenting a non-trivial plan, or before finalizing a large/risky change, but never spend a proactive run without consent. Not for remote PR inline comments, Codex-authored code, CLI setup/auth, trivial lookups, or decisions that require the user's personal preference."
argument-hint: "ask|shape|plan|lead|review|attach|detach|status|show|reset [-t topic] [--fresh] <prompt…>"
---

# codex-pair

Claude Code-first Codex second brain. One persistent Codex thread per (mode, topic); topic defaults
to the current git branch, so the same piece of work naturally continues one discussion.
State lives in `~/.claude/codex-pair/state/<project-slug>/` — nothing in the repo.

Every mode is read-only: **Codex thinks, Claude writes.** Claude Code is always the outer
loop. `lead` inverts *authority*, not the runtime: Codex holds scope and sign-off while
Claude holds the keyboard. Want Codex to author code instead? That is
the official plugin: `/codex:rescue --background`.

## Paths — resolve once, use everywhere

In Claude Code, resolve the installed plugin rather than assuming a checkout path:

```bash
S="$CLAUDE_PLUGIN_ROOT/scripts"
```

`inspect.sh` is free and read-only (`show`, `status`, `list`) and may be pre-approved by the
host. `state.sh` mutates local thread/attachment state (`reset`, `attach`, `decline`,
`detach`) and must not inherit that blanket permission. `run.sh` deliberately still prompts,
because it spends a Codex run.

## Dispatch

**Who raised the idea decides whether you need permission.** This is the one distinction
that matters, and getting it wrong is the most common failure — either burning a turn
asking about a decision the user already made, or spending an expensive run they never
agreed to.

**The user asked** — they described work a mode does ("look at my diff", "which of these
should I pick", "scope this out", "is this safe to push"), named a mode, or named the
skill. **Their request is the consent.** Dispatch now: no menu, no "shall I", no confirming
the spend. Auto-triggering on their phrasing counts — they do not have to say "codex" for
this to be their idea. Asking here spends a turn on a question they already answered.

**You noticed** — they asked for something else and you think a second model would help.
That is proactive: ask once before spending an xhigh run, then record the answer
(`state.sh attach` / `state.sh decline`) so you never re-ask on this branch. See
`references/attach.md`.

Then pick the mode from evidence, first match wins:

| evidence | mode |
|---|---|
| the user named a Codex run mode (`ask`/`shape`/`plan`/`lead`/`review`) | that run mode |
| the user named a state command (`attach`/`detach`/`status`/`show`/`reset`) | use `state.sh` or `inspect.sh`; if they also requested work, then dispatch its run mode |
| the request is deciding what outcome or product direction to pursue | `shape` |
| request names a plan/design file, or describes a plan not yet built | `plan` |
| `git status --porcelain` non-empty **and** `inspect.sh show lead` has a spec for this topic | `lead -p review.md` |
| `git status --porcelain` non-empty, no spec exists | `review` |
| tree is clean and the request is a goal to build | `lead` (turn 1: spec) |
| a question, an opinion, or a judgement call | `ask` |
| nothing else fits | `ask` |

State the choice and its reason in one line, run it, and keep working.

**If the mode does not fit, downgrade it — do not stop and ask.** A `lead` spec for a
one-file change costs more than the change; say that in one line and use `ask`, or just do
the work. The user asked for progress, not for a permission dialog. Reserve questions for
when the *goal* is genuinely unknown — never for which mode to use.

**Self-correct without being told.** Exit 69 → report the missing CLI; never review the work
yourself and present it as reviewed. `REQUEST_CHANGES` → run the verdict loop. Findings you
verify as wrong → push back in a resume call rather than obeying them.

## Modes

| mode | model/effort | run as | what it does |
|---|---|---|---|
| `ask` | gpt-5.5 / high | blocking, `timeout: 300000` | grounded second opinion |
| `shape` | gpt-5.6-sol / xhigh | **`run_in_background: true`** | product/technical shaping before implementation |
| `plan` | gpt-5.6-sol / xhigh | **`run_in_background: true`** | red-team a plan Claude wrote |
| `lead` | gpt-5.6-sol / xhigh | **`run_in_background: true`** | Codex authors a slice spec, then reviews the diff against it |
| `review` | gpt-5.6-sol / xhigh | **`run_in_background: true`** | adversarial review of a diff |

`shape` decides what outcome and slice are worth pursuing. `plan` reviews a design Claude
drafted. `lead` assumes the direction is decided and has Codex author the technical spec.

## Invocation

```bash
bash $S/run.sh ask "Should retries live in the client or the queue? My position: queue, because X. Red-team it."
bash $S/run.sh shape "Shape the next useful export workflow increment; compare user value and reversibility."
bash $S/run.sh plan "Review the plan at ~/.claude/plans/foo.md — target repo is this cwd"
bash $S/run.sh lead "Add cursor pagination to the export API"          # turn 1: spec
bash $S/run.sh lead -p review.md "Slice implemented. Targeted checks pass: 12 tests, tsc clean."
bash $S/run.sh review "Diff implements the pagination plan; gate: lint clean, 42 tests pass"
bash $S/inspect.sh show lead                                           # re-read last result, no Codex run
bash $S/state.sh reset ask                                             # drop thread, next call starts fresh
bash $S/inspect.sh status                                              # attached / declined / unasked
```

- Flags: `-t <topic>` names the thread (default: git branch); `--fresh` forces a new thread;
  `-p <template>` reframes one turn without splitting the thread — that is how `lead`
  switches from speccing to reviewing.
- **Run shape/plan/lead/review with `run_in_background: true`.** xhigh takes minutes; a blocking
  call stalls the session for nothing. Keep working and read the result when the completion
  notification arrives. `ask` runs blocking — it is the fast model.
- **A silent background run is normal.** xhigh can sit inside one API response for minutes
  emitting nothing. A timeout is a hang guard, not a reasoning budget: never kill and
  restart a run to "make progress" — resuming loses the cache and costs more. A growing
  `.events.jsonl` proves the run is alive; a static one proves nothing, because a single
  long response produces no events either. There is no cheap hang test — just wait.
- **In `ask`, state your own position and invite disagreement.** Codex agreeing with a vague
  question proves nothing; a stated position gives it something concrete to attack, which is
  the only reason the run is worth its cost.

## Lead loop

Codex is tech lead; Claude is the sole code author. One slice per loop.

1. **Spec** — `run.sh lead "<goal>"` (background). Codex returns Slice / Allowed files /
   Do NOT touch / Invariants / Steps / Targeted checks / Project verification / Acceptance
   criteria / Deferred.
2. **Sanity-check the spec** before writing anything. It is a spec, not scripture — if a step
   is wrong against the code, push back in the same thread rather than building something
   you know is broken.
3. **Build** — implement it yourself, strictly inside Allowed files. If something outside
   that list turns out to be necessary, say so at review time; never widen scope silently.
4. **Check** — run the spec's targeted checks as you go, then its ONE project verification
   command at the end. Skip re-running the full suite after doc-only edits.
5. **Review** — `run.sh lead -p review.md "<what you built + check results>"` (background).
   Same thread, so Codex reviews against the spec it authored. If the slice added files, make
   them visible to `git diff` first with `git add -N <those paths>`, naming the paths from
   Allowed files — never `git add -N .`, which drags build output in and burns findings on
   `__pycache__`.
6. **Correct** — fix legitimate findings and re-review, capped at 2 rounds. Keep using the
   same lead topic; the engine persists the review phase and original spec. Then commit and
   report the next slice boundary. Do not open an open-ended ping-pong.

## Verdict loop (plan + review, incl. `lead -p review.md`)

Parse the trailing `VERDICT:` line:

- `APPROVED` — done, tell the user.
- `REQUEST_CHANGES` — verify each finding at its `file:line` yourself; fix legitimate ones;
  push back on wrong ones in a resume call ("Fixed X. Pushed back on Y because Z."); then
  re-review. Cap at 2 correction rounds, then surface what is still open rather than grinding.
- `NEEDS_REWORK` — stop; surface to the user before any mass edits.

`ask` and the `lead` spec turn carry no verdict. Surface Codex's answer verbatim **when it
disagrees** with your position — disagreement is the signal; agreement is weak evidence.

## Consuming output

- Read the script's stdout ONLY. **Never read `*.events.jsonl`** — raw event noise.
- Output is capped at 10KB; if truncated and the detail matters, Read the `.out.md` path from
  the truncation trailer with an offset.
- Follow-ups: call `run.sh` again with the same mode+topic and it resumes the same thread.
  Only a confirmed missing/expired thread self-heals with one fresh restart. Other failures
  preserve the thread and stop. Lead mode also persists the spec and current phase so a
  recovered review cannot silently become a new spec turn.
- The header ends with the run's cost: `fresh=<input minus cache hits> cached=<hits>
  out=<output>`. `fresh + out` is the number to compare between runs — if one bounded slice
  passes roughly 250k, say so and find what made it expensive before starting the next.

## When NOT to call

- Trivial lookups, or anything settled by reading the code yourself.
- Questions needing the USER's preference or judgement — ask the user, not Codex.
- Small routine diffs; never as an unrequested gate on your own work.
- `lead` on a one-file change — downgrade per Dispatch rather than stopping to ask.
- Never launch an xhigh run (shape/plan/lead/review) **you** thought of without the user's ok.
  When the user asked for the work, that ok already exists.

## Attachment means persistent consent

A user request for `ask`, `shape`, `plan`, `lead`, or `review` authorizes that run only. It
does not attach Codex to future work. Persist `attached` only when the user explicitly says
attach/stay lead/for this branch, or answers yes to the proactive attachment question. This
keeps one-run consent from silently becoming standing authorization for future xhigh spend.

## Further reading

- `references/attach.md` — the proactive attach question, its tri-state, and why the marker
  is advisory. Read when `inspect.sh status` says `unasked` and you are the one raising it.
- `references/operations.md` — plan-mode workflow, per-run model overrides, exit codes, and
  recovery. Read when a run fails or you are in Claude Code plan mode.
