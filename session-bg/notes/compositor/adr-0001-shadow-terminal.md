# ADR 0001: a native PTY relay with passive terminal observation

Status: accepted for an opt-in prototype, 2026-09-22. Task authority:
[MY-126](https://linear.app/my-perosnnal/issue/MY-126).

The user explicitly requested an independent Rust backend after observing
Tattoy's resource use. A live, uncontrolled sample showed roughly 80% of one
core in Tattoy plus 20% in its effect process. This was a symptom to investigate,
not a controlled benchmark or a universal Tattoy baseline.

Use `libc::forkpty`, nonblocking file descriptors and one `poll` loop on Unix.
Prepare arguments before fork; the child uses only libc operations before exec.
This directly covers the current macOS environment, keeps the relay bounded,
and avoids introducing an asynchronous runtime. `portable-pty` would improve
platform coverage but does not remove the need to handle signals, terminal
state and flow control; Windows is outside this first slice.

Use `alacritty_terminal` 0.26.0 with zero history and a `VoidListener` as a
passive occupancy/damage observer. Native application output goes to the real
terminal unchanged, and real terminal responses go back to the child unchanged.
The observer never answers queries, negotiates keyboard modes or owns clipboard
traffic. This avoids reimplementing the terminal protocols recently repaired
in Tattoy. The initial cursor probe occurs before spawning the child; unrelated
input is retained, and inherited screen cells stay occupied until explicitly
written or erased.

Background mode explicitly sets neutral SGR before the child starts. This
establishes a known rendition for clients such as Claude that reset individual
attributes without ever emitting SGR 0. Existing cells and the saved-cursor
register are preserved. `--no-background` emits neither this reset nor a probe.

The shared `sbg_fx::engine::Engine` owns effects, Lua, state polling, recovery,
hot reload, foreground protection and checkpoints. Tattoy retains its JSON
protocol adapter; `sbg-term` calls the same engine directly.

Painting uses bounded synchronized ANSI diffs on known blank cells. Explicit
background spaces, underlines, wide glyphs, hyperlinks, the cursor and last
column are protected. Restore the cursor with CUP and replay bounded SGR
history; do not borrow the application's saved-cursor register. Track application
cursor/style saves independently for the main and alternate screens. Compact
known SGR attributes while retaining bounded exact history for unknown extensions.
Before native
output, clear only the affected overlay cells using the observer's damage
information. Full damage/scrolling and uncertain framing clear the entire
overlay first. This prevents decoration entering scrollback without repeatedly
repainting an unchanged office for unrelated app updates.

The event loop keeps simulation ticks and health updates running during busy
output. It drops painting opportunities under backpressure instead of building
an animation queue. Input and native output remain lossless. An explicit
`--no-background` path supports byte-exact relay checks.

The shared effect guard measures render-thread CPU time on macOS/Linux, with
the previous wall-clock fallback elsewhere. Host scheduling stalls otherwise
look like expensive Lua and trigger repeated throttle/fallback/reload cycles.
Runtime reports retain both CPU and elapsed render times; the guard thresholds
are unchanged. Actual expensive scripts still consume the CPU budget.

This choice is provisional with respect to cross-emulator fidelity. The native
terminal, rather than the observer, owns reflow; decoration can change its line
lengths. Resize therefore suspends painting until a clear/absolute anchor;
old decoration may remain until the child redraws. Unknown graphics, legacy
charsets and untracked left/right margins suspend painting. These limitations
block changing the default. No one-hour recording comparison or 99.5% grid
parity result is claimed.

Alternatives retained for evaluation: a complete virtual-terminal compositor
with explicit protocol routing; the existing WezTerm observer used by Tattoy;
`vt100`; and a terminal-native graphics/background integration. A complete
compositor could control resize/reflow more precisely but would again need to
translate or relay every application/terminal protocol correctly.

Primary references: [Alacritty Term API](https://docs.rs/alacritty_terminal/0.26.0/alacritty_terminal/term/struct.Term.html),
[xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html),
and the pinned dependency source exercised by the tests.
