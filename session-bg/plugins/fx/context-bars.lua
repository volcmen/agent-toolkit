local W, H = 0, 0
local clock = 0.0

function init(ctx)
  W, H = ctx.w, ctx.h
  clock = 0.0
end

function step(dt, state)
  clock = clock + dt
end

function render(fx, state)
  if H == 0 or W == 0 then
    return
  end
  local pct = sbg.clamp(state.context_pct or 0.0, 0.0, 100.0)
  local warn = pct >= 80.0
  local filled = math.floor((pct / 100.0) * W + 0.5)
  local breath = 1.0
  if state.mode == "waiting" then
    breath = 0.75 + 0.25 * math.sin(clock * 6.28318 * 0.12)
  end
  local bar_y = H - 1
  local shelf_y = H - 2
  for x = 0, filled - 1 do
    local t = W <= 1 and 0.0 or (x / (W - 1))
    local r, g, b
    if warn then
      r, g, b = sbg.ramp("warn", t)
    else
      r, g, b = sbg.ramp("ice", t)
    end
    r, g, b = sbg.scale(r, g, b, 0.55 * breath)
    fx:put(x, bar_y, sbg.glyphs.blocks[#sbg.glyphs.blocks], r, g, b)
  end
  if shelf_y >= 0 then
    for x = 0, W - 1, 4 do
      local r, g, b
      if warn then
        r, g, b = sbg.ramp("warn", x / math.max(1, W - 1))
      else
        r, g, b = sbg.ramp("mono", 0.5)
      end
      r, g, b = sbg.scale(r, g, b, 0.18 * breath)
      fx:put(x, shelf_y, sbg.glyphs.shades[1], r, g, b)
    end
  end
end
