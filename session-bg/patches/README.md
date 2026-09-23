# Tattoy compatibility build

The patch targets Tattoy 0.1.8, commit
`b1af54b4bc6a1ec5288f865bb4af19f09facf286`, and shadow-terminal 0.2.3.
`scripts/build-tattoy.py` owns source checksums, patch application, locked builds,
validation and atomic installation. No generated binary or vendored dependency is
committed. To revise the patch, work in a separate source checkout, regenerate
the diff, and verify it applies to both pristine pinned archives.

`tattoy-0.1.8-compat.patch` covers these boundaries:

- Native Wezterm replies now reach the PTY input channel from its writer thread.
  This replaces shadow-terminal's discarded reply buffer and its hand-written,
  zero-based cursor reply. Split OSC queries use the native parser. Palette
  replies use the same configured colors as the compositor.
- Plugin occupancy includes explicit-background spaces and reverse-video cells.
- Opaque spaces erase lower-layer glyphs during composition. Default-background
  spaces stay transparent; text contrast cannot resurrect a covered glyph.
- Raw input is framed before shortcut decoding, so each byte is forwarded once.
  Unknown sequences and streamed bracketed paste stay opaque; the original paste
  markers, Unicode and NUL bytes survive. A 40 ms ambiguity timeout releases lone
  Escape. Input reaches the proxy through a bounded, lossless queue, independently
  of the animation broadcast bus. Shadow-terminal input packets carry their
  actual length instead of treating the first zero byte as a terminator.

Regression evidence: `scripts/color-smoke.py` uses synthetic data and a real PTY,
checking paired OSC 10/11 replies, fragmented queries, a cursor-position reply,
RGB/indexed blank-cell occupancy, final RGB escape output, a single key, resize
and exit. Two patched compositor unit tests check opaque/default blank behavior.
`scripts/input-smoke.py` adds coalesced typing, split UTF-8/CSI-u, delayed paste
openers, bare Escape latency, legacy/CSI-u shortcuts, opaque OSC, invalid UTF-8,
NULs, exact 128-byte reads, a 5,000-byte unbracketed burst, and a 50 KiB bracketed
paste containing shortcut-like bytes. Parser tests vary split points, check
arbitrary-byte conservation, and assert bounded paste buffering. The full
physical-terminal support matrix remains in MY-138.

MY-176 fixes the reproduced input defect: upstream `raw_input.rs` attached an
entire read buffer to each parsed event, so one write of `hi\r` reached the child
three times. The replacement-compositor work in MY-145 still owns full terminal
mode relay and long-duration conformance; these fixtures exercise synthetic
input through the current Tattoy backend.

Source references:
[Tattoy](https://github.com/tattoy-org/tattoy/tree/b1af54b4bc6a1ec5288f865bb4af19f09facf286),
[shadow-terminal 0.2.3](https://crates.io/crates/shadow-terminal/0.2.3),
[Codex panel color fallback](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/tui/src/style.rs).
