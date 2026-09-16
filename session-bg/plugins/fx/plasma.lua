local W, H = 0, 0
local t = 0.0
local phase = { 0.0, 0.0, 0.0, 0.0 }

local BRAILLE_BITS = {
  { 0x01, 0x08 },
  { 0x02, 0x10 },
  { 0x04, 0x20 },
  { 0x40, 0x80 },
}

local function field(x, y)
  local p = phase
  local cx = 90.0 + 60.0 * math.sin(t * 0.23 + p[1])
  local cy = 30.0 + 20.0 * math.cos(t * 0.17 + p[2])
  local dx = x - cx
  local dy = (y - cy) * 2.0
  local v = math.sin(x * 0.13 + t * 0.5 + p[1])
    + math.sin(y * 0.31 - t * 0.4 + p[2])
    + math.sin((x * 0.08 + y * 0.17) + t * 0.3 + p[3])
    + math.sin(math.sqrt(dx * dx + dy * dy) * 0.15 - t * 0.7 + p[4])
  return v / 4.0
end

function init(ctx)
  W, H = ctx.w, ctx.h
  t = 0.0
  local rng = sbg.rng(ctx.seed)
  phase = { rng:range(0, 6.28318), rng:range(0, 6.28318), rng:range(0, 6.28318), rng:range(0, 6.28318) }
end

function step(dt, state)
  t = t + dt
end

function render(fx, state)
  local density = state.params.density or 1.0
  local threshold = sbg.clamp(0.3 - 0.2 * (density - 1.0) - 0.15 * (state.context_pct / 100.0), 0.18, 0.9)
  local cold = { sbg.hex(0x3d59a1) }
  local warm = { sbg.hex(0xbb9af7) }
  local hot = { sbg.hex(0x7dcfff) }
  for cy = 0, H - 1 do
    for cx = 0, W - 1 do
      local bits = 0
      local sum = 0.0
      for row = 1, 4 do
        for col = 1, 2 do
          local x = cx * 2.0 + (col - 1)
          local y = cy * 4.0 + (row - 1)
          local v = field(x, y * 0.5)
          sum = sum + v
          if v > threshold then
            bits = bits | BRAILLE_BITS[row][col]
          end
        end
      end
      if bits ~= 0 then
        local avg = (sum / 8.0 + 1.0) * 0.5
        local r, g, b
        if avg < 0.6 then
          r, g, b = sbg.mix(cold[1], cold[2], cold[3], warm[1], warm[2], warm[3], avg / 0.6)
        else
          r, g, b = sbg.mix(warm[1], warm[2], warm[3], hot[1], hot[2], hot[3], (avg - 0.6) / 0.4)
        end
        r, g, b = sbg.scale(r, g, b, 0.55)
        fx:put(cx, cy, sbg.braille(bits), r, g, b)
      end
    end
  end
end
