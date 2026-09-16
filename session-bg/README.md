# session-bg

Animated, per-pane ASCII/UTF-8 backgrounds for terminal AI sessions (Claude
Code, Codex, or anything else) running inside zellij on kitty. Each pane gets
its own effect and seed; the animation only ever paints cells the application
left empty, so the UI stays readable and input passes straight through.

Built on [Tattoy](https://tattoy.sh) (text-based terminal compositor). This
project adds a CPU-only effects plugin, per-pane configs, a launcher, and a
zellij layout.

```
zellij pane ──▶ sbg auto -- claude
                 └─▶ tattoy --main-config <rendered> --command claude
                        ├─▶ shadow terminal (headless wezterm) runs claude
                        └─▶ plugin sbg-fx (env SBG_EFFECT/SBG_SEED) paints empty cells
```

## Install

```sh
brew install tattoy-org/tap/tattoy          # v0.1.8+
cd plugins && cargo build --release          # builds plugins/target/release/sbg-fx
ln -s "$PWD/../bin/sbg" ~/.local/bin/sbg     # or add bin/ to PATH
sbg palette                                  # palette.toml from ~/.config/kitty/current-theme.conf
```

`sbg palette` writes Tattoy's `palette.toml` from your kitty theme so the first
run needs no interactive palette capture. Outside kitty, run
`tattoy --capture-palette` once instead.

## Use

```sh
sbg -- claude                    # effect chosen from ZELLIJ_PANE_ID (stable per pane)
sbg matrix -- claude --resume    # explicit effect
sbg waves --fps 15 --opacity 0.5 -- codex
sbg --list                       # matrix plasma waves stars
zellij -l zellij/claude-quad.kdl # four claude panes, one effect each
```

Effects: `matrix` (katakana rain), `plasma` (braille field), `waves` (block
surface + foam), `stars` (twinkle + shooting stars). Defaults: 12 fps, layer
-5, opacity 0.6, glyphs at 35–55 % brightness of the Tokyo Night palette.

Tattoy keys: `Alt+t` toggle effects, `Alt+s` scrollback mode (`Esc` exits),
`Alt+M` minimap. Shader cycling is moved to `Alt+Shift+(` / `)` so zellij's
`Alt+9/0` tab bindings keep working.

Environment overrides: `SBG_FPS`, `SBG_OPACITY`, `SBG_DENSITY` (0.1–3.0),
`SBG_LOG_LEVEL` (writes `~/.cache/sbg/tattoy.log`), `SBG_FX` (plugin path),
`SBG_TATTOY_CONFIG_DIR`, `SBG_KITTY_THEME`.

## How the plugin works

`sbg-fx` speaks Tattoy's JSON plugin protocol on stdio. Tattoy sends
`pty_update` messages (all non-blank cells) whenever the application draws;
the plugin keeps an occupancy grid and, on its own 12 fps clock, emits one
`output_cells` frame containing only glyphs on free cells. Tattoy composites
that layer behind the terminal text at the configured opacity. Frames are
sparse (≤ 40 % of the grid by test) so JSON traffic stays small.

`SBG_PREVIEW=30 SBG_EFFECT=waves COLUMNS=90 LINES=20 plugins/target/release/sbg-fx`
prints one frame as plain text for quick inspection.

## Checks

```sh
python3 scripts/check.py       # cargo build/clippy/test, launcher unittest, headless smoke
python3 scripts/smoke.py       # tattoy + plugin inside a pty, verifies frames render
python3 scripts/bench.py 4 10  # CPU of 4 concurrent instances at 200x60
```

## Caveats

- Claude Code's classic (inline) renderer: Tattoy owns the scrollback, so use
  `Alt+s` instead of zellij's scroll mode. The fullscreen renderer
  (`/tui fullscreen`) and Codex (alt-screen) are unaffected.
- Tattoy does not yet forward OSC 52 (clipboard) — kitty's native selection
  copy still works.
- Tattoy splits `--command` on whitespace; arguments containing spaces are
  rejected by `sbg`.
- zellij does not forward focus events, so unfocused panes keep animating.
