local W, H = 0, 0
local cx, cy = 0.0, 0.0
local t = 0.0
local RING_SPACING = 3.0
local BAND = 0.15

local function mode_rate(state)
  local mode = state.mode
  local burst = state.mod.burst or 0.0
  if mode == "thinking" then
    return 1.3
  elseif mode == "tool" then
    return 1.0 + 1.5 * burst
  elseif mode == "waiting" then
    return 0.45
  elseif mode == "error" then
    return 1.8
  elseif mode == "compacting" then
    return 0.35
  elseif mode == "idle" then
    return 0.5
  end
  return 0.9
end

function init(ctx)
  W, H = ctx.w, ctx.h
  cx, cy = W / 2.0, H / 2.0
  t = 0.0
end

function step(dt, state)
  t = t + dt * mode_rate(state)
end

function render(fx, state)
  if W == 0 or H == 0 then
    return
  end
  local glyphs = sbg.glyphs.braille
  for y = 0, H - 1 do
    for x = 0, W - 1 do
      local dx = x - cx
      local dy = (y - cy) * 2.0
      local dist = math.sqrt(dx * dx + dy * dy)
      local phase = dist / RING_SPACING - t
      local frac = phase - math.floor(phase)
      if frac < BAND then
        local ring_index = math.floor(dist / RING_SPACING)
        local age = frac / BAND
        local shade = 1.0 - age * 0.7
        local r, g, b = sbg.ramp("mono", sbg.clamp(dist / (RING_SPACING * 8.0), 0.0, 1.0))
        r, g, b = sbg.scale(r, g, b, 0.45 * shade)
        local ch = glyphs[(ring_index % #glyphs) + 1]
        fx:put(x, y, ch, r, g, b)
      end
    end
  end
end
