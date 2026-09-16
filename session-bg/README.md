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

`scripts/install.sh` builds the plugin if needed and runs `sbg install`, which
links `~/.local/bin/sbg` and the PATH shims `~/.local/share/sbg/shims/{claude,codex}`
so plain `claude` and `codex` open inside sbg automatically (see below).

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

## Automatic wrapping (PATH shims, shell-agnostic)

`sbg install` symlinks `claude` and `codex` in `~/.local/share/sbg/shims/` to
`bin/sbg-shim`. Put that directory first on PATH (after every other PATH edit in
your shell init; fish: `fish_add_path --path --move --prepend ~/.local/share/sbg/shims`).
The shim finds the real binary further down PATH and runs
`sbg auto -- /real/path/claude <args>` for interactive sessions. It executes the
real binary unchanged when: stdin/stdout is not a TTY, `-p/--print/--version/--help`
is present, the first word is a batch subcommand (`claude mcp`, `codex exec`, …),
`SBG_AUTO=0`, or the shell is already inside an sbg session (`SBG_ACTIVE`).
`SBG_THEME=waves` forces one effect. Prompts with spaces work: `claude "fix the
tests"` is wrapped through a generated script in `~/.cache/sbg/`.

No shell functions or aliases are involved, so `command -v claude`, scripts, and
hooks all see the shim; `SBG_AUTO=0 claude` or `~/.local/bin/claude` bypass it.

## Troubleshooting

`sbg doctor` prints the tattoy/plugin/palette/shim state, PATH order, `which
claude`, and the tail of `~/.cache/sbg/tattoy.log` (default log level `warn`).
When tattoy exits within 5 s or with a non-zero status, `sbg` prints the exit
status, the exact command, and the new log lines to stderr before returning.

## Live state: hooks, context usage, `sbg set`

Every launch creates a pane directory (`SBG_STATE`, default
`~/.cache/sbg/panes/<pane>`) that `sbg-fx` polls each frame. Three writers,
one file each, atomic renames, no locks:

| File | Writer | Content |
|---|---|---|
| `session.json` | `plugin/scripts/sbg_state.py` (Claude Code + Codex hooks) | `mode` (`start idle thinking tool waiting error compacting end`), `tool`, `tool_kind`, `subagents`, `prompt`, `seq` |
| `status.json` | claude-core `statusline.py` (Claude only) | `context_pct`, `tokens`, `context_size`, `cost_usd`, `model`, `branch` |
| `override.json` | `sbg set` / the `/bg` skill | `effect`, `script`, `mode` pin, `frozen`, `enabled`, `params.{density,speed,hue,opacity,palette}` |

Default reaction (ceilings: speed 0.25–3, brightness ≤ 1.35, sparsity ≤ 40 %):
context 0→100 % warms the hue and raises density; `thinking` speeds up; `tool`
gives a short burst tinted by tool kind; `waiting` (permission or idle prompt)
slows down and pulses brighter; `error` flashes red and fades; `compacting`
dissolves; `idle` calms; subagents add density. Hooks are edge events, so
`tool` decays to `thinking` after 20 s and everything decays to `idle` after
120 s. Effects switch instantly when `override.json.effect` changes.

```sh
sbg set effect=stars density=0.6 hue=0.1   # live, from any shell in the pane
sbg set mode=waiting                       # pin a mode; `sbg set mode=` unpins
sbg set enabled=false                      # blank the background
sbg state                                  # merged view of the three files
```

The hooks ship as the `session-bg` plugin of the `ai-workspace` marketplace
(`~/Personal/ai/plugins.json`), one `hooks/hooks.json` for both agents; the
hook script exits immediately when `SBG_STATE` is unset, so sessions outside
sbg pay nothing.

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
- zellij does not forward focus events, so unfocused panes keep animating.
