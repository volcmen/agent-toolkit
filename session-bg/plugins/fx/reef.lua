local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local BLEACH = 0.0
local scene = nil
local sig = ""

local DOT = { 1, 2, 4, 8, 16, 32, 64, 128 }

local function jnum(v) return tonumber(v) or 0 end

local function jstr(v, fallback)
  if type(v) == "string" and v ~= "" then return v end
  return fallback
end

local function palette(state)
  local out = {}
  local mood = state.mood or {}
  local p = mood.palette
  if type(p) == "table" then
    for i = 1, 5 do
      local s = p[i]
      if type(s) == "string" and #s >= 7 then
        local v = tonumber(s:sub(2, 7), 16)
        if v then out[#out + 1] = { sbg.hex(v) } end
      end
    end
  end
  if #out < 3 then
    out = {}
    local j = state.journey or {}
    local base = (sbg.hash(jstr(j.repo, "sbg")) % 1000) / 1000.0
    for i = 0, 4 do
      local r, g, b = sbg.hsl(base + i * 0.08, 0.42, 0.40)
      out[#out + 1] = { r, g, b }
    end
  end
  return out
end

local function pal(p, i, k)
  local c = p[((i - 1) % #p) + 1]
  return sbg.scale(c[1], c[2], c[3], k or 1.0)
end

local function sky_colour(pct, k)
  local p = sbg.clamp((tonumber(pct) or 0) / 100.0, 0.0, 1.0)
  local h, l
  if p < 0.5 then
    local u = p * 2.0
    h, l = sbg.lerp(0.06, 0.55, u), sbg.lerp(0.26, 0.40, u)
  else
    local u = (p - 0.5) * 2.0
    h, l = sbg.lerp(0.55, 0.74, u), sbg.lerp(0.40, 0.22, u)
  end
  local r, g, b = sbg.hsl(h, 0.40, l)
  return sbg.scale(r, g, b, k or 1.0)
end

local LAST_ERR = ""
local ERR_AGE = 99.0
local FRESH_ERR = false

local function track_error(state, dt)
  local list = (state.journey or {}).recent
  local fp = nil
  if type(list) == "table" then
    for i = #list, math.max(1, #list - 3), -1 do
      local e = list[i]
      if type(e) == "table" and e.k == "error" then
        fp = tostring(e.t) .. "|" .. tostring(e.tool)
        break
      end
    end
  end
  if fp ~= nil and fp ~= LAST_ERR then
    LAST_ERR = fp
    ERR_AGE = 0.0
  else
    ERR_AGE = ERR_AGE + dt
  end
  FRESH_ERR = ERR_AGE < 3.0
  return FRESH_ERR
end

local function bleached(r, g, b, amt)
  local grey = (r + g + b) / 3.0
  return sbg.mix(r, g, b, grey, grey, grey, sbg.clamp(amt, 0, 1))
end

local function set_dot(cells, x, y, sx, sy, tint)
  if x < 0 or y < 0 or x >= W or y >= H then return end
  local bit
  if sy < 3 then bit = sx * 3 + sy + 1 else bit = 7 + sx end
  local key = y * W + x
  local c = cells[key]
  if c == nil then
    c = { mask = 0, tint = tint }
    cells[key] = c
  end
  local v = DOT[bit]
  if math.floor(c.mask / v) % 2 == 0 then c.mask = c.mask + v end
  if tint > c.tint then c.tint = tint end
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local added = jnum(state.lines_added)
  local floor_y = H - 1
  local clusters = math.max(1, 1 + math.floor(tools / 12))
  local capacity = math.max(1, math.floor(W / 7))
  local first = math.max(0, clusters - capacity)
  local reach = sbg.clamp(2.0 + added / 90.0, 2.0, H * 0.62)
  local cells = {}
  local shown = 0
  for c = first, clusters - 1 do
    local slot = c - first
    local rng = sbg.rng(sbg.hash(jstr(j.repo, "reef") .. "~" .. c) + SEED)
    local bx = math.floor((slot + 0.5) * W / capacity)
    local age = clusters - c
    local grown = sbg.clamp(age / 4.0, 0.3, 1.0)
    local strands = 2 + rng:below(3)
    local tint = sbg.clamp(0.35 + 0.65 * grown, 0.2, 1.0)
    if slot == 0 and first > 0 then tint = tint * 0.45 end
    for s = 1, strands do
      local x = bx * 2 + rng:below(3) - 1
      local y = floor_y * 4 + 3
      local drift = rng:range(-0.45, 0.45)
      local len = math.floor(reach * 4 * grown * rng:range(0.55, 1.0))
      for k = 1, math.min(len, H * 4) do
        y = y - 1
        x = x + drift
        if k % 7 == 0 then drift = drift * -0.7 + rng:range(-0.25, 0.25) end
        if y < 0 then break end
        local cx = math.floor(x / 2)
        local cy = math.floor(y / 4)
        set_dot(cells, cx, cy, math.floor(x) % 2, y % 4, tint)
        shown = shown + 1
        if shown > 6000 then break end
      end
    end
  end
  scene = { cells = cells, floor_y = floor_y, clusters = clusters }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({ jnum(j.tools), jnum(state.lines_added), jstr(j.repo, ""), W, H }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, BLEACH = 0.0, 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end
  if state.mode == "error" or FRESH_ERR then
    BLEACH = math.min(1.0, BLEACH + dt * 1.6)
  else
    BLEACH = math.max(0.0, BLEACH - dt * 0.25)
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local density = sbg.clamp((mod.density or 1.0) * (state.params and state.params.density or 1.0), 0.2, 1.6)
  local speed = tonumber(mod.speed) or 1.0
  local p = palette(state)
  local pct = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)

  local sr, sg, sb = sky_colour(state.context_pct, 0.5)
  for x = 0, W - 1, 4 do
    local y = math.floor(1.5 + 1.5 * sbg.noise2(x * 0.09, T * 0.05))
    fx:put(x, math.max(0, y), "~", sr, sg, sb)
  end

  local plank = math.floor(W * H * 0.012 * (0.3 + pct) * density)
  for i = 1, plank do
    local pr = sbg.rng(SEED + i * 7717)
    local px = pr:range(0, W)
    local py = pr:range(0, H - 1)
    local x = sbg.wrap(px + math.sin(T * 0.3 * speed + i) * 1.5 + T * 0.35 * speed, W)
    local y = sbg.wrap(py - T * 0.12, math.max(1, H - 1))
    local r, g, b = sbg.hsl(0.45, 0.20, 0.22)
    r, g, b = bleached(r, g, b, BLEACH)
    fx:put(math.floor(x), math.floor(y), "·", r, g, b)
  end

  local cr, cg, cb = pal(p, 2, 0.7)
  local sway = math.sin(T * 0.6 * speed) * (mode == "thinking" and 1.2 or 0.6)
  for key, c in pairs(scene.cells) do
    local y = math.floor(key / W)
    local x = key - y * W
    local off = 0
    local lift = (scene.floor_y - y) / math.max(1, scene.floor_y)
    if lift > 0.25 then off = math.floor(sway * lift + 0.5) end
    local r, g, b = sbg.scale(cr, cg, cb, 0.45 + 0.55 * c.tint)
    r, g, b = bleached(r, g, b, BLEACH * 0.9)
    fx:put(x + off, y, sbg.braille(c.mask), r, g, b)
  end

  local gr, gg, gb = pal(p, 4, 0.3)
  for x = 0, W - 1 do
    fx:put(x, scene.floor_y, x % 3 == 0 and "▁" or "▂", gr, gg, gb)
  end

  local fish = math.min(8, math.max(1, math.floor(jnum(j.subagents)) + 1))
  for i = 1, fish do
    local fr = sbg.rng(SEED + i * 2246822519)
    local lane = fr:range(1, math.max(2, H - 3))
    local ph = fr:range(0, 6.28)
    local dir = (i % 2 == 0) and -1.0 or 1.0
    local sp = fr:range(3.0, 6.5) * speed
    local x = sbg.wrap(fr:range(0, W) + dir * T * sp, W)
    local y = sbg.clamp(lane + math.sin(T * 0.9 + ph) * 1.5, 0, H - 2)
    local hue = 0.08 + 0.12 * (i % 3)
    local r, g, b = sbg.hsl(hue, 0.5, 0.40)
    r, g, b = bleached(r, g, b, BLEACH)
    local a, bch = "<", ">"
    if dir < 0 then a, bch = ">", "<" end
    fx:put(math.floor(x), math.floor(y), a, r, g, b)
    fx:put(math.floor(x) + 1, math.floor(y), bch, r, g, b)
  end

  if mode == "thinking" or mode == "tool" then
    local n = math.floor(18 * density * (mode == "tool" and 1.4 or 1.0))
    for i = 1, n do
      local br = sbg.rng(SEED + i * 15485863)
      local bx = br:range(0, W)
      local ph = br:range(0, H)
      local y = sbg.wrap(ph - T * br:range(3.0, 7.0) * speed, math.max(1, H - 1))
      local x = sbg.wrap(bx + math.sin(T * 1.3 + i) * 0.9, W)
      local r, g, b = sbg.hsl(0.52, 0.25, 0.30)
      fx:put(math.floor(x), math.floor(y), y % 2 < 1 and "°" or "·", r, g, b)
    end
  end
end

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
