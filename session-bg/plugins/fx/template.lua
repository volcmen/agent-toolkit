-- session-bg animation template.
--
-- Copy this file with `sbg fx new NAME` (it lands in ~/.config/sbg/fx/NAME.lua)
-- and edit it while a session is running: sbg-fx hot-reloads on save. If the
-- file fails to load or throws, the last good version keeps running and the
-- failure shows up in `sbg doctor` / <SBG_STATE>/error.json, so it is safe to
-- experiment.
--
-- Three functions, all optional except step/render:
--
--   init(ctx)          called once on load and again on resize (or define a
--                       separate resize(ctx) if you want different behaviour)
--   step(dt, state)     advance your simulation; dt is already scaled by
--                       state.mod.speed, so you do not need to multiply it
--                       yourself
--   render(fx, state)   paint the frame by calling fx:put(...)
--
-- ctx passed to init/resize:
--   ctx.w, ctx.h   grid size in cells
--   ctx.seed       integer seed, stable per pane, for sbg.rng(ctx.seed)
--   ctx.density    starting density hint (also in state.params.density)
--   ctx.fps        target frames per second
--
-- state passed to step/render:
--   state.mode          "start" "idle" "thinking" "tool" "waiting" "error"
--                        "compacting" "end"
--   state.tool          raw tool name from the last PreToolUse, or nil
--   state.tool_kind     "exec" "edit" "read" "web" "task" "mcp" "other" or nil
--   state.agent         "claude" "codex" or "unknown"
--   state.context_pct   0..100, Claude only (Codex has no equivalent -> 0)
--   state.cost          running cost in USD, Claude only
--   state.model         model name string, Claude only
--   state.prompt        first ~80 chars of the last user prompt, or nil
--   state.age           seconds since the current mode started
--   state.changed       true on the frame the merged state actually changed
--   state.mod           host-computed modulation, ALREADY applied to hue and
--                        brightness after render() returns -- do not re-apply
--                        state.mod.hue/bright yourself, just react to shape
--                        and behaviour:
--     state.mod.speed    multiplier already folded into dt
--     state.mod.density  suggested multiplier for how much you draw
--     state.mod.hue      hue shift the host applies after render (informational)
--     state.mod.bright   brightness multiplier the host applies (informational)
--     state.mod.burst    0..1, decays after a tool call fires; use it for a
--                         one-shot spawn or flash, not a steady-state effect
--   state.params         user-tunable knobs from `sbg set` / override.json:
--     state.params.density, .speed, .hue, .opacity, .palette (all optional)
--
-- Everything under the `sbg` table is available; there is no io/os/require,
-- so keep all your own state as fields on a normal Lua table returned by
-- init, or as upvalues declared at file scope.
--
--   sbg.rng(seed)                 deterministic RNG object:
--     :f()                          float in [0, 1)
--     :range(a, b)                  float in [a, b)
--     :below(n)                     integer in [0, n) (0-based)
--     :chance(p)                    boolean, true with probability p
--   sbg.noise2(x, y)               2D value noise in [-1, 1]
--   sbg.noise3(x, y, z)            3D value noise in [-1, 1]
--   sbg.fbm(x, y, octaves)         fractal brownian motion, [-1, 1]
--   sbg.ramp(name, t)              r, g, b for t in [0, 1] on a named gradient:
--                                  "matrix" "ember" "ice" "tokyonight" "mono" "warn"
--   sbg.mix(r1, g1, b1, r2, g2, b2, t)   lerp between two colours
--   sbg.scale(r, g, b, k)                multiply brightness, clamped to [0, 1]
--   sbg.hex(0xRRGGBB)                    -> r, g, b in [0, 1]
--   sbg.shift_hue(r, g, b, turns)        rotate hue by `turns` (0..1 = full turn)
--   sbg.glyphs.matrix / .blocks / .shades / .braille / .ascii / .dots / .box
--                                        tables of glyph strings to sample from
--   sbg.braille(mask8)                   8-bit dot mask -> one braille character
--   sbg.lerp(a, b, t)
--   sbg.clamp(v, lo, hi)
--   sbg.smoothstep(edge0, edge1, x)
--   sbg.wrap(v, n)                       wrap v into [0, n)
--
-- fx passed to render:
--   fx:put(x, y, ch, r, g, b)   paint one cell; x, y are 0-based, r/g/b are
--                               floats in [0, 1], ch is a single character.
--                               Cells the host application has drawn text on
--                               are filtered out for you automatically -- you
--                               never need to check occupancy yourself.
--   fx:clear()                 remove every cell you painted this frame
--   fx:count()                 how many cells you have painted so far
--
-- Keep coverage under ~40% of the grid (fx:count() / (ctx.w * ctx.h)) so the
-- pane stays readable, and keep colours dim -- the host multiplies your
-- brightness by state.mod.bright, so painting near-full brightness yourself
-- risks a blown-out look once a burst or "waiting" pulse stacks on top.
--
-- This starter effect: a handful of drifting embers that gently pick up pace
-- on "thinking" and flare briefly on a tool burst.

local W, H = 0, 0
local rng = nil
local embers = {}

local function spawn(n)
  for _ = 1, n do
    embers[#embers + 1] = {
      x = rng:range(0, W),
      y = rng:range(0, H),
      vx = rng:range(-0.6, 0.6),
      vy = rng:range(-0.3, 0.3),
      phase = rng:range(0, 6.28318),
    }
  end
end

function init(ctx)
  W, H = ctx.w, ctx.h
  rng = sbg.rng(ctx.seed)
  embers = {}
  local count = sbg.clamp(math.floor(W * H * 0.02 * ctx.density), 4, 60)
  spawn(count)
end

function step(dt, state)
  for _, e in ipairs(embers) do
    e.x = sbg.wrap(e.x + e.vx * dt, W)
    e.y = sbg.wrap(e.y + e.vy * dt, H)
    e.phase = e.phase + dt * 2.0
  end
  if state.mod.burst > 0.05 and #embers < 80 then
    spawn(1)
  end
end

function render(fx, state)
  for _, e in ipairs(embers) do
    local twinkle = 0.5 + 0.5 * math.sin(e.phase)
    local r, g, b = sbg.ramp("ember", twinkle)
    local k = 0.35 + 0.35 * twinkle + 0.3 * state.mod.burst
    r, g, b = sbg.scale(r, g, b, k)
    fx:put(math.floor(e.x), math.floor(e.y), sbg.glyphs.dots[1], r, g, b)
  end
end
