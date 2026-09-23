# session-bg

Animated, per-pane ASCII/UTF-8 backgrounds for terminal AI sessions (Claude
Code, Codex, or anything else) running inside zellij on kitty. Each pane gets
its own effect and seed; the animation only ever paints cells the application
left empty, so the UI stays readable and input passes straight through.

[Tattoy](https://tattoy.sh) remains the default compositor. An experimental
independent Rust backend, `sbg-term`, runs the same effects in process with a
native PTY relay and bounded ANSI background diffs. See the
[native backend notes](notes/compositor/spike.md) and
[compatibility checklist](notes/compositor/parity.md).

```
zellij pane ──▶ sbg auto -- claude
                 └─▶ tattoy --main-config <rendered> --command claude
                        ├─▶ shadow terminal (headless wezterm) runs claude
                        └─▶ plugin sbg-fx (env SBG_EFFECT/SBG_SEED) paints empty cells
```

## Install

```sh
brew install tattoy-org/tap/tattoy          # v0.1.8+
python3 scripts/build-tattoy.py             # tested, pinned compatibility build for sbg
cd plugins && cargo build --release --workspace --locked  # sbg-fx and sbg-term
ln -s "$PWD/../bin/sbg" ~/.local/bin/sbg     # or add bin/ to PATH
sbg palette                                  # palette.toml from ~/.config/kitty/current-theme.conf
```

`scripts/install.sh` builds the compatible backend and current plugin, then runs `sbg install`, which
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

Try the independent Rust backend in a new session:

```sh
sbg --backend own -- codex
sbg --backend own -- claude
SBG_BACKEND=own codex           # also works through the installed PATH shim
sbg doctor                     # active backend, CPU, peak RSS, renderer p95
```

`--backend tattoy` selects the compatibility backend again. Neither choice
replaces an already-running process. `SBG_TERM` overrides the native executable.
The native path needs no Tattoy installation or palette capture and passes
arguments directly without a generated shell command. Use `sbg set` for effect
controls; Tattoy's `Alt+…` shortcuts belong to the child on the native path.

The default Studio keeps moving on its lower floors, so terminal output
covering the top of the pane does not leave the scene still. Pause and reduced
motion also control it.

The native backend is opt-in while terminal parity work continues. Unchanged-size
notifications preserve animation. After an actual resize it suspends painting
until the app clears and repositions the affected screen buffer;
reflow can leave old decoration until that redraw. Graphics and legacy charset
protocols pass through, but suspend the underlay. Physical kitty/zellij soak and
cross-emulator parity checks remain release gates. See
[measurements and commands](notes/compositor/performance.md) and
[resize/lifecycle coverage](notes/compositor/lifecycle.md).

Effects: `matrix` (katakana rain), `plasma` (braille field), `waves` (block
surface + foam), `stars` (twinkle + shooting stars). Defaults: 12 fps, layer
-5, opacity 0.6. Built-in effects use 35–55% palette brightness; Fortress uses
brighter semantic colours so its scenery stays visible after composition.

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

The managed compatibility build also preserves batched typing and bracketed
paste byte for byte, including Unicode and zero bytes. It recognizes shortcuts
only outside pasted text and streams input through a bounded queue. A standalone
Escape is released after a 40 ms ambiguity window. `scripts/input-smoke.py`
checks these boundaries in a real PTY, including a 50 KiB paste.

## Troubleshooting

`sbg doctor` prints the tattoy/plugin/palette/shim state, PATH order, `which
claude`, and the tail of `~/.cache/sbg/tattoy.log` (default log level `warn`).
When tattoy exits within 5 s or with a non-zero status, `sbg` prints the exit
status, the exact command, and the new log lines to stderr before returning.

### Codex panel backgrounds

Stock Tattoy 0.1.8 discards terminal color-query replies, so Codex cannot discover
the default background and falls back to unshaded prompt/message panels. Its
plugin occupancy stream also skips colored spaces. The compatibility build
forwards native terminal replies, uses Tattoy's configured palette, and protects
explicitly colored blank cells from scenery.

`python3 scripts/build-tattoy.py` downloads checksum-pinned source, applies
`patches/tattoy-0.1.8-compat.patch`, builds with the locked dependency graph, and
runs compositor/input tests plus real PTY color, paste, key and resize checks before installation.
It installs under `~/.local/share/sbg/tattoy/`; Homebrew stays intact. `sbg` prefers
this binary, and `sbg doctor` prints its path. `SBG_TATTOY=/path/to/tattoy` explicitly
selects another backend. `python3 scripts/build-tattoy.py --check` verifies the
installed patch recipe and executable checksum.

Start a new sbg session (or resume Codex in one) to load the new backend and effect
host. Existing sessions keep their running binaries. Lua world files can hot-reload,
but `sbg install` preserves existing scripts; updating those remains deliberate.

## Live state: hooks, context usage, `sbg set`

Every launch creates a pane directory (`SBG_STATE`, default
`~/.cache/sbg/panes/<pane>`) that `sbg-fx` polls each frame. Writers own their output files and publish with atomic renames. Hook
updates additionally share a lock to preserve concurrent subagent events:

| File | Writer | Content |
|---|---|---|
| `session.json` | Hooks and the launcher's name watcher, using the same writer lock | `session_name`, `mode` (`start idle thinking tool waiting error compacting end`), `tool`, `tool_kind`, `subagents`, `prompt`, `seq` |
| `status.json` | claude-core `statusline.py` (Claude only) | `context_pct`, `tokens`, `context_size`, `cost_usd`, `model`, `effort`, `branch` |
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

An isolated long frame does not abandon the world. Three consecutive frames
over three times the frame budget trigger a builtin fallback; sustained moderate
cost first halves the frame rate. Failed scripts retry after 5, 10, 20, 40 and
then at most every 60 seconds, restoring their saved checkpoint. Retries wait
while the background is disabled or paused, and selecting a builtin cancels
recovery. `sbg state` / `sbg doctor` show the actual runtime effect, requested
effect, heartbeat, fallback reason and retry time from `runtime.json`.

These host changes take effect in newly launched `sbg` sessions. Lua scenery
hot-reloads in existing sessions; Tattoy 0.1.8 does not restart its plugin
process on configuration changes, so an existing host keeps its old recovery
policy until that session is relaunched.

For an existing pre-recovery host, `scripts/legacy-recovery.py` is an opt-in
migration helper. Give it the existing `sbg-fx` PID, exact pane directory and
selected script with `--parent`, `--pane` and `--script`. It retries only after
an exact legacy fallback log and a stale checkpoint, by touching the existing
override's mtime. It never rewrites settings or events, honors pause/disable,
backs off between attempts, and exits with that host or when `runtime.json`
appears. Newly launched hosts need no helper.

The `/bg` skill (`plugin/skills/bg/`) covers day-to-day control and
authoring guidance for both Claude Code and Codex.

## Fortress: a settlement built by your session

Fortress is a living, Dwarf-Fortress-inspired ASCII settlement.
The founder and subagents become workers, tools become specialist jobs,
web/MCP calls bring caravans, and compaction opens a deeper gallery. Skilled
workers can create named artifacts. A bounded chronicle remembers the story.

The default pane scene is the Studio: a cutaway game-dev tower on the right
edge that shows the live session. The HUD names the session, its repository
and branch, the current mode, reasoning effort and context; the crew works at
lit stations for real tool beats, chases bugs after failures and takes coffee
breaks when the session is quiet. Floors grow through five tiers as tools and
prompts accumulate. The [Studio PRD](notes/studio/prd.md) describes its
signals, layout and crew. The earlier idle office was removed; `scene=office`
is rejected and old checkpoints that still carry an office record restore the
world and ignore it.

```sh
sbg fx use fortress
sbg set scene=studio        # default: game-dev studio tower that grows with session points
sbg set scene=settlement    # landscape and session-earned edge districts
sbg set glyphs=ascii        # ASCII fallback for the studio; unicode restores glyph art
sbg set fortress="Amber Hall" difficulty=calm
sbg legends 12
sbg set paused=true          # paused=false resumes
sbg set presentation=compact # auto restores the adaptive detailed view
sbg set reduced_motion=true  # false restores travel and animation
```

The settlement landscape fills the pane's empty space with trees, flowers, rocks,
mushrooms, a flowing stream, bridges and roaming wildlife. Foreground text has
a one-cell safety margin: scenery disappears wherever the application writes.
Layout follows the current pane grid: narrow or short panes get miniature rooms
and a compact HUD, while wider panes gain room columns. Rooms keep readable
proportions; there is no required resolution or fixed maximum district width.
Titles wrap when space allows, and meters keep complete percentages and counts.
ASCII glyphs avoid emoji alignment problems. Normal coverage targets 22% before
foreground masking, with a hard 25% ceiling. Permission denials are neutral;
errors recover without deaths or penalties. Only filtered subject words reach
the world; hooks no longer persist raw prompt snippets.

Replay is deterministic; resizing and animation speed cannot rewrite history.
Snapshots survive reloads, and missing events produce an explicit gap instead
of invented achievements. `calm`, `classic` and `chaos` affect future flavour;
no model calls are needed. The design and validation evidence live in
[notes/fortress/design.md](notes/fortress/design.md) and
[notes/fortress/soak.md](notes/fortress/soak.md).

For a source checkout preview: `lua scripts/world/show.lua fortress 120 thinking 120 35`.
The source modules are `plugins/fx/fortress/`; regenerate the standalone and
world bundles with `python3 scripts/world/bundle.py`. Existing installed effect
files are preserved by `sbg install`; use the source path with `--script` when
reviewing a checkout, or deliberately update an unmodified shipped copy.

### A living colony

Residents keep daily routines during quiet moments: walking through doors and
along corridors to read, craft, tend the garden, gather and rest. Nearby
residents can chat. Gardens evolve with Conway's Game of Life rules, while cats
pace the banks of moving water. Dawn, daylight, dusk and night change the
settlement's light; rain comes and goes, and windows and campfires glow at night.
Gardens sit beside the buildings, rooms have visible furnishings, and rabbits,
butterflies and moving foliage keep the surrounding landscape active from the
first session. Scenery packs into the available space without stretched sprites.
The bottom edge shows the current day, weather and the founder's activity.

One ambient day lasts two minutes. A fixed 12×6 garden takes one generation per
second, with deterministic germination every 48 generations. This local life
continues without new tool calls, survives script reloads, and freezes with
`sbg set paused=true`. It earns no buildings or XP and changes no agent counts.
Session activity still determines construction and the settlement's history.

`presentation=compact` keeps the middle 64% clear, removes the surrounding
landscape, floor texture and weather particles, and uses a smaller HUD.
`reduced_motion=true` keeps residents and scenery still and removes
spinners, pulses and flashes. Earned construction, current mode, session names
and counters continue updating; the local ecology keeps its time. `paused=true`
is separate: it also pauses event consumption and local time. These controls
require the current `sbg-fx` binary; existing processes need a new launch for new
host parameters, while Lua layout changes hot-reload immediately.

## The world: Fortress by default

`sbg auto` (and the `claude`/`codex` shims) launch `~/.config/sbg/fx/world.lua`
when it exists (`SBG_WORLD=0` returns to the builtin effects). `world.lua` is
the Fortress bundle: one deterministic settlement rebuilt from the session's
cumulative `journey.json` (prompts, tools by kind, files by extension, errors,
subagents, recent events) plus `status.json` (`context_pct`,
`lines_added/removed`). The earlier generative motifs were removed; Fortress is
the only world, so every pane shows the same game.

The HUD at the pane edges follows the session live: the title (following
`/rename` within about a second and flashing amber for three seconds), the
settlement rank, year and season, the current mode with the running tool
(`| Bash`, `thinking...`, `waiting ?`, `error !`, `compacting ~~`, `idle zz`
after a minute), a `ctx [====----] 42%` meter that turns amber past 60 % and
red past 90 %, and a bottom line of tools and `+added/-removed` that brightens
when a value changes. Milestones replace the mode label for four seconds:
`* renamed`, `* 50 tools`, `* +250 lines`, `* context 50%`, `* chapter 3`,
`* compacted`, `* helper joins`, `! error 2`. `mood.json` no longer selects a
motif. `scripts/world/bundle.py` regenerates `world.lua`;
`lua scripts/world/drive.lua` checks coverage and
`lua scripts/world/show.lua world` prints a frame.

## How the plugin works

### Fortress progression and session titles

`sbg fx use fortress` shows a settlement that grows with session activity.
Three starter rooms are ready at embark. Each fifteen tool events earns another
room: its blueprint gains foundations, walls and fittings as the work advances.
Builders carry materials while tools run; a meter shows the next room and the
settlement advances through Camp, Outpost, Village, Citadel and Capital.
These are activity milestones, not an assessment of code quality.

The top-left title follows the actual session name, including renames while
idle, within about one second. Codex uses its explicit local thread name;
Claude uses the matching transcript's custom title (with its session index as
a fallback). Missing metadata falls back to the working directory name. The
launcher owns the watcher and stops it on exit. Existing sessions need the new
launcher for continuous polling; updated hooks also refresh the name on events.

```sh
sbg set session_name="Parser workshop"  # optional display override
sbg set session_name=                   # follow the agent's name again
sbg set fortress="Amber Hall"           # separate settlement name
```

The session title wraps into two edge rows, clips long names, strips terminal
controls and substitutes unsupported glyphs with `?`. Renaming changes the
display only: rooms, counters, legends and pause state remain intact. Full
sanitized names are available through `sbg state --json`. No prompt text is
used to invent a title, and no model calls are made.

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
