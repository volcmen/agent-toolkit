# Spike log — 2026-09-16

Environment: macOS 27 / Apple M5, kitty 0.47.2, zellij 0.45.1, Claude Code
2.1.273, Codex 0.154.0, Tattoy 0.1.8 (brew), Rust 1.96.

## Headless (verified by scripts)

| Check | Result |
|---|---|
| `cargo test` (plugins) | 8 passed: determinism per seed, bounds, sparsity < 40 %, plasma coverage 3–45 %, never paints occupied cells, < 40 ms/frame at 200×60 debug, protocol shape |
| `python3 -m unittest` (launcher) | 12 passed |
| `scripts/smoke.py` | tattoy + sbg-fx in a pty for all 4 effects: plugin starts, frames render (`Rendering from plugin message` ×35 in 3 s), no plugin exit |
| `scripts/bench.py 1 6` | 200×60 @ 12 fps: tattoy 3.8 % CPU, sbg-fx 0.3 % |
| `scripts/bench.py 4 10` | 4 concurrent 200×60 @ 12 fps while the child prints 2 lines/s: tattoy 2.9 / 2.9 / 3.5 / 7.1 % (plasma highest), sbg-fx 0.1–2.4 % → ≈ 20 % of one M5 core for four panes |

## Interactive (to run in kitty; not yet observed)

Per app: `sbg matrix -- claude`, `sbg waves -- codex` in a zellij pane.

- [ ] typing, Shift+Enter (kitty keyboard protocol through Tattoy)
- [ ] paste > 3 lines
- [ ] mouse wheel / Claude fullscreen mouse scroll
- [ ] scrollback: Claude renderer mode (`/tui`), Tattoy `Alt+s`
- [ ] pane resize
- [ ] exit restores terminal (cooked mode, no leftover glyphs)
- [ ] kitty selection copy
- [ ] `Alt+t` toggles the effect off/on
- [ ] visual: glyph brightness vs. text readability; adjust `--opacity`
