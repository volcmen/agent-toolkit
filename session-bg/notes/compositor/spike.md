# Native backend spike — 2026-09-22

`plugins/sbg-term` is a working opt-in Unix backend. Build both binaries with
`cargo build --release --workspace --locked` from `plugins/`, then launch
`sbg --backend own -- codex` or `sbg --backend own -- claude`.

It forwards the child's arguments, bytes, exit status, terminal queries and
responses directly. It uses in-process effects, sleeps in `poll` between events,
caps frames at 64 KiB, limits queued native traffic, and excludes inherited
unknown cells from the background. CPU, peak RSS, renderer p95, emitted frames,
skipped painting opportunities, painting suspension reasons and observer identity are available through
`sbg doctor` / the pane's `backend.json` heartbeat.
The shared render guard uses thread CPU cost on macOS/Linux, so host stalls do
not trigger an expensive fallback/reload cycle; runtime retains elapsed timing.

Normal exit, exec failure, handled signals and unwinding restore outer termios through
RAII. Observed leaked cursor, alternate-screen, paste, focus, mouse and keyboard
stack modes are unwound at exit. A stopped child stops the wrapper with termios
restored; resume forwards SIGCONT and the current size, then requests a fresh
redraw with SIGWINCH even if dimensions stayed the same. Suspension while a
full-screen application owns terminal modes still needs physical-shell review.
SIGKILL of the wrapper cannot run its RAII cleanup; a private PTY probe confirms
outer termios remains changed. A cleanup guardian is still needed for that gate.

The implementation intentionally differs from the original task's tentative
two-relay-thread design: one bounded poll loop coordinates observation,
backpressure, signals and rendering without concurrent writes to the terminal.
See [the architecture decision](adr-0001-shadow-terminal.md).

Repeatable checks:

```sh
cargo test --manifest-path plugins/Cargo.toml --workspace --locked
cargo clippy --manifest-path plugins/Cargo.toml --workspace --all-targets --locked -- -D warnings
python3 scripts/term-smoke.py
python3 scripts/check.py
```

The real PTY suite covers byte-exact binary/Unicode input and native output,
large paste, more than 3 MiB of output with backpressure, native palette/cursor
queries and replies, resize delivery, exit codes, missing executables, signal
cleanup, stop/resume, fragmented UTF-8/OSC, and the existing office Lua host.
Renderer tests cover shaded/wide cells, saved cursor/style, partial updates,
scrolling erasure, inherited text and resize suspension. Incremental SGR styles
are compacted by attribute; 5,000 updates remain bounded while restoring the
correct style. ESC/CSI cursor saves and separate alternate-screen save slots
are observed without borrowing the application's saved register.

An optional actual Codex or Claude probe starts its TUI, types and pastes a marker without
pressing Enter, and quits. It uses an outer headless terminal fixture, not a real
kitty/zellij window:

```sh
cargo build --release --manifest-path plugins/Cargo.toml -p sbg-term --example observe
python3 scripts/term-codex-smoke.py --codex /path/to/real/codex
python3 scripts/term-codex-smoke.py --claude /path/to/real/claude
```

The visible-animation follow-up probes on Codex 0.155.1 and Claude 2.1.278 each
showed exactly one copy of the typed/pasted marker. Their lower free area changed
128 and 52 glyphs respectively over 2.1 seconds; Codex retained 306 shaded spaces.
Both exited and restored termios; no prompt was submitted. The
fixture waits for interactive paste mode before typing and removes an inherited
`NO_COLOR=1`; the launcher respects the user's color environment. These probes
use the same terminal library as the passive observer, so they do not replace
independent terminal parity checks. Metrics are in [performance.md](performance.md).

Initial prototype validation on 2026-09-22: the complete `python3 scripts/check.py` gate passed,
including 54 Rust tests, 11 native PTY scenarios, 126 Python tests, state/recovery
and Fortress protocol checks, Lua properties/goldens/replays, and managed Tattoy
color/input compatibility. Release Clippy is warning-free. The final exit guard
also avoids signaling the old leader PID after it has been reaped; the final
build, Clippy, Rust and native PTY checks were repeated after that refinement.

The subsequent visible-animation follow-up passed the full root
`python3 scripts/plugins.py check`: 1,721 tests in 787.373 seconds, including all
seven projects. This supersedes the earlier failed umbrella result.

The next lifecycle slice preserves painting and overlay ownership for unchanged
dimensions, handles pending resize signals before observing a simultaneous redraw,
and invalidates saved anchors plus each screen buffer after a real resize.
Its final full workspace gate passed 1,721 tests in 816.568 seconds, including
13 native Rust tests and 16 real PTY tests. The repeated
resize fixture protects colored spaces, wide glyphs, cursor and style, including
fragmented escape/UTF-8 bytes. See [lifecycle.md](lifecycle.md) for exact coverage
and remaining acceptance criteria.

Unfinished release gates: physical kitty and kitty/zellij sessions for both
Claude and Codex, one-hour independent emulator/recording parity, resize/reflow
artifact repair, full mode restoration during shell job suspension, and Linux
validation. Existing terminal sessions are untouched; Tattoy stays the default.
