# Native lifecycle follow-up — 2026-09-22

Tracked in [MY-146](https://linear.app/my-perosnnal/issue/MY-146). This improves the
opt-in native backend; it does not complete the default-migration gate.

## Fixed

An unchanged-size WINCH notification previously discarded overlay ownership
and suspended painting until a full-screen clear. A quiet application might never
redraw, leaving the background frozen indefinitely. Identical dimensions now
preserve the cursor, occupancy and painted-cell cache.

A real resize invalidates both primary and alternate screen buffers and their
saved cursor anchors. Clearing the alternate screen no longer silently trusts
the primary screen's old reflowed contents. Pending signals are applied before
native output from the same poll wakeup, so a fresh redraw is not immediately
invalidated afterward.

After an actual stop, another job may have changed the display. Resume therefore
still invalidates it, forwards the new size and SIGCONT, and requests a redraw
with SIGWINCH. SIGCONT requests the same fresh redraw after an external SIGSTOP;
unchanged dimensions alone do not prove that the display was untouched while
stopped. Resume also reapplies raw, nonblocking I/O in case another job restored
canonical input while it was stopped. Once the child clears and anchors its screen,
animation recovers.

## Observed coverage

`cargo test -p sbg-term --locked --offline` and `python3 scripts/term-smoke.py`
pass. The PTY suite has 16 tests, with subcases for sizes, statuses and signals.

Final full workspace validation also passed: `python3 scripts/plugins.py check`
reported 1,721 tests in 816.568 seconds, all seven projects green. This includes
the final resume/input refinement, release Clippy, native/Python suites, scene
properties/goldens/replays, and managed Tattoy color/input compatibility.

The first umbrella run failed the existing concurrent-hook event-count test
(19 events versus 24 expected). Its isolated rerun and final full gate passed;
no hook code, timeout or assertion was changed here. The cause of that intermittent
failure remains unconfirmed. Local logs: `/tmp/sbg-lifecycle-workspace.log` and
`/tmp/sbg-lifecycle-workspace-final.log`.

| Scenario | Result |
|---|---|
| 50 unchanged-size notifications paced over 2 seconds | Animation continues while child emits no further output; overlay ownership retained |
| 50 distinct sizes paced over 2 seconds | Every complete native redraw arrives once; byte totals match; animation recovers after final quiet redraw |
| Shadow/outer grid after 50 resizes | Foreground cells, explicit background spaces, Unicode, cursor and style match after painting/clearing |
| Saved ESC/CSI/DEC cursor registers after resize | Old positions cannot authorize painting |
| Resize in alternate screen, then return to primary | Each buffer requires its own clear and fresh anchor |
| Child stop/resume at same and changed size | Termios restored while stopped; redraw requested; animation resumes |
| External SIGSTOP/CONT with display/input changes while stopped | Restores raw input and requests a fresh redraw before trusting the display again |
| Exit 0, 1, 7, 130; missing executable | Status propagated; missing exec returns 127; termios restored |
| Child SIGKILL | Wrapper returns 137 and restores termios |
| Forwarded SIGINT, SIGTERM, SIGHUP | Correct status and observed terminal-mode cleanup |
| Child ignores SIGTERM | Escalates to SIGKILL; bounded fixture exits and restores termios |

The grid fixture uses the same pinned Alacritty observer library as the backend.
These results cover controlled redraws, not independent physical-terminal reflow.
The storm is paced at 40 ms per resize, allowing slower scheduling on loaded hosts.

Real app startup/input probes after these changes also pass: Claude and Codex
each show one unsent typed/pasted marker and visible animation (14/128 changed
lower-body glyphs over 2.1 seconds). Codex retains 306 shaded spaces. These probes
check app compatibility; the synthetic fixtures above exercise resize/resume.
Raw results: [Claude](measurements/2026-09-22-claude-lifecycle.json),
[Codex](measurements/2026-09-22-codex-lifecycle.json). No prompt was submitted.

## Remaining acceptance gates

- **Wrapper SIGKILL:** a private nested-PTY probe returned -9 and left outer
  termios changed. The fixture restored its own attributes afterward. Killing
  the wrapper prevents its cleanup code from running; a separate guardian or
  supervising launcher is needed. [Raw result](measurements/2026-09-22-wrapper-sigkill.json).
- **Reflow artifacts and incremental redraw:** old decoration can remain until
  a full clear. Apps which redraw only selected lines can leave painting suspended.
  Recognized recovery is CSI 2 J, RIS, or entering a cleared alternate screen,
  together with a fresh cursor anchor. Unknown content must remain protected.
- **Shell job control:** full-screen modes while stopped, terminal/multiplexer
  behavior and independent kitty/zellij appearance still need review.
- **Platform coverage:** macOS tested; Linux lifecycle and terminal matrix pending.

The updated binary is used by new native sessions. No existing user session was
restarted, and Tattoy remains the default.
