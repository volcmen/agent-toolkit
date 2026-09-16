local W, H = 0, 0
local rng = nil
local drops = {}
local shimmer = 0.0

local function target_drops(density)
  return math.max(1, math.floor(W * 0.22 * density))
end

local function spawn(above)
  if W == 0 or H == 0 then
    return
  end
  local len = math.max(3, math.floor(rng:range(4.0, math.max(H, 6) * 0.6)))
  local head
  if above then
    head = -rng:range(0.0, H)
  else
    head = rng:range(0.0, H)
  end
  local glyphs = {}
  for i = 1, len + 2 do
    glyphs[i] = sbg.glyphs.matrix[rng:below(#sbg.glyphs.matrix) + 1]
  end
  drops[#drops + 1] = {
    x = rng:below(W),
    head = head,
    len = len,
    speed = rng:range(4.0, 14.0),
    glyphs = glyphs,
  }
end

function init(ctx)
  W, H = ctx.w, ctx.h
  rng = sbg.rng(ctx.seed)
  drops = {}
  shimmer = 0.0
  for _ = 1, target_drops(ctx.density) do
    spawn(false)
  end
end

function step(dt, state)
  shimmer = shimmer + dt
  for _, d in ipairs(drops) do
    d.head = d.head + d.speed * dt
    if rng:chance(dt * 6.0) then
      local i = rng:below(#d.glyphs) + 1
      d.glyphs[i] = sbg.glyphs.matrix[rng:below(#sbg.glyphs.matrix) + 1]
    end
  end
  local kept = {}
  for _, d in ipairs(drops) do
    if d.head - d.len < H then
      kept[#kept + 1] = d
    end
  end
  drops = kept
  local density = state.params.density or 1.0
  local wanted = target_drops(density)
  while #drops < wanted do
    spawn(true)
  end
  if state.mod.burst > 0.2 and rng:chance(dt * 4.0 * state.mod.burst) then
    spawn(true)
  end
end

function render(fx, state)
  local head_col = { sbg.hex(0xd7ffe0) }
  local bright = { sbg.hex(0x9ece6a) }
  local dark = { sbg.hex(0x1f5a2a) }
  for _, d in ipairs(drops) do
    local head = math.floor(d.head)
    for i = 0, d.len - 1 do
      local y = head - i
      if y >= 0 and y < H then
        local t = i / d.len
        local r, g, b
        if i == 0 then
          r, g, b = head_col[1], head_col[2], head_col[3]
        else
          r, g, b = sbg.mix(bright[1], bright[2], bright[3], dark[1], dark[2], dark[3], t)
          local pulse = 0.85 + 0.15 * math.sin(shimmer * 3.0 + d.x)
          r, g, b = sbg.scale(r, g, b, (1.0 - t * 0.6) * pulse)
        end
        local ch = d.glyphs[(i % #d.glyphs) + 1]
        fx:put(d.x, y, ch, r, g, b)
      end
    end
  end
end
