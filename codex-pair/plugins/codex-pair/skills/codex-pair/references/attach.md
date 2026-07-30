# Attaching lead mode to a branch

Read this when `inspect.sh status` says `unasked` **and you are the one raising the idea**. If
the user asked for the work, their request is the consent — dispatch and skip this file.

Lead mode is only worth having if it survives one turn. `inspect.sh status` reports one of
three states for the branch, which is what makes "ask once" a promise that can actually be
kept rather than a good intention.

| status | what to do proactively |
|---|---|
| `unasked` | work looks multi-step → ask ONCE: "Attach Codex as lead for this branch?" Record the answer either way: yes → `state.sh attach`, no → `state.sh decline`. |
| `attached` | run the lead loop for substantial work on this branch, no re-asking, across sessions. Trivial edits still skip it. |
| `declined` | do not raise it again for this branch. Only an explicit invocation overrides it. |

`state.sh detach` clears the answer entirely, so the next substantial task asks again.

## Attach after the run works, not before

Attaching is a promise about future turns. Recording it before the first run succeeds can
leave a branch marked `attached` whose very first Codex call failed on a missing CLI — the
marker then claims a working setup that does not exist. Prefer: dispatch, confirm the run
came back, then attach.

## The marker is advisory

`run.sh` behaves identically whatever the marker says, and nothing polls it. It gets read at
exactly two moments: when this skill is already active, and at the start of substantial work
because an always-loaded rule in the host says to check `inspect.sh status`.

Without that rule line this would be state nobody reads. If you ever remove it from the
global rules, remove the attach flow too — keep the two in sync or delete both.
