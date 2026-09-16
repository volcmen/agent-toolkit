local W, H = 0, 0
local t = 0.0
local stars = {}
local shooters = {}
local rng = nil

local CHARS = { "·", "·", "·", "•", "✦", "✧", "⋆", "*", "." }
local COLORS = {
  { sbg.hex(0xc0caf5) },
  { sbg.hex(0xe0af68) },
  { sbg.hex(0x7dcfff) },
  { sbg.hex(0xbb9af7) },
  { sbg.hex(0xa9b1d6) },
}

local function spawn_shooter(rng)
  shooters[#shooters + 1] = {
    x = rng:range(0, W),
    y = rng:range(0, H * 0.4),
    vx = rng:range(18.0, 34.0) * (rng:chance(0.5) and 1.0 or -1.0),
    vy = rng:range(3.0, 7.0),
    life = rng:range(0.8, 1.6),
  }
end

function init(ctx)
  W, H = ctx.w, ctx.h
  t = 0.0
  stars = {}
  shooters = {}
  rng = sbg.rng(ctx.seed)
  local n = math.floor((W * H / 28.0) * ctx.density)
  for _ = 1, n do
    stars[#stars + 1] = {
      x = rng:below(W),
      y = rng:below(H),
      phase = rng:range(0, 6.28318),
      speed = rng:range(0.4, 2.2),
      ch = CHARS[rng:below(#CHARS) + 1],
      rgb = COLORS[rng:below(#COLORS) + 1],
    }
  end
end

function step(dt, state)
  t = t + dt
  local kept = {}
  for _, s in ipairs(shooters) do
    s.x = s.x + s.vx * dt
    s.y = s.y + s.vy * dt
    s.life = s.life - dt
    if s.life > 0.0 then
      kept[#kept + 1] = s
    end
  end
  shooters = kept
  local density = state.params.density or 1.0
  if W > 0 and rng:chance(dt * 0.12 * density) then
    spawn_shooter(rng)
  end
  if state.mode == "waiting" and rng:chance(dt * 0.6) then
    spawn_shooter(rng)
  end
end

function render(fx, state)
  for _, s in ipairs(stars) do
    local twinkle = 0.5 + 0.5 * math.sin(t * s.speed + s.phase)
    local k = 0.18 + 0.5 * twinkle * twinkle
    local r, g, b = sbg.scale(s.rgb[1], s.rgb[2], s.rgb[3], k)
    fx:put(s.x, s.y, s.ch, r, g, b)
  end
  for _, sh in ipairs(shooters) do
    local dir = sh.vx > 0.0 and -1.0 or 1.0
    local vy_sign = sh.vy >= 0 and 1.0 or -1.0
    for i = 0, 5 do
      local x = math.floor(sh.x + dir * i * 1.4)
      local y = math.floor(sh.y - dir * i * 0.25 * vy_sign)
      if x >= 0 and y >= 0 and x < W and y < H then
        local fade = (1.0 - i / 6.0) * (math.min(sh.life, 0.5) / 0.5)
        local ch = i == 0 and "✦" or "─"
        local r, g, b = sbg.scale(1.0, 1.0, 1.0, 0.25 + 0.7 * fade)
        fx:put(x, y, ch, r, g, b)
      end
    end
  end
end
