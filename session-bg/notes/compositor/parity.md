# Backend compatibility checklist

Observed 2026-09-22. This is a release checklist, not a claim of full parity.

| Behavior | Managed Tattoy | Native Rust backend |
|---|---|---|
| Office/Lua state, hot reload, checkpoints, recovery | Existing shared engine tests | Same engine; real PTY office health check passes |
| Byte-exact batched input, Unicode, NUL, large paste | Patched input smoke passes | Native PTY smoke passes; no shortcut parsing |
| Palette/cursor requests | Managed shadow-terminal reply patch | Real terminal replies pass through; observer emits none |
| Codex shaded panel and unsent typed/pasted marker | Prior real Codex probe passes | Real Codex 0.155.1 headless probe passes |
| Claude incremental styles, cursor saves, unsent marker | Physical matrix pending | Actual Claude 2.1.278 headless probe and bounded SGR regressions pass |
| Opaque terminal output / graphics protocols | Full parity remains pending | Bytes preserved; graphics suspend painting |
| Foreground spaces, wide glyphs, saved cursor | Managed compositor fixes | Observer/renderer regressions pass |
| Initial graphic rendition | Virtual terminal starts neutral | Background mode explicitly starts neutral; passthrough-only mode adds nothing |
| Scrollback decoration | Compositor-owned | Cleared before observed scrolling; synthetic cases pass |
| Resize delivery | Existing PTY smoke | 50-resize PTY storm passes; unchanged-size notifications preserve animation |
| Resize/reflow appearance | Physical matrix remains pending | Known limitation: suspend until clear/anchor; stale decoration possible |
| Child exit, missing exec, signal/termios cleanup | Existing checks | Exit 0/1/7/130, child SIGKILL, forwarded INT/TERM/HUP and bounded escalation pass |
| Child stop/resume | Physical matrix remains pending | Termios and animation recovery pass with same/changed size; full-screen shell modes need review |
| Wrapper SIGKILL | Not checked | Outer termios stays changed in private PTY; cleanup guardian remains unimplemented |
| `SBG_STATE`, controls, automatic shims | Existing path | Same launcher/state engine; opt-in selection tests pass |
| Diagnostics | Tattoy + effect logs | Backend, observer, CPU, peak RSS, p95, skip heartbeat and painting suspension reason |
| Alt+t / Alt+s / Alt+M | Tattoy shortcuts | Passed to child; use `sbg set` and outer terminal scrollback |
| Full one-hour protocol/emulator conformance | Pending | Pending; blocks default migration |
| Physical kitty + zellij 10-minute Claude/Codex sessions | Pending release matrix | Not run |
| Windows/Linux | Existing supported platform behavior | Unix implementation; macOS tested, Linux not yet tested |

Native opacity dims glyph RGB toward black; it does not yet blend against the
actual terminal palette background. The native path has no independent minimap or GPU shaders. These are not required
for the office background, and no native equivalent is claimed. Shared task
state is in [MY-126](https://linear.app/my-perosnnal/issue/MY-126) and its children.
See [lifecycle coverage and remaining gates](lifecycle.md) for the resize/signal evidence.
