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

## Keyboard: Shift+Enter, Esc, modifier chords

Tattoy never relays an application's request to enable the kitty keyboard
protocol to the real terminal, so kitty/zellij would send Shift+Enter as a
plain Enter. `sbg` therefore pushes the protocol itself (`CSI > 1 u`,
disambiguate only: plain Enter/Tab/Backspace stay legacy) before tattoy starts
and pops it on exit, whenever it detects kitty, zellij, WezTerm, Ghostty, or
foot. Force with `SBG_KITTY_KEYS=1`, disable with `SBG_KITTY_KEYS=0`.
Tattoy's own `Alt+…` chords still work because its parser understands CSI u.

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

## Scripting animations (Lua)

Any pane can run a user-authored animation instead of a compiled effect.
Scripts live at `~/.config/sbg/fx/*.lua` (`$SBG_FX_DIR` overrides the
directory) and export three functions:

```lua
function init(ctx)          end   -- ctx = {w, h, seed, density, fps}
function step(dt, state)    end   -- dt already scaled by state.mod.speed
function render(fx, state)  end   -- fx:put(x, y, ch, r, g, b), fx:clear(), fx:count()
```

`state` carries the same live signals as the builtins react to (`mode`,
`tool_kind`, `context_pct`, `mod.burst`, …); `sbg` exposes a seeded RNG,
value noise, colour ramps and mixing, and glyph sets (matrix katakana,
blocks, shades, braille, ascii, dots, box). The sandbox has no
`io`/`os`/`require`/`load`; a runaway script is capped and, if it stays
slow, falls back to the builtin effect. Full reference:
`plugin/skills/bg/references/lua-api.md`.

```sh
sbg fx list                 # builtins, plus scripts in the fx dir
sbg fx new my-effect          # copy the annotated template, refuses to overwrite
sbg fx edit my-effect           # open $VISUAL/$EDITOR on it
sbg fx use my-effect               # switch this pane to it, live
sbg fx use matrix                    # or switch to a builtin by name
sbg fx use off                         # clear the script override
sbg --script ~/.config/sbg/fx/pulse.lua -- claude   # launch straight into a script
```

`sbg install` copies the shipped ports (`matrix`, `plasma`, `waves`,
`stars`, plus `context-bars` and `pulse`) and the template into
`~/.config/sbg/fx/` without overwriting anything already there.

**Hot reload and fallback:** `sbg-fx` stats each script's mtime and size
every frame; on a change it compiles and initializes the new version in a
scratch state and only swaps in on success. A script that fails to load or
throws keeps the last good version running — the failure is recorded in
`<SBG_STATE>/error.json` and shown by `sbg doctor` and `sbg state`.

The `/bg` skill (`plugin/skills/bg/`) covers day-to-day control and
authoring guidance for both Claude Code and Codex.

## Living worlds: art that grows with the session

`sbg auto` (and the `claude`/`codex` shims) launch `~/.config/sbg/fx/world.lua`
when it exists (`SBG_WORLD=0` returns to the builtin effects). A world is a
generative scene rebuilt deterministically from the session's cumulative
`journey.json` (written by the hooks: prompts, tools by kind, files by
extension, errors, subagents, recent events) plus `status.json`
(`context_pct`, `lines_added/removed`), so a three-hour session looks different
from a five-minute one and the scene never loops:

| Motif | Grows by |
|---|---|
| `office` | desks and workers per agent/subagent, typing while thinking, ☕ when waiting, ⚡ on error, floors every ~40 tools, banner with the office name and `+lines` |
| `forest` | one L-system tree per N tools, leaves coloured by file language, sky by context %, lightning on errors |
| `skyline` | buildings rise with lines added, windows light per tool, crane while a tool runs, night falls with context |
| `reef` | braille coral per tool, fish = subagents, bleaching on errors |
| `circuit` | nodes per tool, traces between recent events, pulses while thinking |
| `sakura` | cherry tree branches per tools, blossoms per prompt, a petal per edited file piling up in a corner |
| `kana` | halfwidth-katakana rain on the pane edges, columns per tools, trails by context %, sigils spelling prompt words |
| `shrine` | torii, a stone path step per tool batch, lanterns, tree line by context %, fireflies per prompt |
| `hangar` | mecha bays per tools, lamps by tool kind, drones per subagent, a PWR gauge from context % |
| `dojo` | shonen speed lines on the edges, tally marks per prompt, LV ticks, a chibi that trains, sits, or thinks |
| `hud` | RPG status window whose rows unlock with the session: LV/XP, party, mana, wounds, skills |

`world.lua` bundles all eleven and picks one from `mood.json` (`motif`) or a
hash of the repository name; `sbg fx use office` pins one. Every motif keeps
under ~25 % coverage and fades the oldest parts when the pane fills.

The six anime motifs (`sakura kana shrine hangar dojo hud`) use only one-cell
glyphs — ASCII, box drawing, blocks, braille and halfwidth katakana — because
fullwidth kana and kanji are double-width and would break the grid. Mode words
appear as halfwidth katakana next to the scene title, kaomoji show up only as
rare reactions, and the anime tropes map to session states: a power-up aura
while thinking, an action cut when a tool runs, a freeze frame while waiting, a
local crimson flash and a lasting scar on error, a contraction that regrows on
compaction, and a slow drift with a sleepy cue after a minute idle.
`scripts/world/bundle.py` regenerates `world.lua`; `lua scripts/world/drive.lua`
checks every motif's coverage and `lua scripts/world/show.lua NAME` prints a
frame.

**Art director (optional, spends tokens).** `sbg set director=true` lets the
`UserPromptSubmit` hook spawn `plugin/scripts/sbg_director.py` detached, at
most every 2 minutes. It asks `claude -p --model haiku` (fallback `codex exec`)
for strict JSON — motif, 5-colour palette, tempo, a scene title, a mood word —
from the repo, languages, and prompt words, and writes `mood.json`; the world
adopts it on the next frame. Nothing blocks the session; failures write
nothing. Without the director the same choices are derived deterministically.

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
