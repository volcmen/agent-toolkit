local W, H = 0, 0
local t = 0.0
local layers = {}

local SURFACE = { "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" }
local FILLS = { "·", "~", "≈", "░" }
local FOAM = "░"

local function surface_y(layer, x)
  local base = H * (1.0 - layer.depth)
  return base
    - layer.amp
      * (math.sin(x * layer.freq + t * layer.speed + layer.phase)
        + 0.5 * math.sin(x * layer.freq * 2.3 - t * layer.speed * 0.7))
end

function init(ctx)
  W, H = ctx.w, ctx.h
  t = 0.0
  layers = {}
  local rng = sbg.rng(ctx.seed)
  local palette = {
    { sbg.hex(0x2ac3de) },
    { sbg.hex(0x7aa2f7) },
    { sbg.hex(0x3d59a1) },
    { sbg.hex(0x1f2f5a) },
  }
  for i = 0, 3 do
    local rgb = palette[i + 1]
    layers[i + 1] = {
      depth = 0.34 - i * 0.08,
      amp = rng:range(0.8, 1.8) + i * 0.3,
      freq = rng:range(0.08, 0.16),
      speed = rng:range(0.6, 1.4) * (i % 2 == 0 and 1.0 or -1.0),
      phase = rng:range(0, 6.28318),
      rgb = rgb,
      fill = FILLS[i + 1],
    }
  end
end

function step(dt, state)
  t = t + dt
end

function render(fx, state)
  local density = state.params.density or 1.0
  local fill_rows = math.max(1, math.floor(2.0 * density + 0.5))
  local burst = state.mod.burst or 0.0
  for x = 0, W - 1 do
    local covered = H
    for i, layer in ipairs(layers) do
      local sy = surface_y(layer, x)
      local row = math.floor(sy)
      if row >= 0 and row < H and row < covered then
        local frac = 1.0 - (sy - math.floor(sy))
        local idx = sbg.clamp(math.floor(frac * 7.0 + 0.5), 0, 7) + 1
        local shade = 1.0 - (i - 1) * 0.18
        local r, g, b = sbg.scale(layer.rgb[1], layer.rgb[2], layer.rgb[3], 0.55 * shade)
        local ch = SURFACE[idx]
        if i == 1 and burst > 0.15 and sbg.smoothstep(0.0, 1.0, burst) > 0.5 then
          ch = FOAM
          r, g, b = sbg.scale(1.0, 1.0, 1.0, 0.5 * burst)
        end
        fx:put(x, row, ch, r, g, b)
        local y = row + 1
        while y < covered and y < row + 1 + fill_rows do
          local fr, fg, fb = sbg.scale(layer.rgb[1], layer.rgb[2], layer.rgb[3], 0.35 * shade)
          fx:put(x, y, layer.fill, fr, fg, fb)
          y = y + 1
        end
        covered = row
      end
    end
  end
end
