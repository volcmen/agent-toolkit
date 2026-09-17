local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local RAIN = 0.0
local scene = nil
local sig = ""

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

local KIND_HUE = {
  exec = 0.10, edit = 0.34, read = 0.55, web = 0.50,
  task = 0.78, mcp = 0.88, other = 0.0,
}

local function kind_colour(kind, l)
  local h = KIND_HUE[kind or "other"] or 0.0
  local s = (kind == nil or kind == "other") and 0.05 or 0.55
  return sbg.hsl(h, s, l or 0.42)
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local added = jnum(state.lines_added)
  local ground = H - 1
  local total = 1 + math.floor(tools / 10)
  local towers = {}
  local widths, gaps = {}, {}
  local used, first = 0, 0
  for i = total - 1, 0, -1 do
    local rng = sbg.rng(sbg.hash(jstr(j.repo, "sbg") .. "#" .. i) + SEED)
    local bw = 4 + rng:below(5)
    local gap = 1 + rng:below(2)
    if used + bw + gap > W + 6 then first = i + 1 break end
    widths[i] = bw
    gaps[i] = gap
    used = used + bw + gap
  end
  local mass = sbg.clamp(added / 600.0, 0.0, 1.0)
  local top = math.max(3, math.floor(H * (0.18 + 0.48 * mass)))
  local x = 0
  for i = first, total - 1 do
    local bw = widths[i] or 5
    local rng = sbg.rng(sbg.hash(jstr(j.repo, "sbg") .. "#" .. i) + SEED + 7)
    local age = total - i
    local grown = sbg.clamp(age / 3.0, 0.35, 1.0)
    local bh = math.max(2, math.floor((2 + rng:range(0.35, 1.0) * top) * grown))
    bh = math.min(bh, ground - 2)
    towers[#towers + 1] = {
      i = i, x0 = x, x1 = math.min(W - 1, x + bw - 1), w = bw,
      ytop = ground - bh, h = bh,
      fade = (i == first and first > 0) and 0.45 or 1.0,
      antenna = rng:chance(0.3),
      newest = i == total - 1,
    }
    x = x + bw + (gaps[i] or 1)
    if x >= W then break end
  end
  scene = { towers = towers, ground = ground, total = total }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({ jnum(j.tools), jnum(state.lines_added), jstr(j.repo, ""), W, H }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, RAIN = 0.0, 0.0
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
    RAIN = math.min(1.0, RAIN + dt * 2.5)
  else
    RAIN = math.max(0.0, RAIN - dt * 0.8)
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local density = sbg.clamp((mod.density or 1.0) * (state.params and state.params.density or 1.0), 0.2, 1.6)
  local p = palette(state)
  local pct = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)
  local night = sbg.smoothstep(0.55, 0.95, pct)

  if night > 0.02 then
    local n = math.floor(W * 0.28 * night * density)
    for i = 1, n do
      local sr = sbg.rng(SEED + i * 2654435761)
      local x = sr:below(math.max(1, W))
      local y = sr:below(math.max(1, math.floor(H * 0.55)))
      local tw = 0.5 + 0.5 * math.sin(T * 1.4 + i)
      if tw > 0.3 then
        local r, g, b = sbg.hsl(0.60, 0.15, 0.22 + 0.20 * night * tw)
        fx:put(x, y, tw > 0.85 and "✦" or "·", r, g, b)
      end
    end
    fx:put(math.floor(W * 0.12), math.max(1, math.floor(H * 0.12)), "☾",
      sbg.hsl(0.14, 0.30, 0.30 + 0.20 * night))
  else
    local sr, sg, sb = sky_colour(state.context_pct, 0.6)
    for x = 0, W - 1, 3 do
      local y = math.floor(1 + 2.0 * (1.0 + sbg.noise2(x * 0.06, T * 0.02)))
      fx:put(x, math.min(y, math.floor(H * 0.3)), "☁", sr, sg, sb)
    end
    fx:put(math.floor(W * (0.15 + 0.6 * pct)), math.max(0, math.floor(H * 0.10)), "☀",
      sky_colour(state.context_pct, 1.5))
  end

  local wr, wg, wb = pal(p, 1, 0.42)
  local recent = type(j.recent) == "table" and j.recent or {}
  local nrecent = #recent
  for _, b in ipairs(scene.towers) do
    local r, g, bl = sbg.scale(wr, wg, wb, b.fade)
    for y = b.ytop, scene.ground do
      local ch = "│"
      fx:put(b.x0, y, ch, r, g, bl)
      if b.x1 ~= b.x0 then fx:put(b.x1, y, ch, r, g, bl) end
    end
    for x = b.x0, b.x1 do
      local ch = "─"
      if x == b.x0 then ch = "┌" elseif x == b.x1 then ch = "┐" end
      fx:put(x, b.ytop, ch, r, g, bl)
    end
    if b.antenna and b.ytop > 1 then
      fx:put(math.floor((b.x0 + b.x1) / 2), b.ytop - 1, "╵", sbg.scale(r, g, bl, 0.8))
    end
    local rows = 0
    for y = b.ytop + 2, scene.ground - 1, 2 do
      rows = rows + 1
      local col = 0
      for x = b.x0 + 2, b.x1 - 1, 2 do
        col = col + 1
        local key = b.i * 131 + rows * 17 + col
        local wob = sbg.noise3(key * 0.13, rows * 0.4, T * (mode == "thinking" and 0.35 or 0.06))
        local base = 0.30
        if mode == "thinking" then base = 0.05 end
        if wob > base then
          local lit = 0.5 + 0.5 * wob
          local wr2, wg2, wb2 = sbg.hsl(0.12, 0.45, (0.20 + 0.16 * lit) * b.fade)
          fx:put(x, y, "▪", wr2, wg2, wb2)
        end
      end
    end
    if nrecent > 0 and b.i >= scene.total - 6 then
      local slot = scene.total - b.i
      for k = 0, 2 do
        local e = recent[nrecent - (slot - 1) * 3 - k]
        if type(e) == "table" and b.h > 3 then
          local y = b.ytop + 2 + ((sbg.hash(tostring(e.tool) .. k) % math.max(1, math.floor(b.h / 2) - 1)) * 2)
          local x = b.x0 + 2 + (sbg.hash(tostring(e.t) .. k) % math.max(1, math.floor(b.w / 2))) * 2
          if y < scene.ground and x <= b.x1 - 1 then
            fx:put(x, y, "▣", kind_colour(e.k == "error" and "exec" or state.tool_kind, 0.46))
          end
        end
      end
    end
    if b.newest and (mode == "tool" or (mod.burst or 0) > 0.2) then
      local mast = math.max(1, b.ytop - 4)
      local cx = b.x1
      local cr, cg, cb = sbg.hsl(0.09, 0.55, 0.38)
      for y = mast, b.ytop - 1 do fx:put(cx, y, "│", cr, cg, cb) end
      local jib = math.max(0, cx - 6)
      for x = jib, cx do fx:put(x, mast, "─", cr, cg, cb) end
      local hook = mast + 1 + math.floor(2.5 + 2.5 * math.sin(T * 1.6))
      for y = mast + 1, math.min(hook, b.ytop - 1) do
        fx:put(jib, y, "┆", sbg.scale(cr, cg, cb, 0.7))
      end
      fx:put(jib, math.min(hook, b.ytop - 1), "▣", cr, cg, cb)
    end
  end

  local gr, gg, gb = pal(p, 3, 0.3)
  for x = 0, W - 1 do
    if x % 2 == 0 then fx:put(x, scene.ground, "─", gr, gg, gb) end
  end

  if RAIN > 0.05 then
    local n = math.floor(W * H * 0.035 * RAIN * density)
    for i = 1, n do
      local rr = sbg.rng(SEED + i * 40503)
      local x = rr:below(math.max(1, W))
      local ph = rr:range(0, H)
      local y = sbg.wrap(ph + T * 26.0, math.max(1, H))
      local cr, cg, cb = sbg.hsl(0.58, 0.35, 0.30)
      fx:put(x, math.floor(y), "│", cr, cg, cb)
    end
  end
end

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
