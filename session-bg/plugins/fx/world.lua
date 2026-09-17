local Forest = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local FLASH = 0.0
local FALL = 0.0
local scene = nil
local sig = ""

local EXT_HUE = {
  py = 0.34, rs = 0.055, ts = 0.14, tsx = 0.14, js = 0.14, jsx = 0.14,
  go = 0.50, md = 0.0, txt = 0.0, rst = 0.0, toml = 0.78, json = 0.78,
  yaml = 0.80, yml = 0.80, lua = 0.63, sh = 0.42, rb = 0.98, c = 0.56,
  h = 0.56, cpp = 0.56, java = 0.03, sql = 0.50, css = 0.52, html = 0.03,
}

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

local function ext_colour(ext, l)
  local s, h = 0.48, EXT_HUE[ext]
  if ext == "md" or ext == "txt" or ext == "rst" then s = 0.0 end
  if not h then h = (sbg.hash(ext or "?") % 997) / 997.0 end
  return sbg.hsl(h, s, l or 0.42)
end

local function top_exts(j)
  local list = {}
  for k, v in pairs(j.files or {}) do
    if type(k) == "string" then list[#list + 1] = { k, jnum(v) } end
  end
  table.sort(list, function(a, b)
    if a[2] == b[2] then return a[1] < b[1] end
    return a[2] > b[2]
  end)
  local out = {}
  for i = 1, math.min(4, #list) do out[i] = list[i][1] end
  if #out == 0 then out[1] = "md" end
  return out
end

local function grow(rng, depth, len, ang, left)
  local b = { len = len, ang = ang, kids = {}, leaf = rng:f() }
  if depth > 0 and left[1] > 0 then
    local n = 2
    if depth > 1 and rng:chance(0.45) then n = 3 end
    for k = 1, n do
      if left[1] <= 0 then break end
      left[1] = left[1] - 1
      local side = 1.0
      if k % 2 == 0 then side = -1.0 end
      if n == 3 and k == 3 then side = 0.15 end
      local spread = rng:range(0.26, 0.58) * side
      b.kids[#b.kids + 1] = grow(rng, depth - 1, len * rng:range(0.56, 0.76), spread, left)
    end
  end
  return b
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local added = jnum(state.lines_added)
  local span = math.max(12, W)
  local capacity = math.max(1, math.floor(span / 9))
  local per = math.floor(sbg.clamp(60 / capacity, 2, 12))
  local total = math.floor(tools / per) + 1
  local first = math.max(0, total - capacity)
  local base_depth = math.floor(sbg.clamp(2 + added / 140, 2, 5))
  local ground = H - 1
  local trees = {}
  for i = first, total - 1 do
    local slot = i - first
    local rng = sbg.rng(sbg.hash(jstr(j.repo, "sbg") .. ":" .. i) + SEED)
    local age = total - i
    local maturity = sbg.clamp(age / 5.0, 0.3, 1.0)
    local depth = math.max(2, math.floor(base_depth * maturity + 0.5))
    local trunk = sbg.clamp((2.5 + depth * 1.5) * maturity, 2.0, H * 0.55)
    trees[#trees + 1] = {
      x = math.floor((slot + 0.5) * span / capacity),
      y = ground,
      fade = slot == 0 and total > capacity and 0.45 or 1.0,
      root = grow(rng, depth, trunk, 0.0, { 26 }),
      lean = rng:range(-0.12, 0.12),
      scar = i < first + math.min(jnum(j.errors), 5),
    }
  end
  scene = {
    trees = trees,
    exts = top_exts(j),
    ground = ground,
    sky = math.max(1, math.floor(H * 0.22)),
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(state.lines_added), jnum(j.errors),
    jnum(j.prompts), jstr(j.repo, ""), W, H,
  }, "/")
end

local function draw_branch(fx, b, x, y, ang, sway, depth, colour, leafcol, budget)
  if budget[1] <= 0 then return end
  local n = math.max(1, math.floor(b.len + 0.5))
  local sx = math.sin(ang)
  local sy = -math.cos(ang) * 0.55
  local ch = "│"
  if sx > 0.32 then ch = "╱" elseif sx < -0.32 then ch = "╲" end
  local cx, cy = x, y
  local r, g, bl = colour[1], colour[2], colour[3]
  for _ = 1, n do
    cx, cy = cx + sx, cy + sy
    if budget[1] <= 0 then return end
    budget[1] = budget[1] - 1
    fx:put(math.floor(cx + 0.5), math.floor(cy + 0.5), ch, r, g, bl)
  end
  if #b.kids == 0 then
    local lc = leafcol[math.floor(b.leaf * #leafcol) % #leafcol + 1]
    local glyph = "♣"
    if b.leaf > 0.66 then glyph = "*" elseif b.leaf > 0.33 then glyph = "•" end
    budget[1] = budget[1] - 1
    fx:put(math.floor(cx + 0.5), math.floor(cy + 0.5), glyph, lc[1], lc[2], lc[3])
    return
  end
  for _, kid in ipairs(b.kids) do
    draw_branch(fx, kid, cx, cy, ang + kid.ang + sway * (0.4 + depth * 0.25),
      sway, depth + 1, colour, leafcol, budget)
  end
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, FLASH, FALL = 0.0, 0.0, 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  local mode = state.mode
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end
  if mode == "error" or FRESH_ERR then
    FLASH = math.min(1.0, FLASH + dt * 3.0)
  else
    FLASH = math.max(0.0, FLASH - dt * 1.2)
  end
  if mode == "compacting" then
    FALL = math.min(1.0, FALL + dt * 0.8)
  else
    FALL = math.max(0.0, FALL - dt * 0.35)
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local mode = state.mode
  local mod = state.mod or {}
  local density = sbg.clamp((mod.density or 1.0) * (state.params and state.params.density or 1.0), 0.2, 1.6)
  local p = palette(state)
  local j = state.journey or {}
  local cap = math.floor(W * H * 0.34 * density)
  local budget = { cap }

  local sr, sg, sb = sky_colour(state.context_pct, 0.55)
  for y = 0, scene.sky - 1 do
    for x = 0, W - 1 do
      if budget[1] <= 0 then break end
      local n = sbg.fbm(x * 0.07 + T * 0.02, y * 0.4 + SEED * 0.01, 3)
      if n > 0.34 - y * 0.02 then
        budget[1] = budget[1] - 1
        fx:put(x, y, "☁", sbg.scale(sr, sg, sb, 0.7 + 0.3 * n))
      end
    end
  end
  local pct = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)
  local disc = pct > 0.72 and "☾" or "☀"
  local dx = math.floor(W * (0.15 + 0.7 * pct))
  fx:put(dx, math.max(0, math.floor(scene.sky * 0.4)), disc, sky_colour(state.context_pct, 1.4))

  local leafcol = {}
  for i, e in ipairs(scene.exts) do
    leafcol[i] = { ext_colour(e, 0.38 + 0.05 * (i % 2)) }
  end
  if #leafcol == 0 then leafcol[1] = { pal(p, 2, 0.8) } end

  local wind = 0.0
  if mode == "thinking" then wind = 0.16 * math.sin(T * 1.7)
  elseif mode == "tool" then wind = 0.10 * math.sin(T * 3.4) + 0.1 * (mod.burst or 0)
  elseif mode == "compacting" then wind = 0.22 * math.sin(T * 0.7)
  else wind = 0.05 * math.sin(T * 0.6) end

  local trunk_r, trunk_g, trunk_b = pal(p, 1, 0.55)
  for ti, tr in ipairs(scene.trees) do
    local col = { sbg.scale(trunk_r, trunk_g, trunk_b, tr.fade) }
    local sway = wind * (0.7 + 0.3 * math.sin(T * 1.1 + ti))
    draw_branch(fx, tr.root, tr.x, tr.y, tr.lean + sway * 0.6, sway, 0, col, leafcol, budget)
    if tr.scar then
      local r, g, b = sbg.hsl(0.02, 0.5, 0.30)
      fx:put(tr.x + 1, scene.ground - 1, "°", r, g, b)
    end
    fx:put(tr.x, scene.ground, "♠", sbg.scale(col[1], col[2], col[3], 0.8))
  end

  local gr, gg, gb = pal(p, 3, 0.35)
  for x = 0, W - 1, 2 do
    fx:put(x, scene.ground, "•", gr, gg, gb)
  end

  if mode == "waiting" or mode == "idle" then
    local n = math.floor(6 + jnum(j.waits) * 0.4)
    n = math.min(n, 18)
    for i = 1, n do
      local fr = sbg.rng(SEED + i * 7919)
      local bx = fr:range(0, W)
      local by = fr:range(scene.sky, H - 2)
      local ph = fr:range(0, 6.28)
      local x = sbg.wrap(bx + math.sin(T * 0.4 + ph) * 3.0, W)
      local y = by + math.sin(T * 0.7 + ph * 2) * 1.2
      local blink = 0.5 + 0.5 * math.sin(T * 3.0 + ph)
      if blink > 0.35 then
        local r, g, b = sbg.hsl(0.15, 0.7, 0.30 + 0.25 * blink)
        fx:put(math.floor(x), math.floor(y), "°", r, g, b)
      end
    end
  end

  if FLASH > 0.05 then
    local fr = sbg.rng(SEED + math.floor(T * 2.0) * 31)
    local x = fr:below(math.max(1, W))
    local k = 0.35 + 0.5 * FLASH
    for y = 0, scene.ground - 1 do
      local r, g, b = sbg.hsl(0.13, 0.25, 0.45 * k)
      fx:put(x, y, y % 3 == 1 and "╲" or "│", r, g, b)
      if y % 3 == 1 then x = x + (fr:chance(0.5) and 1 or -1) end
    end
  end

  if FALL > 0.05 then
    local n = math.floor(24 * FALL * density)
    for i = 1, n do
      local fr = sbg.rng(SEED + i * 104729)
      local ph = fr:range(0, 20.0)
      local x = sbg.wrap(fr:range(0, W) + math.sin(T * 0.8 + ph) * 2.5, W)
      local y = sbg.wrap(fr:range(0, H) + T * 2.2, math.max(1, scene.ground))
      local lc = leafcol[(i % #leafcol) + 1]
      fx:put(math.floor(x), math.floor(y), "°", sbg.scale(lc[1], lc[2], lc[3], 0.8))
    end
  end
end
  return M
end)()

local Skyline = (function()
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
  return M
end)()

local Reef = (function()
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
  return M
end)()

local Circuit = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local SPARK = 0.0
local scene = nil
local sig = ""

local KIND_HUE = {
  exec = 0.10, edit = 0.34, read = 0.55, web = 0.48,
  task = 0.78, mcp = 0.88, other = 0.0,
}
local KIND_ORDER = { "exec", "edit", "read", "web", "task", "mcp", "other" }

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

local function kind_colour(kind, l)
  local h = KIND_HUE[kind or "other"]
  local s = 0.5
  if h == nil then
    h = (sbg.hash(tostring(kind)) % 997) / 997.0
  end
  if kind == "other" or kind == nil then s = 0.06 end
  return sbg.hsl(h, s, l or 0.40)
end

local function kind_for(j, index, total)
  local recent = j.recent
  if type(recent) == "table" then
    local back = total - index
    local e = recent[#recent - back]
    if type(e) == "table" and type(e.tool) == "string" then
      if e.k == "error" then return "exec" end
    end
  end
  local kinds = j.tool_kinds or {}
  local weights, sum = {}, 0
  for i, k in ipairs(KIND_ORDER) do
    local v = jnum(kinds[k])
    weights[i] = v
    sum = sum + v
  end
  if sum <= 0 then return "other" end
  local pick = (sbg.hash("k" .. index) % sum)
  for i, k in ipairs(KIND_ORDER) do
    if pick < weights[i] then return k end
    pick = pick - weights[i]
  end
  return "other"
end

local function spiral_slots(cols, rows, limit)
  local slots = {}
  local cx, cy = math.floor(cols / 2), math.floor(rows / 2)
  local x, y = 0, 0
  local dx, dy = 1, 0
  local steps, run, turns = 1, 0, 0
  local guard = 0
  while #slots < limit and guard < 40000 do
    guard = guard + 1
    local gx, gy = cx + x, cy + y
    if gx >= 0 and gy >= 0 and gx < cols and gy < rows then
      slots[#slots + 1] = { gx, gy }
    end
    x, y = x + dx, y + dy
    run = run + 1
    if run == steps then
      run = 0
      dx, dy = -dy, dx
      turns = turns + 1
      if turns % 2 == 0 then steps = steps + 1 end
    end
    if steps > cols + rows then break end
  end
  return slots
end

local function trace(x0, y0, x1, y1)
  local cells = {}
  local step = x1 > x0 and 1 or -1
  if x0 ~= x1 then
    for x = x0 + step, x1 - step, step do
      cells[#cells + 1] = { x, y0, "─" }
    end
  end
  if y0 ~= y1 then
    local corner = "┐"
    if step > 0 and y1 > y0 then corner = "┐"
    elseif step > 0 and y1 < y0 then corner = "┘"
    elseif step < 0 and y1 > y0 then corner = "┌"
    else corner = "└" end
    cells[#cells + 1] = { x1, y0, corner }
    local vstep = y1 > y0 and 1 or -1
    for y = y0 + vstep, y1 - vstep, vstep do
      cells[#cells + 1] = { x1, y, "│" }
    end
  end
  return cells
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local added = jnum(state.lines_added)
  local gw = 6
  local gh = 3
  local cols = math.max(1, math.floor((W - 2) / gw))
  local rows = math.max(1, math.floor((H - 2) / gh))
  local growth = math.floor(sbg.clamp(12 + added / 10.0, 12, 160))
  local limit = math.min(cols * rows, growth)
  local slots = spiral_slots(cols, rows, limit)
  local total = 1 + math.floor(tools)
  local cap = #slots
  local first = math.max(0, total - cap)
  local nodes = {}
  local traces = {}
  local px, py
  for i = first, total - 1 do
    local s = slots[i - first + 1]
    if s == nil then break end
    local x = 1 + s[1] * gw + math.floor(gw / 2)
    local y = 1 + s[2] * gh + math.floor(gh / 2)
    local age = (total - i) / math.max(1, cap)
    local n = {
      x = x, y = y, i = i,
      kind = kind_for(j, i, total),
      fade = sbg.clamp(1.15 - age * 0.9, 0.22, 1.0),
    }
    nodes[#nodes + 1] = n
    if px ~= nil then
      traces[#traces + 1] = { cells = trace(px, py, x, y), fade = n.fade }
    end
    px, py = x, y
  end
  scene = { nodes = nodes, traces = traces, cols = cols, rows = rows }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({ jnum(j.tools), jnum(state.lines_added), jstr(j.repo, ""), W, H }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, SPARK = 0.0, 0.0
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
    SPARK = math.min(1.0, SPARK + dt * 4.0)
  else
    SPARK = math.max(0.0, SPARK - dt * 1.5)
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local mode = state.mode
  local mod = state.mod or {}
  local density = sbg.clamp((mod.density or 1.0) * (state.params and state.params.density or 1.0), 0.2, 1.6)
  local p = palette(state)
  local ntr = #scene.traces
  local tr0, tg0, tb0 = pal(p, 1, 1.0)

  local br, bg, bb = sky_colour(state.context_pct, 0.30)

  local vr, vg, vb = pal(p, 1, 0.75)
  local vias = (mode == "compacting") and 2 or 1
  for cy = 0, scene.rows - 1, vias do
    for cx = 0, scene.cols - 1, vias do
      local twinkle = (sbg.hash(cx * 131 + cy) % 7) == 0 and (math.floor(T * 1.5 + cx) % 5 == 0)
      fx:put(1 + cx * 6 + 3, 1 + cy * 3 + 1, twinkle and "∙" or "·", vr, vg, vb)
    end
  end

  for ti, tr in ipairs(scene.traces) do
    local k = 0.30 + 0.45 * tr.fade
    local r, g, b = sbg.mix(br, bg, bb, tr0, tg0, tb0, 0.65)
    r, g, b = sbg.scale(r, g, b, k)
    for _, c in ipairs(tr.cells) do
      fx:put(c[1], c[2], c[3], r, g, b)
    end
    local live = (mode == "thinking") or (mode == "tool") or (mod.burst or 0) > 0.2
    if live and ti > ntr - 8 and #tr.cells > 0 then
      local speed = (mode == "tool") and 14.0 or 7.0
      local pos = math.floor(sbg.wrap(T * speed + ti * 3.0, #tr.cells)) + 1
      local c = tr.cells[pos]
      if c then
        local pr, pg, pb = pal(p, 4, 1.0)
        fx:put(c[1], c[2], "●", sbg.scale(pr, pg, pb, 0.65))
      end
    end
  end

  for _, n in ipairs(scene.nodes) do
    local r, g, b = kind_colour(n.kind, 0.30 + 0.16 * n.fade)
    local glyph = "▣"
    if n.fade < 0.45 then glyph = "▫"
    elseif n.fade < 0.8 then glyph = "▪" end
    fx:put(n.x, n.y, glyph, r, g, b)
  end

  local last = scene.nodes[#scene.nodes]
  if last then
    local beat = 0.5 + 0.5 * math.sin(T * (mode == "thinking" and 5.0 or 2.0))
    local r, g, b = kind_colour(state.tool_kind or last.kind, 0.34 + 0.22 * beat)
    fx:put(last.x, last.y, "◉", r, g, b)
    if mode == "waiting" then
      local ring = 1 + math.floor(sbg.wrap(T * 2.0, 3.0))
      local rr, rg, rb = sbg.hsl(0.58, 0.25, 0.26)
      fx:put(last.x - ring, last.y, "·", rr, rg, rb)
      fx:put(last.x + ring, last.y, "·", rr, rg, rb)
    end
  end

  if SPARK > 0.05 and last then
    local n = math.floor(14 * SPARK * density)
    for i = 1, n do
      local sr = sbg.rng(SEED + i * 99991 + math.floor(T * 6.0) * 13)
      local a = sr:range(0, 6.28318)
      local rad = sr:range(1.0, 6.0) * SPARK
      local x = math.floor(last.x + math.cos(a) * rad * 2.0)
      local y = math.floor(last.y + math.sin(a) * rad)
      local cr, cg, cb = sbg.hsl(0.12, 0.55, 0.34 + 0.16 * SPARK)
      fx:put(x, y, sr:chance(0.5) and "✦" or "✧", cr, cg, cb)
    end
  end

  if mode == "compacting" then
    local edge = sbg.wrap(T * 18.0, W + 10)
    for y = 0, H - 1, 2 do
      local x = math.floor(edge - (y % 4))
      if x >= 0 and x < W then
        local cr, cg, cb = pal(p, 5, 0.5)
        fx:put(x, y, "│", cr, cg, cb)
      end
    end
  end
end
  return M
end)()

local Office = (function()
-- GENERATED by scripts/world/bundle.py; edit plugins/fx/fortress/*.lua.
local Sim = (function()
-- Pure, bounded event simulation. No renderer, host time, I/O, or shared RNG.
local Sim = {}
Sim.__index = Sim
Sim.VERSION = 2
Sim.CAPS = { dwarves=12, rooms=48, items=96, jobs=32, incidents=8, artifacts=16, legends=128, announcements=16 }
local KINDS = {"exec", "edit", "read", "web", "task", "mcp", "other"}
local SKILLS = {"plan", "exec", "edit", "read", "trade", "craft"}
local COUNTERS = {"prompts", "tools", "errors", "compactions", "waits", "subagents", "subagents_peak"}
local NEEDS = {"rest", "craft", "knowledge", "fellowship"}
local PREFIX = {"Ember", "Moss", "Copper", "Slate", "Quiet", "Silver", "Amber", "River"}
local SUFFIX = {"hold", "deep", "gate", "hall", "reach", "haven"}
local FIRST = {"Ari", "Bera", "Corin", "Dena", "Evan", "Fenn", "Galen", "Hali"}
local LAST = {"Copperhand", "Mosskeeper", "Slatewright", "Riverward", "Ashweaver", "Brightpick"}
local function num(v) return math.max(0, math.floor(tonumber(v) or 0)) end
local function clone(v)
  if type(v) ~= "table" then return v end
  local o = {}; for k,x in pairs(v) do o[k] = clone(x) end; return o
end
function Sim.hash(text)
  local h = 5381
  text = tostring(text)
  for i=1,#text do h = (h * 33 + text:byte(i)) % 2147483647 end
  return h
end
function Sim.roll(seed, seq, tag, n)
  return Sim.hash(tostring(seed)..":"..tostring(seq)..":"..tag) % n + 1
end
function Sim.safe(word, fallback)
  if type(word) ~= "string" or #word < 4 or #word > 16 or not word:match("^[a-z]+$") then return fallback or "craft" end
  for _,bad in ipairs({"secret", "password", "token", "apikey", "bearer", "credential"}) do
    if word:find(bad, 1, true) then return fallback or "craft" end
  end
  return word
end
function Sim.digest(c)
  local parts = {}
  for _,k in ipairs(COUNTERS) do parts[#parts+1] = tostring(num(c[k])) end
  for _,k in ipairs(KINDS) do parts[#parts+1] = tostring(num((c.tool_kinds or {})[k])) end
  return table.concat(parts, ":")
end
function Sim.canonical(v)
  if type(v) ~= "table" then return type(v)..":"..tostring(v) end
  local keys, out = {}, {}
  for k in pairs(v) do keys[#keys+1] = k end
  table.sort(keys, function(a,b) return tostring(a)<tostring(b) end)
  for _,k in ipairs(keys) do out[#out+1] = tostring(k).."="..Sim.canonical(v[k]) end
  return "{"..table.concat(out,";").."}"
end
function Sim:hash_state() return Sim.hash(Sim.canonical(self:snapshot())) end
function Sim:title(xp)
  local title = "Novice"
  for _,v in ipairs({{5,"Adequate"},{20,"Skilled"},{80,"Expert"},{320,"Legendary"}}) do
    if xp >= v[1] then title = v[2] end
  end
  return title
end
function Sim:id() self.next_id=self.next_id+1; return self.next_id end
function Sim:legend(kind, text, ref, priority)
  local e = {id=self:id(), seq=self.seq, tick=self.clock, year=self.year, kind=kind,
    text=text, ref=ref or 0, priority=priority or 1}
  self.legends[#self.legends+1]=e
  if #self.legends > Sim.CAPS.legends then
    local old=table.remove(self.legends,1)
    self.summary[old.kind]=(self.summary[old.kind] or 0)+1
    self.evicted=self.evicted+1
    self.evicted_through=old.id
  end
  if e.priority>1 or self.clock-self.last_announcement>=80 then
    if e.priority<=1 then self.last_announcement=self.clock end
    if not self.announcement or e.priority>self.announcement.priority then
      self.announcement=clone(e); self.announcement_until=self.clock+16
    else
      self.announcements[#self.announcements+1]=clone(e)
      table.sort(self.announcements,function(a,b)
        if a.priority~=b.priority then return a.priority>b.priority end
        return a.id<b.id
      end)
      if #self.announcements>Sim.CAPS.announcements then table.remove(self.announcements) end
    end
  end
  return e.id
end
function Sim:dwarf(role)
  local id=self:id()
  local skills,needs={},{}
  for _,k in ipairs(SKILLS) do skills[k]=0 end
  for _,k in ipairs(NEEDS) do needs[k]=0 end
  local d={id=id, name=FIRST[Sim.roll(self.seed,id,"first",#FIRST)].." "..LAST[Sim.roll(self.seed,id,"last",#LAST)],
    role=role, skills=skills, needs=needs, mood="content", home=1, job=0}
  self.dwarves[#self.dwarves+1]=d
  return d
end
function Sim:room(kind)
  if #self.rooms >= Sim.CAPS.rooms then return self.rooms[#self.rooms] end
  local r={id=self:id(), kind=kind, z=self.z, level=1, theme="stone", engraving=""}
  self.rooms[#self.rooms+1]=r
  return r
end
function Sim.new(seed, identity)
  local s=setmetatable({schema_version=Sim.VERSION, seed=seed, identity=identity or tostring(seed),
    seq=0, clock=0, next_id=0, year=1, z=0, stress=0, wealth=0, quarry=0,
    profile="classic", subject="craft", material="stone", crew=0, store=0,
    dwarves={}, rooms={}, items={}, jobs={}, incidents={}, artifacts={}, legends={}, summary={},
    announcements={}, announcement=false, announcement_until=0, last_announcement=-80,
    evicted=0, evicted_through=0, failures={}, cooldown=0, last_artifact=-6000,
    counts={prompts=0,tools=0,errors=0,compactions=0,waits=0,subagents=0,subagents_peak=0,tool_kinds={}},
    mood_arc=false, cave_until=0, gap_to=0, last_routine=-80},Sim)
  for _,k in ipairs(KINDS) do s.counts.tool_kinds[k]=0 end
  s.name=PREFIX[Sim.roll(seed,0,"fortress-prefix",#PREFIX)]..SUFFIX[Sim.roll(seed,0,"fortress-suffix",#SUFFIX)]
  s:dwarf("founder"); s:room("plan"); s:room("workshop"); s:room("rest")
  return s
end
function Sim:snapshot()
  local o={}; for k,v in pairs(self) do o[k]=clone(v) end; return o
end
function Sim.restore(data, identity)
  if type(data)~="table" or data.schema_version~=Sim.VERSION or data.identity~=identity then return nil end
  local function finite(v) return type(v)=="number" and v==v and v>=0 and v<9007199254740991 end
  for _,k in ipairs({"seed","clock","seq","next_id","year","z","stress","wealth","quarry","crew","store","evicted","evicted_through","cooldown","cave_until","gap_to"}) do
    if not finite(data[k]) then return nil end
  end
  if type(data.name)~="string" or #data.name>24 or not data.name:match("^[A-Za-z][A-Za-z -]+$") then return nil end
  if type(data.counts)~="table" or type(data.counts.tool_kinds)~="table" or type(data.summary)~="table" or type(data.failures)~="table" or #data.failures>6 then return nil end
  for _,k in ipairs(COUNTERS) do if not finite(data.counts[k]) then return nil end end
  for _,k in ipairs(KINDS) do if not finite(data.counts.tool_kinds[k]) then return nil end end
  for k,cap in pairs(Sim.CAPS) do if type(data[k])~="table" or #data[k]>cap then return nil end end
  if #data.dwarves<1 or #data.rooms<1 then return nil end
  if data.announcement~=false and (type(data.announcement)~="table" or not finite(data.announcement.priority) or type(data.announcement.text)~="string" or not finite(data.announcement_until) or data.announcement_until<data.clock) then return nil end
  if type(data.last_announcement)~="number" then return nil end
  for _,d in ipairs(data.dwarves) do
    if type(d)~="table" or not finite(d.id) or type(d.name)~="string" or not finite(d.job) or type(d.skills)~="table" or type(d.needs)~="table" then return nil end
    for _,k in ipairs(SKILLS) do if not finite(d.skills[k]) then return nil end end
    for _,k in ipairs(NEEDS) do if not finite(d.needs[k]) then return nil end end
  end
  for _,r in ipairs(data.rooms) do
    if type(r)~="table" or not finite(r.id) or type(r.kind)~="string" or type(r.engraving)~="string" or not finite(r.level) then return nil end
  end
  for _,e in ipairs(data.incidents) do if type(e)~="table" or not finite(e.expires) or e.expires<data.clock or type(e.kind)~="string" then return nil end end
  for _,j in ipairs(data.jobs) do if type(j)~="table" or not finite(j.id) or not finite(j.expires) or not finite(j.target) or type(j.kind)~="string" then return nil end end
  for _,e in ipairs(data.legends) do if type(e)~="table" or not finite(e.tick) or type(e.text)~="string" or not finite(e.priority) then return nil end end
  if data.mood_arc~=false and (type(data.mood_arc)~="table" or not finite(data.mood_arc.expires) or data.mood_arc.expires<data.clock) then return nil end
  -- Remaining compatibility errors are contained by pcall in the adapter.
  return setmetatable(clone(data),Sim)
end
function Sim:close_incident(index, message)
  local e=table.remove(self.incidents,index)
  if e then self:legend(e.kind.."_close",message,e.open,3) end
end
function Sim:incident(kind, duration, text, severity)
  for _,e in ipairs(self.incidents) do if e.kind==kind then return e end end
  if #self.incidents>=Sim.CAPS.incidents then self:close_incident(1,"The watch stands down.") end
  local e={id=self:id(),kind=kind,severity=severity or 1,expires=self.clock+duration,opened=self.clock}
  e.open=self:legend(kind.."_open",text,0,kind=="ambush" and 5 or 3)
  self.incidents[#self.incidents+1]=e
  return e
end
function Sim:expire(target)
  -- Resolve timed arcs at their own tick, independent of delivery batch size.
  while true do
    local next_tick=target+1
    for _,e in ipairs(self.incidents) do next_tick=math.min(next_tick,e.expires) end
    if self.mood_arc then next_tick=math.min(next_tick,self.mood_arc.expires) end
    if self.announcement then next_tick=math.min(next_tick,self.announcement_until) end
    if next_tick>target then break end
    self.clock=next_tick
    if self.announcement and self.announcement_until<=next_tick then
      self.announcement=table.remove(self.announcements,1) or false
      self.announcement_until=self.announcement and next_tick+16 or 0
    end
    for i=#self.incidents,1,-1 do
      local e=self.incidents[i]
      if e.expires<=next_tick then
        local msg=e.kind=="caravan" and "The caravan departs; its findings join the archive." or
          e.kind=="mandate" and "The mandate lapses without a recorded decision." or "The watch stands down."
        if e.kind=="ambush" then self.cooldown=next_tick+120 end
        self:close_incident(i,msg)
      end
    end
    if self.mood_arc and self.mood_arc.expires<=next_tick then
      local arc=self.mood_arc; self.mood_arc=false
      local a={id=self:id(),name=arc.name,quality=arc.quality,room=arc.room,tick=next_tick,seq=arc.seq,parent=arc.parent}
      self.artifacts[#self.artifacts+1]=a
      self.last_artifact=next_tick
      local line=arc.dwarf.." has completed a masterwork: "..a.name.."."
      if #self.artifacts>1 then line=line.." Its patterns recall "..self.artifacts[#self.artifacts-1].name.."." end
      self:legend("artifact",line,arc.open,6)
    end
  end
end
function Sim:advance(target)
  target=math.max(self.clock,num(target))
  local elapsed=target-self.clock
  self:expire(target)
  self.clock=target
  self.stress=math.max(0,self.stress-elapsed/8)
  for i=#self.jobs,1,-1 do
    if self.jobs[i].expires<=target then
      local id=self.jobs[i].id
      for _,d in ipairs(self.dwarves) do if d.job==id then d.job=0 end end
      table.remove(self.jobs,i)
    else
      self.jobs[i].progress=math.max(0,math.min(1,(target-self.jobs[i].expires+24)/24))
    end
  end
  for _,d in ipairs(self.dwarves) do
    for _,k in ipairs(NEEDS) do d.needs[k]=math.max(0,d.needs[k]-elapsed/16) end
    d.mood=self.stress>12 and "strained" or (d.job~=0 and "focused" or "content")
    if self.mood_arc and d.name==self.mood_arc.dwarf then d.mood="inspired" end
  end
end
function Sim:tick(n) self:advance(self.clock+num(n)) end
function Sim:job(kind)
  local d=self.dwarves[1]
  for _,v in ipairs(self.dwarves) do if v.skills[kind]>d.skills[kind] then d=v end end
  for i=#self.jobs,1,-1 do if self.jobs[i].owner==d.id then table.remove(self.jobs,i) end end
  d.skills[kind]=d.skills[kind]+1
  for _,threshold in ipairs({5,20,80,320}) do
    if d.skills[kind]==threshold then
      local role=({plan="Planner",exec="Mechanic",edit="Mason",read="Archivist",trade="Broker",craft="Engraver"})[kind]
      self:legend("skill",d.name.." becomes a "..self:title(threshold).." "..role..".",0,2)
    end
  end
  local job={id=self:id(),kind=kind,owner=d.id,target=1+(self.counts.tools % #self.rooms),
    source_seq=self.seq,progress=0,expires=self.clock+24}
  self.jobs[#self.jobs+1]=job; d.job=job.id
  d.mood="focused"; d.needs.rest=math.min(100,d.needs.rest+2)
  d.needs.knowledge=math.min(100,d.needs.knowledge+1)
  d.needs.craft=math.min(100,d.needs.craft+1)
  d.needs.fellowship=math.min(100,d.needs.fellowship+1)
  d.needs[kind=="read" and "knowledge" or "craft"]=0
  if #self.jobs>Sim.CAPS.jobs then table.remove(self.jobs,1) end
end
function Sim:population(count, silent)
  count=num(count)
  self.crew=math.max(0,count+1-Sim.CAPS.dwarves)
  while #self.dwarves<math.min(Sim.CAPS.dwarves,count+1) do
    local d=self:dwarf("resident")
    if not silent then self:legend("migrant",d.name.." arrives to work below.",0,4) end
  end
  while #self.dwarves>count+1 do
    local d=table.remove(self.dwarves)
    for i=#self.jobs,1,-1 do if self.jobs[i].owner==d.id then table.remove(self.jobs,i) end end
    if not silent then self:legend("departure",d.name.." departs; the work is remembered.",0,4) end
  end
end
function Sim:inspire()
  if self.mood_arc or #self.artifacts>=Sim.CAPS.artifacts or self.clock-self.last_artifact<6000 then return end
  if self.counts.tools<150 and self.clock<4800 then return end
  local d=self.dwarves[1]; local best=0
  for _,v in ipairs(self.dwarves) do for _,k in ipairs(SKILLS) do if v.skills[k]>best then d,best=v,v.skills[k] end end end
  if best<20 then return end
  self.last_artifact=self.clock
  local name=PREFIX[Sim.roll(self.seed,self.seq,"artifact",#PREFIX)]..self.material.." "..self.subject
  local open=self:legend("inspiration",d.name.." claims a workshop. The work continues.",0,6)
  self.mood_arc={name=name,expires=self.clock+8+Sim.roll(self.seed,self.seq,"inspiration-time",5)-1,
    dwarf=d.name,quality=self:title(best),room=1,seq=self.seq,open=open,parent=#self.artifacts>0 and self.artifacts[#self.artifacts].id or 0}
  d.mood="inspired"
end
function Sim:push(e)
  if type(e)~="table" or num(e.seq)<=self.seq then return false end
  self:advance(e.tick)
  self.seq=num(e.seq)
  local p=type(e.payload)=="table" and e.payload or {}
  local k=e.kind
  if k=="embark" then self:legend("embark","The founders raise the gate of "..self.name..".",0,4)
  elseif k=="prompt" then
    self.counts.prompts=self.counts.prompts+1
    self.subject=Sim.safe(type(p.words)=="table" and p.words[1])
    self:legend("chapter","A new chapter begins: "..self.subject..".",0,1)
    self.rooms[1].engraving=self.subject
    self:job("plan")
  elseif k=="tool" then
    local kind="other"; for _,v in ipairs(KINDS) do if p.kind==v then kind=v end end
    self.counts.tools=self.counts.tools+1; self.counts.tool_kinds[kind]=self.counts.tool_kinds[kind]+1
    local jobkind=({web="trade",mcp="trade",task="plan",other="craft"})[kind] or kind
    self:job(jobkind)
    if kind=="web" or kind=="mcp" then self:incident("caravan",32,"A caravan reaches the gate, bearing "..self.subject..".") end
    if kind=="edit" then
      self.store=self.store+1
      if #self.items<Sim.CAPS.items then self.items[#self.items+1]={id=self:id(),kind="block",room=1,quality="worked"} end
    end
    self.material=({rs="steel",py="slate",ts="copper",lua="amber",go="iron"})[p.ext] or self.material
    local target=math.min(Sim.CAPS.rooms,3+math.floor(self.counts.tools/15))
    while #self.rooms<target do self:room(jobkind) end
    self:inspire()
  elseif k=="success" then
    self.stress=math.max(0,self.stress-6)
    for i=#self.incidents,1,-1 do if self.incidents[i].kind=="ambush" then
      self:close_incident(i,self.profile=="calm" and "The setback clears; work resumes." or "The raid is broken; work resumes."); self.cooldown=self.clock+120; self.failures={}
    end end
    for _,d in ipairs(self.dwarves) do d.job=0 end; self.jobs={}
  elseif k=="tool_failed" then
    self.counts.errors=self.counts.errors+1
    self.stress=math.min(30,self.stress+(self.profile=="calm" and 4 or 8))
    local f={}; for _,t in ipairs(self.failures) do if self.clock-t<=360 then f[#f+1]=t end end
    f[#f+1]=self.clock; while #f>6 do table.remove(f,1) end; self.failures=f
    if self.clock>=self.cooldown then
      local severity=#f>=6 and 3 or (#f>=3 and 2 or 1)
      local text=self.profile=="calm" and "A setback reaches the workshop; the watch gathers." or
        (self.profile=="chaos" and "Drums echo in the tunnels; an ambush reaches the gate." or "An ambush strikes the gate.")
      local incident=self:incident("ambush",240,text,severity)
      if severity>incident.severity then
        incident.severity=severity
        self:legend("escalation",self.profile=="calm" and "The watch reinforces the workshop." or (severity==3 and "A siege gathers at the gate." or "The ambush grows into a raid."),incident.open,5)
      end
    end
  elseif k=="wait_open" then
    self.counts.waits=self.counts.waits+1
    self.stress=math.min(30,self.stress+(self.profile=="calm" and 1 or 2))
    self:incident("mandate",240,"A mandate awaits judgment at the gate.")
  elseif k=="wait_resolved" then
    local outcome=({fulfilled="fulfilled",declined="declined"})[p.outcome] or "resolved"
    for i=#self.incidents,1,-1 do if self.incidents[i].kind=="mandate" then self:close_incident(i,"The mandate is "..outcome..". The work continues.") end end
  elseif k=="subagent_start" or k=="subagent_stop" then
    self.counts.subagents=num(p.count); self.counts.subagents_peak=math.max(self.counts.subagents_peak,self.counts.subagents)
    self:population(self.counts.subagents)
  elseif k=="compact" then
    self.counts.compactions=self.counts.compactions+1
    self:legend("year_end",string.format("Year %d closes with %d labors and %d named works.",self.year,self.counts.tools,#self.artifacts),0,5)
    for i=#self.incidents,1,-1 do self:close_incident(i,"The old gallery is sealed; the watch returns.") end
    self.jobs={}; self.items={}; for _,d in ipairs(self.dwarves) do d.job=0 end
    self.z=self.z+1; self.year=self.year+1; self.cave_until=self.clock+12
    for _,r in ipairs(self.rooms) do r.z=self.z end
    self:legend("cave_in","A deep rumble passes; the old gallery is sealed.",0,5)
  elseif k=="idle" then
    self.jobs={}; for _,d in ipairs(self.dwarves) do d.job=0; d.mood="content" end
    if self.clock-self.last_routine>=80 then
      self.last_routine=self.clock
      if #self.legends>0 then
        local past=self.legends[Sim.roll(self.seed,self.seq,"engraving",#self.legends)]
        self.rooms[1].engraving=past.text
        self.rooms[1].legend_id=past.id
      end
    end
  end
  self:advance(self.clock)
  return true
end
function Sim:reconcile(j)
  if num(j.seq)<self.seq then return end
  self:advance(j.tick)
  self.seq=num(j.seq)
  if self.gap_to~=self.seq then
    self.gap_to=self.seq
    self:legend("chronicle_gap","A passage of the chronicle is missing; totals are reconciled.",0,5)
  end
  for _,k in ipairs(COUNTERS) do self.counts[k]=num(j[k]) end
  for _,k in ipairs(KINDS) do self.counts.tool_kinds[k]=num((j.tool_kinds or {})[k]) end
  self:population(self.counts.subagents, true)
  for i=#self.incidents,1,-1 do self:close_incident(i,"The record is incomplete; the watch stands down.") end
  self.jobs={}; for _,d in ipairs(self.dwarves) do d.job=0 end
  self.z=self.counts.compactions; self.year=self.z+1
  while #self.rooms<math.min(Sim.CAPS.rooms,3+math.floor(self.counts.tools/15)) do self:room("archive") end
end
function Sim:observe(state)
  self.wealth=math.max(self.wealth,num(state.lines_added))
  self.quarry=math.max(self.quarry,num(state.lines_removed))
  for _,r in ipairs(self.rooms) do r.level=math.min(5,1+math.floor(self.wealth/500)) end
end
function Sim:configure(params)
  params=params or {}
  if params.difficulty=="calm" or params.difficulty=="classic" or params.difficulty=="chaos" then self.profile=params.difficulty end
  if type(params.fortress)=="string" and #params.fortress<=24 and params.fortress:match("^[A-Za-z][A-Za-z -]+$") and params.fortress~=self.name then
    self.name=params.fortress
    self:legend("renamed","The fortress is now known as "..self.name..".",0,3)
  end
end
return Sim

end)()
local View = (function()
-- Stateless layout/renderer. Simulation tables are read only here.
local View = {}
View.colours = {neutral={0.38,0.49,0.56}, amber={0.60,0.43,0.20}, red={0.57,0.28,0.28},
  violet={0.52,0.38,0.64}, wall={0.25,0.32,0.38}, floor={0.16,0.22,0.23}, green={0.30,0.43,0.33}}
function View.season(pct)
  return ({"spring","summer","autumn","winter"})[1+math.min(3,math.floor(math.max(0,tonumber(pct) or 0)/25))]
end
function View.layout(world,w,h)
  local strip=math.max(1,math.min(40,math.floor(w*0.18)))
  local cols=w>=160 and 2 or 1
  local room_w=math.max(4,math.floor(strip/cols)-1)
  local room_h=h>=45 and 8 or 6
  local rows=math.max(0,math.floor((h-7)/(room_h+1)))
  local out={w=w,h=h,strip=strip,rooms={},centre={x=strip,y=0,w=math.max(0,w-2*strip),h=h}}
  if w<60 or h<16 then out.decoration={}; return out end
  local slots=rows*cols
  for i,r in ipairs(world.rooms) do
    local side=(i-1)//math.max(1,slots)
    if side>1 or (side==1 and w<120 and i>slots+1) then break end
    local slot=(i-1)%math.max(1,slots)
    local col=slot%cols; local row=slot//cols
    local x=side==0 and (1+col*(room_w+1)) or (w-strip+col*(room_w+1))
    if x+room_w<=w and room_w>=4 then
      out.rooms[#out.rooms+1]={id=r.id,index=i,x=x,y=3+row*(room_h+1),w=room_w,h=room_h}
    end
  end
  out.decoration=View.decorate(world,out)
  return out
end
local function glyph(kind)
  return ({plan="?",exec="=",edit="=",read="?",trade="*",craft="=",rest="~",archive=":"})[kind] or "="
end
function View.decorate(world,layout)
  local w,h,strip,rooms=layout.w,layout.h,layout.strip,layout.rooms
  local layers,seen={{},{},{},{},{},{}},{}
  local function put(x,y,ch,colour,priority)
    if x<0 or y<0 or x>=w or y>=h or (x>=strip and x<w-strip) or ch==" " then return end
    local key=y*w+x
    if seen[key] then return end
    seen[key]=true
    local list=layers[(priority or 3)+1]
    list[#list+1]={x=x,y=y,ch=ch,c=View.colours[colour] or View.colours.neutral,floor=colour=="floor"}
  end
  local function text(x,y,s,max,colour,priority)
    for i=1,math.min(#s,max) do put(x+i-1,y,s:sub(i,i),colour,priority) end
  end
  for _,r in ipairs(rooms) do
    local source=world.rooms[r.index]
    local label=source.kind:sub(1,math.max(0,r.w-4))
    text(r.x+2,r.y,label,r.w-3,"neutral",2)
    put(r.x+r.w-1,r.y+2,"+","amber",2)
    put(r.x+1,r.y+1,glyph(source.kind),"neutral",2)
    if source.engraving~="" then put(r.x+1,r.y+r.h-2,"'","violet",3) end
    for x=r.x,r.x+r.w-1 do put(x,r.y,"#","wall",3); put(x,r.y+r.h-1,"#","wall",3) end
    for y=r.y+1,r.y+r.h-2 do put(r.x,y,"#","wall",3); put(r.x+r.w-1,y,"#","wall",3) end
    for y=r.y+1,r.y+r.h-2 do for x=r.x+1,r.x+r.w-2 do
      if (x+y)%3==0 then put(x,y,".","floor",4) end
    end end
    if source.level>1 then put(r.x+r.w-2,r.y+1,tostring(source.level),"amber",2) end
  end
  -- Seeded rock/veins provide a visible embark without inventing earned rooms.
  for y=3,h-3 do for _,left in ipairs({0,w-strip}) do for x=left,left+strip-1 do
    local n=(x*17+y*31+world.seed)%13
    if n<2 then put(x,y,n==0 and ":" or ".","floor",5) end
  end end end
  if world.z>0 then text(0,h-3,"< sealed gallery",strip,"wall",4) end
  return layers
end
function View.render(fx,world,layout,state,phase)
  local w,h,strip=layout.w,layout.h,layout.strip
  if w<1 or h<1 then return end
  local occupied={}
  local density=math.max(0.1,math.min(3,tonumber((state.params or {}).density) or 1))
  local budget=math.floor(w*h*math.min(0.25,0.15*density))
  local drawn=fx:count()
  local function put(x,y,ch,colour,priority)
    if x<0 or y<0 or x>=w or y>=h or (x>=strip and x<w-strip) or ch==" " then return end
    local key=y*w+x
    local cap=priority==0 and math.floor(w*h*0.25) or budget
    if occupied[key] or drawn>=cap then return end
    occupied[key]=true
    local c=type(colour)=="table" and colour or (View.colours[colour] or View.colours.neutral)
    fx:put(x,y,ch,c[1],c[2],c[3]); drawn=drawn+1
  end
  local function text(x,y,s,max,colour,priority)
    for i=1,math.min(#s,max) do put(x+i-1,y,s:sub(i,i),colour,priority) end
  end
  local season=View.season(state.context_pct)
  text(0,0,world.name,strip,"neutral",0)
  text(0,1,string.format("Y%d %s",world.year,season),strip,"green",0)
  text(w-strip,0,string.format("%dd +%dc",#world.dwarves,world.crew),strip,"neutral",0)
  text(w-strip,1,string.format("z%d $%d",world.z,world.wealth),strip,"neutral",0)
  -- Fixed edge segments; no scrolling banner through foreground text.
  local latest=world.announcement
  if latest and h>3 then
    local labels={embark="Gate raised",chapter="New chapter",migrant="Specialist in",departure="Departure",
      inspiration="Strange mood",artifact="Masterwork",caravan_open="Caravan arrives",caravan_close="Caravan leaves",
      mandate_open="Decision waits",mandate_close="Decision noted",ambush_open="Watch gathers",escalation="Gate reinforced",
      ambush_close="Work resumes",cave_in="Gallery sealed",year_end="Year closes",chronicle_gap="History gap",renamed="New name"}
    local left=labels[latest.kind] or "Chronicle"
    local right=world.subject
    if latest.kind=="migrant" or latest.kind=="departure" or latest.kind=="inspiration" or latest.kind=="artifact" then right=latest.text:match("^(%w+)") or right end
    if latest.kind=="chronicle_gap" then right="Totals kept" end
    local function clip(s) return #s>strip and (s:sub(1,math.max(0,strip-3)).."...") or s end
    text(0,h-2,clip(left),strip,"neutral",0)
    text(w-strip,h-2,clip(right),strip,"neutral",0)
  end
  local rooms=layout.rooms
  local jobs={}
  for _,j in ipairs(world.jobs) do jobs[j.id]=j end
  for i,d in ipairs(world.dwarves) do
    local job=jobs[d.job]
    local room=#rooms>0 and rooms[((job and job.target or i)-1)%#rooms+1] or nil
    local x,y=0,math.min(h-1,3+i)
    if room then x=room.x+2+((i-1)%math.max(1,room.w-4)); y=room.y+2+((i-1)//math.max(1,room.w-4))%(room.h-3) end
    local col=d.mood=="inspired" and "violet" or (d.mood=="strained" and "amber" or "neutral")
    put(x,y,d.role=="founder" and "@" or "d",col,0)
    local mark=job and glyph(job.kind) or "~"
    if state.mode=="thinking" and d.role=="founder" then mark="?" end
    if state.mode=="idle" and (tonumber(state.age) or 0)>60 then mark="z" end
    if state.mode=="tool" and math.floor(phase*3+i)%2==0 then mark="*" end
    put(x+1,y,mark,col,0)
  end
  if world.crew>0 then text(w-strip,h-4,"dd crew",strip,"neutral",0) end
  for i,e in ipairs(world.incidents) do
    local x=w-strip+math.min(strip-1,2+i*2)
    local y=math.min(h-3,3+i)
    local ch,col="!","red"
    if e.kind=="caravan" then ch,col="*","green"; x=w-strip+1+math.floor(phase*2)%math.max(1,strip-2)
    elseif e.kind=="mandate" then ch,col="?","amber" end
    put(x,y,ch,col,0)
    if world.profile=="chaos" and e.kind=="ambush" then put(x+1,y,"!",col,0) end
  end
  for i,a in ipairs(world.artifacts) do
    if #rooms>0 then local r=rooms[(a.room-1)%#rooms+1]; put(r.x+1+(i%math.max(1,r.w-2)),r.y+r.h-2,"*","violet",1) end
  end
  if #rooms>0 then
    put(rooms[1].x+1,rooms[1].y+2,world.z>0 and ">" or "+","amber",1)
    for i,item in ipairs(world.items) do
      local r=rooms[(item.room-1)%#rooms+1]
      put(r.x+1+i%math.max(1,r.w-2),r.y+r.h-2,":","wall",4)
    end
  end
  if world.z>0 then text(0,h-3,"< sealed gallery",strip,"wall",4) end
  if world.cave_until>world.clock or state.mode=="compacting" then
    for x=0,strip-1 do put(x,math.min(h-1,2+(x+math.floor(phase*4))%math.max(1,h-4)),"'","amber",1) end
  end
  if state.mode=="error" and (tonumber(state.age) or 0)<3 then put(w-2,2,"!","red",0) end
  local floor_colour=({spring={0.16,0.23,0.19},summer={0.22,0.23,0.16},autumn={0.25,0.19,0.15},winter={0.17,0.21,0.27}})[season]
  local layers=layout.decoration or View.decorate(world,layout)
  for _,layer in ipairs(layers) do for _,v in ipairs(layer) do
    if drawn>=budget then return end
    put(v.x,v.y,v.ch,v.floor and floor_colour or v.c)
  end end
end
return View

end)()
local M = (function()
-- Included after local Sim and View by bundle.py. Host API is optional in harness.
local M = {}
local world, projected, layout, saved=nil,nil,nil,nil
local W,H,SEED,T,elapsed=0,0,0,0,0,0
local signature=""
function M.init(ctx)
  W,H,SEED=ctx.w,ctx.h,ctx.seed or 0
  world,projected,layout,saved=nil,nil,nil,nil
  T,elapsed,signature=0,0,""
end
function M.resize(ctx)
  if W==0 and H==0 then M.init(ctx); return end
  W,H=ctx.w,ctx.h; layout=nil
end
function M.restore(record) saved=record end
function M.export()
  if not world then return nil end
  return {schema_version=Sim.VERSION,seq=world.seq,counter_digest=Sim.digest(world.counts),world_state=world:snapshot(),
    legends=(projected or world).legends,summary=world.summary,
    status={name=world.name,year=world.year,season=(layout and layout.season) or "spring",population=#world.dwarves,
      crew=world.crew,wealth=world.wealth,stress=(projected or world).stress,z=world.z}}
end
function M.step(dt,state)
  local j=state.journey or {}
  local identity=tostring(j.repo or "fortress")..":"..tostring(j.session_id or SEED)..":"..tostring(j.epoch or "preview")..":2"
  if not world or world.identity~=identity then
    world=Sim.new(Sim.hash(identity),identity)
    if saved and saved.counter_digest and saved.world_state then
      local ok,restored=pcall(function()
        local candidate=Sim.restore(saved.world_state,identity)
        if candidate and Sim.digest(candidate.counts)==saved.counter_digest then candidate:advance(candidate.clock); return candidate end
      end)
      if ok and restored then world=restored end
    end
    saved=nil; elapsed=0; layout=nil
  end
  if (state.params or {}).paused then
    if not projected then projected=Sim.restore(world:snapshot(),identity) end
    if not layout then layout=View.layout(world,W,H) end
    return
  end
  local speed=tonumber((state.mod or {}).speed) or 1
  if speed==0 then return end
  local real_dt=math.max(0,math.min(1,dt/speed))
  T=T+dt; elapsed=elapsed+real_dt
  world:configure(state.params)
  local recent=j.recent or {}
  local last_seq=tonumber(j.seq) or 0
  if j.schema_version==2 and last_seq>world.seq then
    local first=recent[1]
    if not first or (tonumber(first.seq) or 0)>world.seq+1 then
      world:reconcile(j)
    else
      for _,e in ipairs(recent) do
        if (tonumber(e.seq) or 0)>world.seq+1 then world:reconcile(j); break end
        world:push(e)
      end
      if world.seq<last_seq or Sim.digest(world.counts)~=j.counter_digest then world:reconcile(j) end
    end
    elapsed=0
  elseif not j.schema_version and world.seq==0 and (tonumber(j.tools) or 0)>0 then
    -- Old writers have aggregates only; never interpret their unsequenced ring as history.
    local totals={}; for k,v in pairs(j) do totals[k]=v end
    totals.seq=1; totals.tick=0; world:reconcile(totals)
  end
  world:observe(state)
  -- Keep committed history at the event watermark; projection advances between hooks.
  -- A delayed hook can then be applied at its actual tick without rewinding history.
  local tick=world.clock+math.floor(elapsed*4)
  local sig=tostring(world.seq)..":"..tick..":"..W..":"..H..":"..#world.rooms..":"..world.name..":"..world.wealth..":"..world.profile
  if sig~=signature or not projected then
    signature=sig
    projected=Sim.restore(world:snapshot(),identity)
    projected:advance(tick)
  end
  local decor_key=world.wealth..":"..world.subject..":"..world.z
  if not layout or layout.w~=W or layout.h~=H or layout.room_count~=#world.rooms or layout.decor_key~=decor_key then
    layout=View.layout(world,W,H); layout.room_count=#world.rooms; layout.decor_key=decor_key
  end
  layout.season=View.season(state.context_pct)
end
function M.render(fx,state)
  if world and layout then View.render(fx,projected or world,layout,state,T) end
end
return M

end)()
  return M
end)()

local Sakura = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local PT = 0.0
local SLOW_PT = 0.0
local GUST = 0.0
local FUNNEL = 0.0
local scene = nil
local sig = ""
local DRIFT = {}
local PREV_FLOOR = {}

local PETAL_GLYPHS = { "'", ",", "<", ">", "." }
local BLOOM_GLYPHS = { "⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "*" }
local DRIFT_GLYPHS = { ",", ".", "'" }

local MODE_WORD = {
  thinking = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" },
  tool = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" },
  waiting = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" },
  error = { "ｴ", "ﾏ", "ｰ" },
  compacting = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" },
  idle = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" },
}

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
    out = {
      { sbg.hex(0x14151D) }, { sbg.hex(0x242838) }, { sbg.hex(0x3B4261) },
      { sbg.hex(0x76566E) }, { sbg.hex(0xA9657D) },
    }
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

local function grow(rng, depth, len, ang, left)
  local b = { len = len, ang = ang, kids = {} }
  if depth > 0 and left[1] > 0 then
    local n = 2
    if depth > 1 and rng:chance(0.4) then n = 3 end
    for k = 1, n do
      if left[1] <= 0 then break end
      left[1] = left[1] - 1
      local side = (k % 2 == 0) and -1.0 or 1.0
      if n == 3 and k == 3 then side = 0.12 end
      local spread = rng:range(0.30, 0.60) * side
      b.kids[#b.kids + 1] = grow(rng, depth - 1, len * rng:range(0.55, 0.74), spread, left)
    end
  end
  return b
end

local function sum_files(j)
  local total = 0
  if type(j.files) == "table" then
    for _, v in pairs(j.files) do total = total + jnum(v) end
  end
  return total
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local files = sum_files(j)

  local base_x = 2
  local base_y = H - 1
  local area = W * H

  local growth = sbg.clamp(tools / 300.0, 0.0, 1.0)
  local frac = sbg.lerp(0.070, 0.17, growth)
  local total_cells = frac * area

  local depth = math.floor(sbg.clamp(2 + tools / 50, 2, 6))
  local trunk_len = sbg.clamp(4 + depth * 2.0, 4, H * 0.68)

  local branch_budget = math.max(28, math.floor(total_cells * 0.35))
  local primary_n = math.floor(sbg.clamp(4 + tools / 120, 4, 8))
  if primary_n > branch_budget then primary_n = math.max(1, branch_budget) end

  local rng = sbg.rng(sbg.hash(jstr(j.repo, "sbg") .. ":sakura") + SEED)
  local root = { len = trunk_len, ang = 0.0, kids = {} }
  local left = { branch_budget - primary_n }
  for i = 1, primary_n do
    local side = (i % 2 == 0) and -1.0 or 1.0
    local spread = rng:range(0.32, 0.62) * side
    local sublen = trunk_len * rng:range(0.55, 0.78)
    root.kids[#root.kids + 1] = grow(rng, depth - 1, sublen, spread, left)
  end

  local cx = base_x + trunk_len * 0.35
  local cy = base_y - trunk_len - depth * 1.4
  local radius = 3 + depth * 1.8

  local bloom_target = math.max(6, math.floor(total_cells * 0.15))
  local max_bloom = math.max(bloom_target, math.floor(area * 0.06))
  local bloom_n = math.min(bloom_target, max_bloom)
  local bloom = {}
  for i = 1, bloom_n do
    local a = rng:range(0, 6.283185)
    local r = rng:range(0, radius)
    bloom[i] = {
      x = cx + math.cos(a) * r,
      y = cy + math.sin(a) * r * 0.55,
      glyph = BLOOM_GLYPHS[(math.floor(rng:f() * #BLOOM_GLYPHS)) % #BLOOM_GLYPHS + 1],
      k = rng:range(0.55, 1.0),
    }
  end

  local min_petals = 8 + math.floor(W / 12)
  local petal_target = math.floor(total_cells * 0.50) + math.floor(files / 25)
  local max_petals = math.max(min_petals, math.floor(area * 0.10))
  local petal_n = math.min(max_petals, math.max(min_petals, petal_target))
  local petals = {}
  for i = 1, petal_n do
    petals[i] = {
      x0 = rng:range(0, W),
      y0 = rng:range(0, H),
      speed = rng:range(2.0, 5.0),
      drift = rng:range(0.25, 0.55),
      phase = rng:range(0, 6.283185),
      glyph = PETAL_GLYPHS[(math.floor(rng:f() * #PETAL_GLYPHS)) % #PETAL_GLYPHS + 1],
    }
  end

  scene = {
    root = root,
    base_x = base_x,
    base_y = base_y,
    cx = cx,
    cy = cy,
    bloom = bloom,
    petals = petals,
    branch_budget = branch_budget,
  }
  for i = #PREV_FLOOR, 1, -1 do PREV_FLOOR[i] = nil end
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.prompts), sum_files(j), jstr(j.repo, ""), W, H,
  }, "/")
end

local function branch_glyph(sx)
  if sx > 0.55 then return "_" end
  if sx > 0.22 then return "╱" end
  if sx < -0.22 then return "╲" end
  return "│"
end

local function put1(fx, x, y, ch, r, g, b)
  if y >= 1 then fx:put(x, y, ch, r, g, b) end
end

local function draw_branch(fx, b, x, y, ang, sway, colour, budget, primary_only)
  if budget[1] <= 0 then return end
  ang = sbg.clamp(ang, -1.45, 1.45)
  local n = math.max(1, math.floor(b.len + 0.5))
  local sx = math.sin(ang)
  local sy = -math.cos(ang) * 0.6
  local ch = branch_glyph(sx)
  local cx, cy = x, y
  local r, g, bl = colour[1], colour[2], colour[3]
  for _ = 1, n do
    cx, cy = cx + sx, cy + sy
    if budget[1] <= 0 then return end
    budget[1] = budget[1] - 1
    put1(fx, math.floor(cx + 0.5), math.floor(cy + 0.5), ch, r, g, bl)
  end
  if primary_only then return end
  for _, kid in ipairs(b.kids) do
    draw_branch(fx, kid, cx, cy, ang + kid.ang + sway, sway, colour, budget, false)
  end
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, PT, SLOW_PT, GUST, FUNNEL = 0.0, 0.0, 0.0, 0.0, 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  DRIFT = {}
  PREV_FLOOR = {}
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  local mode = state.mode
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end

  if mode == "waiting" then
    SLOW_PT = SLOW_PT + dt * 0.6
  elseif mode == "idle" then
    PT = PT + dt * 0.5
  elseif mode ~= "thinking" and mode ~= "compacting" then
    PT = PT + dt
  end

  if mode == "tool" then
    GUST = math.min(1.0, GUST + dt * 2.0)
  else
    GUST = math.max(0.0, GUST - dt * 1.4)
  end

  if mode == "compacting" then
    FUNNEL = math.min(1.0, FUNNEL + dt * 1.2)
  else
    FUNNEL = math.max(0.0, FUNNEL - dt * 0.8)
  end

  if scene and mode ~= "thinking" and mode ~= "compacting" then
    local cap = math.max(4, math.floor(W / 3))
    for i, pt in ipairs(scene.petals) do
      local speed = pt.speed * (mode == "idle" and 0.5 or 1.0)
      local clock = (i == 1 and mode == "waiting") and SLOW_PT * pt.speed or PT * speed
      local y = sbg.wrap(pt.y0 + clock, H)
      local floory = math.floor(y)
      local prev = PREV_FLOOR[i]
      if prev ~= nil and prev ~= H - 1 and floory == H - 1 then
        DRIFT[#DRIFT + 1] = { glyph = DRIFT_GLYPHS[(sbg.hash(i .. ":" .. math.floor(PT)) % #DRIFT_GLYPHS) + 1] }
        while #DRIFT > cap do table.remove(DRIFT, 1) end
      end
      PREV_FLOOR[i] = floory
    end
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}
  local err = (mode == "error") or FRESH_ERR

  local trunk_col = { pal(p, err and 5 or 2, err and 0.35 or 0.42) }
  local sway = 0.05 * math.sin(T * 0.6)
  if mode == "thinking" then sway = 0.12 * math.sin(T * 1.3) end
  local budget = { scene.branch_budget + 4 }
  draw_branch(fx, scene.root, scene.base_x, scene.base_y, sway, sway,
    trunk_col, budget, mode == "compacting")

  if mode ~= "compacting" then
    for _, bl in ipairs(scene.bloom) do
      local r, g, b = pal(p, 4, 0.35 + 0.25 * bl.k)
      put1(fx, math.floor(bl.x + 0.5), math.floor(bl.y + 0.5), bl.glyph, r, g, b)
    end
  end

  if mode == "thinking" then
    local ocx, ocy = W * 0.62, H * 0.45
    local orad = math.min(W, H) * 0.16
    for i, pt in ipairs(scene.petals) do
      local a = pt.phase + T * 0.35
      local x = ocx + math.cos(a) * orad
      local y = ocy + math.sin(a) * orad * 0.5
      local r, g, b = pal(p, 5, 0.4)
      put1(fx, math.floor(x + 0.5), math.floor(y + 0.5), pt.glyph, r, g, b)
    end
  elseif mode == "compacting" then
    local tx, ty = W - 2, H - 2
    for _, pt in ipairs(scene.petals) do
      local x = sbg.lerp(pt.x0, tx, FUNNEL)
      local y = sbg.lerp(pt.y0, ty, FUNNEL)
      local r, g, b = pal(p, 5, 0.32)
      put1(fx, math.floor(x + 0.5), math.floor(y + 0.5), pt.glyph, r, g, b)
    end
  else
    local dirmul = FRESH_ERR and -1.0 or 1.0
    local gust_dx = (mod.burst or GUST) * 6.0
    local errcol = FRESH_ERR
    for i, pt in ipairs(scene.petals) do
      local speed = pt.speed * (mode == "idle" and 0.5 or 1.0)
      local clock = (i == 1 and mode == "waiting") and SLOW_PT * pt.speed or PT * speed
      if mode == "waiting" and i ~= 1 then clock = 0 end
      local y = sbg.wrap(pt.y0 + clock, H)
      local x = sbg.wrap(pt.x0 + clock * pt.drift * dirmul + gust_dx, W)
      local r, g, b
      if errcol then
        r, g, b = sbg.hsl(0.0, 0.55, 0.32)
      else
        r, g, b = pal(p, 5, 0.42)
      end
      put1(fx, math.floor(x), math.floor(y), pt.glyph, r, g, b)
    end
  end

  for i, d in ipairs(DRIFT) do
    local x = W - 1 - (i - 1)
    if x < 0 then break end
    local r, g, b = pal(p, 5, 0.32)
    fx:put(x, H - 1, d.glyph, r, g, b)
  end

  if mode == "waiting" and (tonumber(state.age) or 0) > 8 then
    sbg.text(fx, math.max(0, scene.base_x - 1), math.max(0, math.floor(scene.cy) - 1),
      "(._.)", pal(p, 3, 0.5))
  end

  if mode == "idle" and (tonumber(state.age) or 0) > 60 then
    fx:put(W - 2, 1, "☾", sky_colour(state.context_pct, 1.3))
  end

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Hanami " .. jstr(j.repo, "unnamed")
  end
  local word = table.concat(MODE_WORD[mode] or MODE_WORD.idle)
  if sbg.text then
    sbg.text(fx, 1, 0, title .. "  " .. word, pal(p, 5, 0.8))
  end
end
  return M
end)()

local Kana = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local RT = 0.0
local SCAN = 0.0
local GLITCH = 0.0
local COLLAPSE = 0.0
local scene = nil
local sig = ""

local KANA = {
  "ｦ", "ｧ", "ｨ", "ｩ", "ｪ", "ｫ", "ｬ", "ｭ", "ｮ", "ｯ", "ｰ",
  "ｱ", "ｲ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｸ", "ｹ", "ｺ",
  "ｻ", "ｼ", "ｽ", "ｾ", "ｿ", "ﾀ", "ﾁ", "ﾂ", "ﾃ", "ﾄ",
  "ﾅ", "ﾆ", "ﾇ", "ﾈ", "ﾉ", "ﾊ", "ﾋ", "ﾌ", "ﾍ", "ﾎ",
  "ﾏ", "ﾐ", "ﾑ", "ﾓ", "ﾔ", "ﾕ", "ﾖ", "ﾗ", "ﾘ", "ﾙ",
  "ﾚ", "ﾛ", "ﾜ", "ﾝ",
}
local DIGITS = { "0", "1", "2", "3", "4", "5", "6", "7", "8", "9" }
local GLYPH_POOL = {}
for _, c in ipairs(KANA) do GLYPH_POOL[#GLYPH_POOL + 1] = c end
for _, c in ipairs(DIGITS) do GLYPH_POOL[#GLYPH_POOL + 1] = c end

local KANA26 = {
  "ｱ", "ｲ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｸ", "ｹ", "ｺ",
  "ｻ", "ｼ", "ｽ", "ｾ", "ｿ", "ﾀ", "ﾁ", "ﾂ", "ﾃ", "ﾄ",
  "ﾅ", "ﾆ", "ﾇ", "ﾈ", "ﾉ", "ﾊ",
}

local MODE_WORD = {
  thinking = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" },
  tool = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" },
  waiting = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" },
  error = { "ｴ", "ﾏ", "ｰ" },
  compacting = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" },
  idle = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" },
}

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
    out = {
      { sbg.hex(0x0E1418) }, { sbg.hex(0x172329) }, { sbg.hex(0x21403D) },
      { sbg.hex(0x315B54) }, { sbg.hex(0x47796D) },
    }
  end
  return out
end

local function pal(p, i, k)
  local c = p[((i - 1) % #p) + 1]
  return sbg.scale(c[1], c[2], c[3], k or 1.0)
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

local function words_of_journey(j)
  local out = {}
  local w = j.words
  if type(w) == "table" then
    for k, v in pairs(w) do
      if type(k) == "string" then
        out[#out + 1] = k
      elseif type(v) == "string" then
        out[#out + 1] = v
      end
    end
  end
  table.sort(out)
  return out
end

local function transliterate(word)
  local out = {}
  for i = 1, math.min(6, #word) do
    local c = word:byte(i)
    if c >= 97 and c <= 122 then
      out[#out + 1] = KANA26[c - 96]
    end
  end
  return out
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local area = W * H
  local ctx_pct = sbg.clamp((tonumber(state.context_pct) or 0), 0, 100)

  local growth = sbg.clamp(tools / 300.0, 0.0, 1.0)
  local frac = sbg.lerp(0.065, 0.16, growth)
  local trail = 6 + math.floor(ctx_pct / 12) + math.floor(tools / 50)
  local target_cells = frac * area

  local min_cols = 6 + math.floor(W / 25)
  local max_cols = math.max(min_cols, math.floor(W * 0.6))
  local col_n = math.floor(sbg.clamp(target_cells / trail, min_cols, max_cols))

  local rng = sbg.rng(sbg.hash(jstr(j.repo, "sbg") .. ":kana") + SEED)
  local cols = {}
  for i = 1, col_n do
    local edge_left = rng:chance(0.5)
    local x
    if edge_left then
      x = rng:below(math.max(1, math.floor(W * 0.25)))
    else
      x = W - 1 - rng:below(math.max(1, math.floor(W * 0.25)))
    end
    cols[i] = {
      x = x,
      edge = edge_left and "left" or "right",
      phase = rng:range(0, 30.0),
      speed = rng:range(3.0, 6.0),
      glyphs = {},
    }
    for t = 1, trail + 2 do
      cols[i].glyphs[t] = GLYPH_POOL[(sbg.hash(i .. ":" .. t) % #GLYPH_POOL) + 1]
    end
  end

  local words = words_of_journey(j)
  local sig_n = math.min(6, math.floor(tools / 40))
  local sigils = {}
  for i = 1, sig_n do
    local w = words[((i - 1) % math.max(1, #words)) + 1] or "sbg"
    local letters = transliterate(w)
    if #letters == 0 then letters = { KANA26[(i % 26) + 1] } end
    local edge_left = i % 2 == 0
    local x = edge_left and (1 + (i % 3)) or (W - 2 - (i % 3))
    sigils[i] = {
      x = x,
      letters = letters,
      age_rank = i,
    }
  end

  scene = {
    cols = cols,
    sigils = sigils,
  }
end

local function signature(state)
  local j = state.journey or {}
  local words = words_of_journey(j)
  return table.concat({
    jnum(j.tools), table.concat(words, ","), jstr(j.repo, ""),
    math.floor(sbg.clamp((tonumber(state.context_pct) or 0), 0, 100) / 12), W, H,
  }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, RT, SCAN, GLITCH, COLLAPSE = 0.0, 0.0, 0.0, 0.0, 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  local mode = state.mode
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end

  if mode ~= "waiting" then
    local factor = 1.0
    if mode == "idle" then factor = 0.5 end
    RT = RT + dt * factor
  end

  if mode == "tool" then
    SCAN = math.min(1.0, SCAN + dt / 0.8)
  else
    SCAN = math.max(0.0, SCAN - dt * 1.6)
  end

  if mode == "compacting" then
    COLLAPSE = math.min(1.0, COLLAPSE + dt * 1.1)
  else
    COLLAPSE = math.max(0.0, COLLAPSE - dt * 0.8)
  end

  GLITCH = FRESH_ERR and 1.0 or math.max(0.0, GLITCH - dt * 2.0)
end

local function put1(fx, x, y, ch, r, g, b)
  if y >= 1 then fx:put(x, y, ch, r, g, b) end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local age = tonumber(state.age) or 0

  local tail_col = { pal(p, 2, 0.32) }

  if COLLAPSE > 0.02 then
    local bandw = math.max(1, math.floor(W * 0.06))
    local x0 = W - bandw
    for i, c in ipairs(scene.cols) do
      local tx = x0 + ((i - 1) % bandw)
      local x = sbg.lerp(c.x, tx, COLLAPSE)
      local ch = (i % 2 == 0) and "│" or "┆"
      for row = 1, 6 do
        local y = math.floor(sbg.wrap(RT * c.speed * 0.4 + row * 2 + c.phase, H))
        put1(fx, math.floor(x + 0.5), y, ch, tail_col[1], tail_col[2], tail_col[3])
      end
    end
  else
    for ci, c in ipairs(scene.cols) do
      if mode ~= "idle" or ci % 2 == 0 then
        local speed = c.speed
        if mode == "thinking" and c.edge == "right" then speed = speed * 1.5 end
        if mode == "idle" then speed = speed * 0.5 end
        local trail = #c.glyphs
        local head = RT * speed + c.phase
        local head_r, head_g, head_b = pal(p, 4, 0.5)
        for t = 0, trail - 1 do
          local y = math.floor(sbg.wrap(head - t * 1.4, H))
          local glyph = c.glyphs[t + 1]
          local k = 1.0 - (t / trail)
          local r, g, b
          if GLITCH > 0.05 and ci == 1 then
            r, g, b = sbg.hsl(0.0, 0.5, 0.30 + 0.10 * GLITCH)
            glyph = ({ "x", "/", "\\" })[(t % 3) + 1]
          else
            r, g, b = sbg.mix(tail_col[1], tail_col[2], tail_col[3], head_r, head_g, head_b, k)
          end
          put1(fx, c.x, y, glyph, r, g, b)
        end
        if mode == "waiting" then
          local blink = math.floor(T * 2.0) % 2
          if blink == 0 then
            local y = math.floor(sbg.wrap(head, H))
            put1(fx, c.x, y, "?", pal(p, 5, 0.6))
          end
        end
      end
    end
  end

  if SCAN > 0.02 then
    local rng = sbg.rng(SEED + math.floor(T * 1.7))
    local sx = rng:below(math.max(1, W))
    local y = math.floor((1.0 - SCAN) * H)
    local r, g, b = pal(p, 5, 0.55)
    put1(fx, sx, y, GLYPH_POOL[(sbg.hash(sx) % #GLYPH_POOL) + 1], r, g, b)
  end

  for _, s in ipairs(scene.sigils) do
    local fade = 0.30 + 0.5 * (s.age_rank / math.max(1, #scene.sigils))
    local r, g, b = pal(p, 3, fade)
    for i, ch in ipairs(s.letters) do
      local y = 2 + i
      if y < H - 1 then
        put1(fx, s.x, y, ch, r, g, b)
      end
    end
  end

  if mode == "idle" and age > 60 then
    sbg.text(fx, math.max(0, W - 4), H - 2, "zz", pal(p, 3, 0.32))
  end

  local title = (state.mood or {}).title
  if type(title) ~= "string" or title == "" then
    title = "Rain " .. jstr(j.repo, "unnamed")
  end
  local word = table.concat(MODE_WORD[mode] or MODE_WORD.idle)
  if sbg.text then
    sbg.text(fx, 1, 0, title .. "  " .. word, pal(p, 5, 0.75))
  end
end
  return M
end)()

local Shrine = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local COMPACT = 0.0
local scene = nil
local sig = ""

local KANA_THINK = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_TOOL = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_ERR = { "ｴ", "ﾏ", "ｰ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }
local KANA_IDLE = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" }

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
    out = {
      { sbg.hex(0x10131A) }, { sbg.hex(0x1D2431) }, { sbg.hex(0x303E54) },
      { sbg.hex(0x59454B) }, { sbg.hex(0x78464C) },
    }
  end
  return out
end

local function pal(p, i, k)
  local c = p[((i - 1) % #p) + 1]
  return sbg.scale(c[1], c[2], c[3], k or 1.0)
end

local function floor_l(r, g, b, minl)
  local mx = math.max(r, g, b)
  local mn = math.min(r, g, b)
  local l = (mx + mn) * 0.5
  if l <= 0.0001 then return minl, minl, minl end
  if l < minl then return sbg.scale(r, g, b, minl / l) end
  return r, g, b
end

local function mainc(p, i, k)
  local r, g, b = pal(p, i, k)
  return floor_l(r, g, b, 0.30)
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

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local ctx = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)

  local gate_h = math.max(5, math.floor(H * 0.30))
  local gy = H - 1
  local gx = math.max(3, math.floor(W * 0.10))

  local path_len = math.max(1, W - gx - 3)
  local base_steps = math.max(3, math.floor(path_len * 0.30))
  local grow_steps = math.floor(tools / 5)
  local steps = sbg.clamp(base_steps + grow_steps, base_steps, path_len)

  local top_y = math.max(0, gy - gate_h)
  local avail_h = math.max(1, top_y)
  local rows_max = sbg.clamp(math.floor(avail_h * 0.4), 2, 24)
  local stage = 0
  if ctx >= 0.9 or tools >= 240 then stage = 4
  elseif ctx >= 0.75 or tools >= 180 then stage = 3
  elseif ctx >= 0.5 or tools >= 120 then stage = 2
  elseif ctx >= 0.25 or tools >= 60 then stage = 1
  end
  local base_layers = math.max(1, math.floor(rows_max * 0.28))
  local layers = sbg.clamp(base_layers + math.ceil(stage * (rows_max - base_layers) / 4.0), base_layers, rows_max)

  local base_posts = sbg.clamp(math.floor(path_len / 30), 1, 8)
  local posts = sbg.clamp(base_posts + math.floor(tools / 25), base_posts, 8)
  local post_pos = {}
  for i = 1, posts do
    local frac = i / (posts + 1)
    post_pos[i] = gx + 2 + math.floor(frac * path_len)
  end

  scene = {
    gate_h = gate_h,
    gy = gy,
    gx = gx,
    steps = steps,
    path_len = path_len,
    layers = layers,
    rows_max = rows_max,
    posts = post_pos,
    fireflies = math.min(math.floor(W * H * 0.02), 3 + math.floor(jnum(j.prompts))),
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.prompts), jnum(j.errors),
    math.floor(sbg.clamp((tonumber(state.context_pct) or 0) / 25.0, 0, 4)), W, H,
  }, "/")
end

local function kana_for(mode)
  if mode == "thinking" then return KANA_THINK end
  if mode == "tool" then return KANA_TOOL end
  if mode == "waiting" then return KANA_WAIT end
  if mode == "error" then return KANA_ERR end
  if mode == "compacting" then return KANA_COMPACT end
  return KANA_IDLE
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
  COMPACT = 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  if state.mode == "compacting" then
    COMPACT = math.min(1.0, COMPACT + dt * 1.5)
  else
    COMPACT = math.max(0.0, COMPACT - dt * 0.6)
  end
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Jinja " .. jstr(j.repo, "unnamed")
  end
  local kana = kana_for(mode)
  local status = title .. "  " .. table.concat(kana)
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local gx, gy, gh = scene.gx, scene.gy, scene.gate_h
  local err = (mode == "error") or FRESH_ERR
  local gr, gg, gb = mainc(p, 5, 0.65)
  if err then
    local er, eg, eb = sbg.hsl(0.98, 0.55, 0.42)
    gr, gg, gb = er, eg, eb
  end

  local top_y = math.max(0, gy - gh)
  fx:put(gx - 1, top_y, "╭", gr, gg, gb)
  fx:put(gx + 5, top_y, "╮", gr, gg, gb)
  for x = gx, gx + 4 do
    fx:put(x, top_y, "━", gr, gg, gb)
  end
  local beam2_y = top_y + 1
  if beam2_y < gy then
    for x = gx - 2, gx + 6 do
      if x >= 0 and x < W then fx:put(x, beam2_y, "═", gr, gg, gb) end
    end
  end
  local pr1, pr2, pr3 = mainc(p, 5, 0.5)
  for y = top_y + 2, gy do
    fx:put(gx, y, "┃", pr1, pr2, pr3)
    fx:put(gx + 4, y, "┃", pr1, pr2, pr3)
  end

  if mode == "waiting" and (tonumber(state.age) or 0) > 8 then
    if sbg.text then sbg.text(fx, gx - 4, gy - 1, "(-_-)", mainc(p, 4, 0.6)) end
  end

  local layer_y0 = math.max(0, top_y - scene.rows_max)
  local layer_y1 = math.max(0, top_y - 1)
  local tr, tg, tb = pal(p, 3, 0.55)
  local shown_layers = math.floor(math.max(1, scene.layers) * (1.0 - COMPACT) + 0.5)
  for li = 1, shown_layers do
    local y = layer_y1 - (li - 1)
    if y >= layer_y0 then
      local fade = (1.0 - (shown_layers - li) * 0.10) * (1.0 - COMPACT)
      for x = 0, W - 1 do
        local n = sbg.noise2(x * 0.15 + li * 3.1, T * 0.02)
        if n > 0.12 then
          local mask = 1 + (math.floor(sbg.clamp((n + 1) * 4, 0, 7)))
          local ch = sbg.glyphs.braille[mask]
          fx:put(x, y, ch, sbg.scale(tr, tg, tb, math.max(0.25, fade)))
        end
      end
    end
  end

  local dot_r, dot_g, dot_b = mainc(p, 2, 0.55)
  for s = 1, scene.steps do
    local x = gx + 1 + s
    if x >= W then break end
    local age_fade = 1.0
    if s > scene.steps - 3 then
      age_fade = 0.5 + 0.5 * (scene.steps - s) / 3.0
    end
    local ch = (s % 3 == 0) and "▪" or ((s % 2 == 0) and "∙" or "·")
    fx:put(x, gy, ch, sbg.scale(dot_r, dot_g, dot_b, age_fade))
  end

  if mode == "tool" then
    local marker_s = math.max(1, math.min(scene.steps, math.floor(scene.steps * (1.0 - (mod.burst or 0)))))
    local mx = gx + 1 + marker_s
    if mx < W then
      fx:put(mx, gy - 1, "▸", mainc(p, 4, 0.7))
    end
  end

  local lr, lg, lb = sbg.hsl(0.10, 0.55, 0.42)
  for i, x in ipairs(scene.posts) do
    if x < W then
      fx:put(x, gy - 1, "┬", mainc(p, 3, 0.5))
      local bright = 0.7
      if mode == "tool" and i == #scene.posts then
        bright = 0.7 + 0.5 * (mod.burst or 0)
      end
      local hr, hg, hb = sbg.scale(lr, lg, lb, bright)
      fx:put(x, gy - 2, "▣", floor_l(hr, hg, hb, 0.30))
    end
  end

  local nff = scene.fireflies
  local gather = (mode == "thinking")
  for i = 1, nff do
    local seed_i = SEED + i * 733
    local bx = (sbg.hash(tostring(seed_i)) % math.max(1, W))
    local by_base = math.max(0, gy - 6 - (sbg.hash(tostring(seed_i + 1)) % 6))
    local nx = sbg.noise2(i * 0.7, T * 0.3)
    local ny = sbg.noise2(i * 0.7 + 50.0, T * 0.3)
    local x, y
    if gather then
      local tx = gx + 1 + scene.steps
      x = sbg.wrap(tx + nx * 3.0, W)
      y = math.max(0, gy - 1 + ny * 2.0)
    else
      x = sbg.wrap(bx + nx * 4.0, W)
      y = math.max(0, by_base + ny * 2.0)
    end
    local ch = (i % 2 == 0) and "·" or "."
    local blink = 0.4 + 0.4 * (0.5 + 0.5 * math.sin(T * 2.0 + i))
    fx:put(math.floor(x), math.floor(y), ch, sbg.hsl(0.16, 0.5, 0.30 * blink + 0.1))
  end

  if mode == "idle" and (tonumber(state.age) or 0) > 60 then
    fx:put(math.min(W - 1, gx + 6), math.max(0, top_y - 6), "☾", sky_colour(state.context_pct, 1.2))
  end
end
  return M
end)()

local Hangar = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local scene = nil
local sig = ""

local KANA_THINK = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_TOOL = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_ERR = { "ｴ", "ﾏ", "ｰ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }
local KANA_IDLE = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" }

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
    out = {
      { sbg.hex(0x0D1217) }, { sbg.hex(0x1A2530) }, { sbg.hex(0x30414E) },
      { sbg.hex(0x4E6D60) }, { sbg.hex(0x81694A) },
    }
  end
  return out
end

local function pal(p, i, k)
  local c = p[((i - 1) % #p) + 1]
  return sbg.scale(c[1], c[2], c[3], k or 1.0)
end

local function floor_l(r, g, b, minl)
  local mx = math.max(r, g, b)
  local mn = math.min(r, g, b)
  local l = (mx + mn) * 0.5
  if l <= 0.0001 then return minl, minl, minl end
  if l < minl then return sbg.scale(r, g, b, minl / l) end
  return r, g, b
end

local function mainc(p, i, k)
  local r, g, b = pal(p, i, k)
  return floor_l(r, g, b, 0.30)
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

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local kinds = j.tool_kinds or {}

  local top_y = math.max(1, math.floor(H * 0.14))
  local bot_y = math.min(H - 2, H - 1 - math.floor(H * 0.14))
  local avail_v = math.max(3, bot_y - top_y - 1)
  local bay_h = math.min(5, avail_v)
  local bay_y0 = math.max(top_y + 1, math.floor((top_y + bot_y) / 2) - math.floor(bay_h / 2))
  local bay_y1 = math.min(bot_y - 1, bay_y0 + bay_h)

  local bay_w = 8
  local max_bays = math.max(1, math.floor((W - 4) / bay_w))
  local baseline_bays = math.max(1, math.floor(max_bays * 0.25))
  local wide_frac = sbg.clamp(max_bays / 24.0, 0.0, 1.0)
  local total_bays = sbg.clamp(baseline_bays + math.floor(tools / 20 * wide_frac), baseline_bays, max_bays)
  local shown = math.min(max_bays, total_bays)
  local first = total_bays - shown

  local mesh_rows_max = sbg.clamp(math.floor(avail_v * 0.30), 1, 8)
  local mesh_reveal = sbg.clamp(tools / 220.0, 0.0, 1.0)
  local mesh_rows = math.floor(mesh_rows_max * mesh_reveal + 0.5)

  local bays = {}
  for i = 0, shown - 1 do
    local idx = first + i
    local x = 2 + i * bay_w
    if x + 6 <= W then
      local age = total_bays - 1 - idx
      bays[#bays + 1] = {
        x = x,
        idx = idx,
        newest = idx == total_bays - 1,
        fade = math.max(0.35, 1.0 - age * 0.15),
      }
    end
  end

  local subs = math.floor(sbg.clamp(jnum(j.subagents), 0, 6))

  local total_kind = jnum(kinds.exec) + jnum(kinds.edit) + jnum(kinds.read) + jnum(kinds.web) + 0.0001
  scene = {
    top_y = top_y,
    bot_y = bot_y,
    bay_y0 = bay_y0,
    bay_y1 = bay_y1,
    bays = bays,
    total_bays = total_bays,
    mesh_rows = mesh_rows,
    subs = subs,
    lamp_mix = {
      exec = jnum(kinds.exec) / total_kind,
      edit = jnum(kinds.edit) / total_kind,
      read = jnum(kinds.read) / total_kind,
      web = jnum(kinds.web) / total_kind,
    },
    errors = math.min(6, jnum(j.errors)),
  }
end

local function signature(state)
  local j = state.journey or {}
  local kinds = j.tool_kinds or {}
  return table.concat({
    jnum(j.tools), jnum(j.subagents), jnum(j.errors),
    jnum(kinds.exec), jnum(kinds.edit), jnum(kinds.read), jnum(kinds.web), W, H,
  }, "/")
end

local function kana_for(mode)
  if mode == "thinking" then return KANA_THINK end
  if mode == "tool" then return KANA_TOOL end
  if mode == "waiting" then return KANA_WAIT end
  if mode == "error" then return KANA_ERR end
  if mode == "compacting" then return KANA_COMPACT end
  return KANA_IDLE
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
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
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Bay " .. jstr(j.repo, "unnamed")
  end
  local pct = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)
  local bars = math.floor(pct * 5 + 0.5)
  local pwr = "PWR "
  for i = 1, 5 do
    pwr = pwr .. (i <= bars and "\226\150\147" or "\226\150\145")
  end
  local kana = kana_for(mode)
  local status = title .. "  " .. pwr .. "  " .. table.concat(kana)
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local rail_r, rail_g, rail_b = mainc(p, 3, 0.55)
  local tick = math.floor(T * 6.0) % (2 * math.max(1, W))
  for x = 0, W - 1 do
    if x % 2 == 0 then
      fx:put(x, scene.top_y, "\226\149\170", rail_r, rail_g, rail_b)
      fx:put(x, scene.bot_y, "\226\148\128", rail_r, rail_g, rail_b)
    end
  end

  local mr2, mg2, mb2 = mainc(p, 3, 0.4)
  for row = 1, scene.mesh_rows do
    local y = scene.top_y + row
    if y >= 0 and y < scene.bay_y0 then
      for x = 0, W - 1 do
        local n = sbg.noise2(x * 0.22 + row * 5.7, T * 0.03)
        if n > 0.22 then
          fx:put(x, y, "\226\148\188", sbg.scale(mr2, mg2, mb2, 0.6))
        end
      end
    end
  end

  if mode == "tool" then
    local burst = mod.burst or 0
    if burst > 0.05 then
      local travel = sbg.wrap(T * 24.0, W)
      local bx = math.floor(travel)
      local ch = (bx % 2 == 0) and "=" or ">"
      fx:put(bx, scene.top_y, ch, sbg.scale(rail_r, rail_g, rail_b, 1.6 * burst + 0.4))
    end
  end

  local shutter = (mode == "compacting")

  for _, bay in ipairs(scene.bays) do
    local br, bg, bb = mainc(p, 2, 0.5 + 0.35 * bay.fade)
    local x, y0, y1 = bay.x, scene.bay_y0, scene.bay_y1
    if y1 - y0 >= 2 then
      local ring = mode == "thinking" and bay.newest
      local tl, tr_, bl, br_ = "\226\148\140", "\226\148\144", "\226\148\148", "\226\148\152"
      if ring and math.floor(T * 3.0) % 2 == 0 then
        tl, tr_, bl, br_ = "\226\149\148", "\226\149\151", "\226\149\154", "\226\149\157"
      end
      if shutter then
        fx:put(x + 2, y0, "\226\148\128", br, bg, bb)
        fx:put(x + 2, y1, "\226\148\128", br, bg, bb)
      else
        fx:put(x, y0, tl, br, bg, bb)
        fx:put(x + 4, y0, tr_, br, bg, bb)
        fx:put(x, y1, bl, br, bg, bb)
        fx:put(x + 4, y1, br_, br, bg, bb)
        for xx = x + 1, x + 3 do
          fx:put(xx, y0, "\226\148\128", br, bg, bb)
          fx:put(xx, y1, "\226\148\128", br, bg, bb)
        end
        for yy = y0 + 1, y1 - 1 do
          fx:put(x, yy, "\226\148\130", br, bg, bb)
          fx:put(x + 4, yy, "\226\148\130", br, bg, bb)
        end

        local hr0, hg0, hb0 = sbg.hsl(0.60, 0.20, 0.32 + 0.10 * bay.fade)
        local mr, mg, mb = floor_l(hr0, hg0, hb0, 0.30)
        local midy = math.floor((y0 + y1) / 2)
        fx:put(x + 1, midy - 1, "\226\150\159", mr, mg, mb)
        fx:put(x + 2, midy - 1, "\226\150\136", mr, mg, mb)
        fx:put(x + 3, midy - 1, "\226\150\153", mr, mg, mb)
        fx:put(x + 1, midy, "\226\150\144", mr, mg, mb)
        fx:put(x + 3, midy, "\226\150\140", mr, mg, mb)
        fx:put(x + 2, midy + 1, "=", mr, mg, mb)
        for yy = y0 + 1, y1 - 2 do
          if yy < midy - 1 or yy > midy + 1 then
            fx:put(x + 2, yy, "\226\148\130", sbg.scale(br, bg, bb, 0.85))
          end
        end

        local mix = scene.lamp_mix
        local lr, lg, lb
        if mix.exec >= mix.edit and mix.exec >= mix.read and mix.exec >= mix.web then
          lr, lg, lb = sbg.hsl(0.35, 0.55, 0.38)
        elseif mix.edit >= mix.read and mix.edit >= mix.web then
          lr, lg, lb = sbg.hsl(0.10, 0.55, 0.38)
        elseif mix.read >= mix.web then
          lr, lg, lb = sbg.hsl(0.58, 0.55, 0.38)
        else
          lr, lg, lb = sbg.hsl(0.50, 0.55, 0.38)
        end
        local lamp_ch = "\226\151\139"
        if mode == "idle" then
          local blink = math.floor(T * 0.8 + bay.idx) % 4
          lamp_ch = (blink ~= 0) and "\226\151\139" or "\226\128\162"
        end
        local slr, slg, slb = sbg.scale(lr, lg, lb, 0.6 + 0.4 * bay.fade)
        fx:put(x + 1, y1 - 1, lamp_ch, floor_l(slr, slg, slb, 0.30))

        if bay.newest and mode == "error" and scene.errors > 0 then
          fx:put(x + 3, y1 - 1, "x", sbg.hsl(0.98, 0.6, 0.42))
        elseif bay.newest and FRESH_ERR then
          fx:put(x + 3, y1 - 1, "x", sbg.hsl(0.98, 0.6, 0.42))
        elseif bay.newest and scene.errors > 0 then
          fx:put(x + 3, y1 - 1, "x", sbg.hsl(0.98, 0.25, 0.22))
        end

        if bay.newest and mode == "waiting" then
          if sbg.text then sbg.text(fx, x + 5, midy, "HOLD", sbg.hsl(0.10, 0.5, 0.4)) end
        end

        if bay.newest and mode == "idle" and (tonumber(state.age) or 0) > 60 then
          fx:put(x + 2, y0 - 1, "z", sbg.hsl(0.55, 0.2, 0.3))
          fx:put(x + 3, y0 - 2, "z", sbg.hsl(0.55, 0.2, 0.28))
        end
      end
    end
  end

  local dr, dg, db = pal(p, 4, 0.4)
  for i = 1, scene.subs do
    local x = sbg.wrap(math.floor(T * (3 + i) + i * 17), W)
    local y = scene.top_y + 1 + (i % math.max(1, scene.bot_y - scene.top_y - 1))
    local ch = (i % 2 == 0) and "*" or "+"
    fx:put(x, y, ch, dr, dg, db)
  end
end
  return M
end)()

local Dojo = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local ERR_FLASH = 0.0
local WIPE = 0.0
local scene = nil
local sig = ""

local KANA_THINK = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_TOOL = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_ERR = { "ｴ", "ﾏ", "ｰ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }
local KANA_IDLE = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" }

local SPEED_GLYPHS = { "/", "\\", "-", "=", ">", "<", "|" }

local CHIBI_STAND = { " o ", "/|\\" }
local CHIBI_RUN_A = { "o/ ", "/> " }
local CHIBI_RUN_B = { " o ", "\\|/" }
local CHIBI_SIT = { " o ", "_|_" }
local CHIBI_THINK = { "o? ", "/| " }
local CHIBI_ERR = { ">_<", "/ \\" }

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
    out = {
      { sbg.hex(0x17171C) }, { sbg.hex(0x292A33) }, { sbg.hex(0x454756) },
      { sbg.hex(0x79644F) }, { sbg.hex(0x98545B) },
    }
  end
  return out
end

local function pal(p, i, k)
  local c = p[((i - 1) % #p) + 1]
  return sbg.scale(c[1], c[2], c[3], k or 1.0)
end

local function tohsl(r, g, b)
  local mx, mn = math.max(r, g, b), math.min(r, g, b)
  local l = (mx + mn) / 2
  if mx == mn then return 0, 0, l end
  local d = mx - mn
  local s = d / (1 - math.abs(2 * l - 1))
  local h
  if mx == r then h = ((g - b) / d) % 6
  elseif mx == g then h = (b - r) / d + 2
  else h = (r - g) / d + 4 end
  return h / 6, s, l
end

local function main_colour(p, i, minl)
  local r, g, b = pal(p, i, 1.0)
  local h, s, l = tohsl(r, g, b)
  l = math.max(l, minl or 0.30)
  return sbg.hsl(h, s, l)
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

local function kana_for(mode)
  if mode == "thinking" then return KANA_THINK end
  if mode == "tool" then return KANA_TOOL end
  if mode == "waiting" then return KANA_WAIT end
  if mode == "error" then return KANA_ERR end
  if mode == "compacting" then return KANA_COMPACT end
  return KANA_IDLE
end

local function draw_sprite(fx, x0, y0, rows, r, g, b)
  for ri, row in ipairs(rows) do
    for ci = 1, #row do
      local ch = row:sub(ci, ci)
      if ch ~= " " then
        fx:put(x0 + ci - 1, y0 + ri - 1, ch, r, g, b)
      end
    end
  end
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local prompts = jnum(j.prompts)
  local band_w = math.max(2, math.floor(W / 6))
  local top_y = 2
  local bot_y = math.max(top_y + 1, H - 6)
  local band_h = math.max(1, bot_y - top_y + 1)
  local band_area = band_w * band_h

  local tools_ref = sbg.clamp(tools / 300.0, 0, 1)
  local fill_frac = 0.16 + 0.29 * tools_ref
  local base_n = math.max(1, math.floor(W / 8))
  local n_per_band = math.max(base_n, math.floor(band_area * fill_frac))
  n_per_band = math.min(n_per_band, band_area)
  local nlines = n_per_band * 2

  local speed = {}
  for i = 1, nlines do
    local hs = sbg.hash("dojo-line-" .. i)
    local band = (i % 2 == 0) and "L" or "R"
    local y = top_y + (hs % band_h)
    local offset = math.floor(hs / 7) % math.max(1, band_w - 1)
    local glyph = SPEED_GLYPHS[(hs % #SPEED_GLYPHS) + 1]
    speed[#speed + 1] = { band = band, y = y, offset = offset, glyph = glyph, age = nlines - i }
  end

  local group_w = 10
  local per_side_cap = math.max(1, math.floor((W * 0.25) / group_w))
  local row_cap = per_side_cap * 2
  local groups_wanted = math.max(1, math.floor(prompts / 5))
  local groups = math.min(groups_wanted, row_cap * 2)
  local row1_groups = math.min(groups, row_cap)
  local row2_groups = groups - row1_groups

  local ticks = math.floor(sbg.clamp((tonumber(state.context_pct) or 0) / 10.0, 0, 10))

  scene = {
    band_w = band_w,
    top_y = top_y,
    bot_y = bot_y,
    speed = speed,
    row1_groups = row1_groups,
    row2_groups = row2_groups,
    ticks = ticks,
    lvl = math.floor(tools / 25) + 1,
    chibi_x = math.max(band_w + 1, math.floor(W * 0.5) - math.floor(band_w * 0.5)),
    chibi_y = math.max(top_y, H - 4),
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.prompts),
    math.floor(sbg.clamp((tonumber(state.context_pct) or 0) / 5.0, 0, 20)), W, H,
  }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
  ERR_FLASH, WIPE = 0.0, 0.0
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
    ERR_FLASH = math.min(1.0, ERR_FLASH + dt * 4.0)
  else
    ERR_FLASH = math.max(0.0, ERR_FLASH - dt * 1.5)
  end
  if state.mode == "compacting" then
    WIPE = math.min(1.0, WIPE + dt * 3.0)
  else
    WIPE = math.max(0.0, WIPE - dt * 1.2)
  end
end

local function draw_tally_row(fx, y, ngroups, w, tr, tg, tb)
  for gi = 1, ngroups do
    local side = (gi % 2 == 1) and "L" or "R"
    local slot = math.floor((gi - 1) / 2)
    local x0
    if side == "L" then
      x0 = 1 + slot * 10
    else
      x0 = w - 2 - 9 - slot * 10
    end
    if x0 >= 0 and x0 + 8 < w then
      local tally = "| | | | /"
      for ci = 1, #tally do
        local ch = tally:sub(ci, ci)
        if ch ~= " " then
          fx:put(x0 + ci - 1, y, ch, tr, tg, tb)
        end
      end
    end
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Dojo " .. jstr(j.repo, "unnamed")
  end
  local kana = kana_for(mode)
  if sbg.text then
    sbg.text(fx, 1, 0, title .. "  " .. table.concat(kana), main_colour(p, 5, 0.55))
  end

  local lr, lg, lb = main_colour(p, 3, 0.32)
  if sbg.text then sbg.text(fx, 0, 1, "LV" .. tostring(scene.lvl), main_colour(p, 4, 0.35)) end
  for i = 1, scene.ticks do
    local y = scene.bot_y - (i - 1)
    if y >= 2 then
      fx:put(0, y, "+", lr, lg, lb)
    end
  end
  if scene.ticks > 0 then
    fx:put(0, scene.bot_y - scene.ticks, "^", sky_colour(state.context_pct, 0.9))
  end

  if WIPE > 0.5 then
    local wr, wg, wb = main_colour(p, 2, 0.32)
    local ys = { math.floor(H * 0.25), math.floor(H * 0.5), math.floor(H * 0.75) }
    for _, y in ipairs(ys) do
      for x = 0, scene.band_w - 1 do
        fx:put(x, y, "═", wr, wg, wb)
        fx:put(W - 1 - x, y, "═", wr, wg, wb)
      end
    end
  else
    local err = (mode == "error") or FRESH_ERR
    local err_band = jnum(j.errors) % 2 == 0 and "L" or "R"
    for _, s in ipairs(scene.speed) do
      local fade = 0.60 + 0.35 * sbg.clamp(1.0 - s.age / math.max(1, #scene.speed), 0, 1)
      local off = s.offset
      local ch = s.glyph
      if mode == "thinking" then
        local pull = math.floor(1.5 + 1.5 * math.sin(T * 1.1 + s.offset))
        off = sbg.clamp(off - pull, 0, scene.band_w - 1)
      elseif mode == "tool" then
        off = off + math.floor((mod.burst or 0) * 3)
        off = off % math.max(1, scene.band_w - 1)
        if s.band == "L" then ch = ">" else ch = "-" end
      end
      local x = (s.band == "L") and off or (W - 1 - off)
      local cr, cg, cb = main_colour(p, 2, 0.30 * fade + 0.30)
      if err and s.band == err_band then
        cr, cg, cb = sbg.hsl(0.98, 0.55, 0.40)
      end
      fx:put(x, s.y, ch, cr, cg, cb)
    end

    if err and ERR_FLASH > 0.05 then
      local bx = (err_band == "L") and 1 or (W - 2)
      for k = 0, 3 do
        local y = scene.top_y + k * 2
        if y <= scene.bot_y then
          local dx = (err_band == "L") and (bx + k) or (bx - k)
          fx:put(sbg.clamp(dx, 0, W - 1), y, "/", sbg.hsl(0.98, 0.6, 0.45 * ERR_FLASH))
        end
      end
    end

    local tr, tg, tb = main_colour(p, 4, 0.32)
    draw_tally_row(fx, H - 1, scene.row1_groups, W, tr, tg, tb)
    if scene.row2_groups > 0 then
      draw_tally_row(fx, H - 2, scene.row2_groups, W, tr, tg, tb)
    end
  end

  local age = tonumber(state.age) or 0
  local rows = CHIBI_STAND
  local sr, sg, sb = main_colour(p, 5, 0.38)
  if mode == "error" then
    rows = CHIBI_ERR
    sr, sg, sb = sbg.hsl(0.98, 0.55, 0.42)
  elseif mode == "thinking" then
    rows = CHIBI_THINK
  elseif mode == "tool" then
    rows = (math.floor(T * 6) % 2 == 0) and CHIBI_RUN_A or CHIBI_RUN_B
  elseif mode == "waiting" then
    rows = CHIBI_SIT
  elseif mode == "idle" or mode == "start" or mode == "end" then
    rows = CHIBI_SIT
  end
  if WIPE <= 0.5 then
    draw_sprite(fx, scene.chibi_x, scene.chibi_y, rows, sr, sg, sb)

    if mode == "thinking" then
      local radius = math.min(5, 1 + math.floor(age / 3))
      local cx, cy = scene.chibi_x + 1, scene.chibi_y
      for r = 1, radius do
        local mask = 1 + ((r * 37 + math.floor(T * 2)) % 8)
        local ch = sbg.braille(mask)
        local ax = cx - r - 1
        local bxp = cx + r + 1
        if ax >= 0 then fx:put(ax, cy - 1, ch, main_colour(p, 3, 0.30)) end
        if bxp < W then fx:put(bxp, cy - 1, ch, main_colour(p, 3, 0.30)) end
      end
    elseif mode == "waiting" then
      if sbg.text then sbg.text(fx, scene.chibi_x, scene.chibi_y - 1, "...", main_colour(p, 4, 0.32)) end
    elseif mode == "error" then
      if sbg.text then sbg.text(fx, scene.chibi_x, scene.chibi_y - 1, "!!!", sbg.hsl(0.98, 0.6, 0.45)) end
    elseif (mode == "idle" or mode == "start" or mode == "end") and age > 60 then
      fx:put(scene.chibi_x + 2, scene.chibi_y - 1, "z", main_colour(p, 3, 0.32))
    elseif mode == "idle" or mode == "start" or mode == "end" then
      local flick = math.floor(T * 0.6) % 5
      if flick == 0 then
        fx:put(scene.chibi_x - 2, scene.chibi_y - 1, ".", pal(p, 2, 0.3))
      end
    end
  end
end
  return M
end)()

local Hud = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local scene = nil
local sig = ""

local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }

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
    out = {
      { sbg.hex(0x0E1515) }, { sbg.hex(0x172828) }, { sbg.hex(0x25413E) },
      { sbg.hex(0x385B54) }, { sbg.hex(0x52766C) },
    }
  end
  return out
end

local function pal(p, i, k)
  local c = p[((i - 1) % #p) + 1]
  return sbg.scale(c[1], c[2], c[3], k or 1.0)
end

local function tohsl(r, g, b)
  local mx, mn = math.max(r, g, b), math.min(r, g, b)
  local l = (mx + mn) / 2
  if mx == mn then return 0, 0, l end
  local d = mx - mn
  local s = d / (1 - math.abs(2 * l - 1))
  local h
  if mx == r then h = ((g - b) / d) % 6
  elseif mx == g then h = (b - r) / d + 2
  else h = (r - g) / d + 4 end
  return h / 6, s, l
end

local function main_colour(p, i, minl)
  local r, g, b = pal(p, i, 1.0)
  local h, s, l = tohsl(r, g, b)
  l = math.max(l, minl or 0.30)
  return sbg.hsl(h, s, l)
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

local function cell_len(s)
  if type(s) ~= "string" then return 0 end
  local n = 0
  for i = 1, #s do
    local b = s:byte(i)
    if b < 128 or b >= 192 then n = n + 1 end
  end
  return n
end

local function trunc_cells(s, maxcells)
  if type(s) ~= "string" or maxcells <= 0 then return "" end
  local n, i, len = 0, 1, #s
  while i <= len do
    local b = s:byte(i)
    local seqlen = 1
    if b >= 240 then seqlen = 4
    elseif b >= 224 then seqlen = 3
    elseif b >= 192 then seqlen = 2 end
    if n >= maxcells then break end
    n = n + 1
    i = i + seqlen
  end
  return s:sub(1, i - 1)
end

local function top_n(tbl, n)
  local list = {}
  for k, v in pairs(tbl or {}) do
    if type(k) == "string" and jnum(v) > 0 then list[#list + 1] = { k, jnum(v) } end
  end
  table.sort(list, function(a, b)
    if a[2] == b[2] then return a[1] < b[1] end
    return a[2] > b[2]
  end)
  local out = {}
  for i = 1, math.min(n, #list) do out[i] = list[i][1] .. ":" .. tostring(list[i][2]) end
  return out
end

local function build(state)
  local j = state.journey or {}
  local shrink = H < 20
  local max_width
  if W >= 120 then
    max_width = math.min(44, math.floor(W / 2))
  elseif shrink then
    max_width = math.min(24, W - 2)
  else
    max_width = math.min(34, W - 2)
  end
  max_width = math.max(10, math.min(max_width, W - 2))
  local tools_ref = sbg.clamp(jnum(j.tools) / 300.0, 0, 1)
  local base_width = math.max(10, math.floor(max_width * 0.88))
  local width = base_width + math.floor((max_width - base_width) * tools_ref)
  local x0 = math.max(0, W - width - 1)
  local extras_ok = (W * H) >= 3000

  local rows = {}
  if jnum(j.prompts) > 0 then rows[#rows + 1] = { key = "PROMPTS", text = "PROMPTS " .. tostring(jnum(j.prompts)) } end
  if jnum(j.tools) > 0 then rows[#rows + 1] = { key = "TOOLS", text = "TOOLS " .. tostring(jnum(j.tools)) } end
  local exts = top_n(j.files, 3)
  if #exts > 0 then rows[#rows + 1] = { key = "FILES", text = "FILES " .. table.concat(exts, " ") } end
  if jnum(j.subagents_peak) > 0 then rows[#rows + 1] = { key = "PARTY", text = "PARTY x" .. tostring(jnum(j.subagents_peak)) } end
  rows[#rows + 1] = { key = "MANA", text = "MANA" }
  if extras_ok then rows[#rows + 1] = { key = "XP", text = "XP" } end
  if jnum(j.errors) > 0 then rows[#rows + 1] = { key = "WOUNDS", text = "WOUNDS " .. tostring(jnum(j.errors)) } end
  if jnum(j.compactions) > 0 then rows[#rows + 1] = { key = "RESTS", text = "RESTS " .. tostring(jnum(j.compactions)) } end

  local skills = {}
  if extras_ok then
    local words = {}
    for k, v in pairs(j.words or {}) do
      if type(k) == "string" then words[#words + 1] = { k, jnum(v) } end
    end
    table.sort(words, function(a, b)
      if a[2] == b[2] then return a[1] < b[1] end
      return a[2] > b[2]
    end)
    for i = 1, math.min(4, #words) do skills[i] = words[i][1] .. ":" .. tostring(words[i][2]) end
  end

  local recent = {}
  if extras_ok then
    local list = j.recent
    if type(list) == "table" then
      local row_budget = sbg.clamp(math.floor((H - 10) * 0.6), 0, 24)
      local cap = math.min(row_budget, math.floor(1 + tools_ref * row_budget))
      for i = #list, 1, -1 do
        if #recent >= cap then break end
        local e = list[i]
        if type(e) == "table" and e.k == "tool" and type(e.tool) == "string" then
          recent[#recent + 1] = e.tool
        end
      end
    end
  end

  local prompt_src = jstr(j.last_prompt, jstr(state.prompt, ""))
  local qmax = math.max(4, math.floor(W / 3))
  prompt_src = trunc_cells(prompt_src, qmax)

  scene = {
    x0 = x0,
    width = width,
    shrink = shrink,
    extras_ok = extras_ok,
    rows = rows,
    skills = skills,
    recent = recent,
    quest = prompt_src,
    lvl = math.floor(jnum(j.tools) / 25) + 1,
    xp = jnum(j.tools) % 25,
    sparkle_n = 2 + jnum(j.subagents),
  }
end

local function signature(state)
  local j = state.journey or {}
  local exts = 0
  for _ in pairs(j.files or {}) do exts = exts + 1 end
  return table.concat({
    jnum(j.tools), jnum(j.prompts), jnum(j.errors), jnum(j.compactions),
    jnum(j.subagents_peak), jnum(j.subagents), exts,
    jstr(j.last_prompt, jstr(state.prompt, "")), W, H,
  }, "/")
end

local function box_row(fx, x0, y, width, ch_l, ch_m, ch_r, r, g, b)
  fx:put(x0, y, ch_l, r, g, b)
  for x = x0 + 1, x0 + width - 2 do fx:put(x, y, ch_m, r, g, b) end
  fx:put(x0 + width - 1, y, ch_r, r, g, b)
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
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
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}
  local x0, width = scene.x0, scene.width

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = jstr(j.repo, "unnamed")
  end

  local br, bg, bb = main_colour(p, 3, 0.32)

  local content_rows = {}
  if mode ~= "compacting" then
    for _, row in ipairs(scene.rows) do content_rows[#content_rows + 1] = row end
  end

  local mode_row = "STATE IDLE"
  if mode == "thinking" then
    mode_row = "STATE FOCUS"
  elseif mode == "tool" then
    mode_row = "ACTION >>>"
  elseif mode == "waiting" then
    mode_row = "CONFIRM ?"
  elseif mode == "error" then
    mode_row = "ERROR"
  end

  local y0 = 0

  box_row(fx, x0, y0, width, "┌", "─", "┐", br, bg, bb)
  if mode == "compacting" then
    box_row(fx, x0, y0 + 1, width, "└", "─", "┘", br, bg, bb)
    local cr, cg, cb = sky_colour(state.context_pct, 0.8)
    if sbg.text then
      sbg.text(fx, x0 + 2, y0 + 1, "COMPRESS", cr, cg, cb)
    end
    local kx = x0 + width - 1 - #KANA_COMPACT
    for i, ch in ipairs(KANA_COMPACT) do
      local x = kx + i - 1
      if x > x0 and x < x0 + width - 1 then fx:put(x, y0, ch, main_colour(p, 4, 0.35)) end
    end
    return
  end

  local y = y0 + 1
  fx:put(x0, y, "│", br, bg, bb)
  fx:put(x0 + width - 1, y, "│", br, bg, bb)
  if sbg.text then
    local xp_bar_w = 6
    local filled = math.floor((scene.xp / 25) * xp_bar_w)
    local bar = {}
    for i = 1, xp_bar_w do bar[i] = (i <= filled) and "█" or "░" end
    if mode == "thinking" then
      local shim = 1 + (math.floor(T * 4) % xp_bar_w)
      bar[shim] = "▒"
    end
    local suffix = " LV" .. tostring(scene.lvl) .. " " .. table.concat(bar)
    local title_budget = math.max(0, width - 3 - cell_len(suffix))
    local label = trunc_cells(title, title_budget) .. suffix
    sbg.text(fx, x0 + 1, y, label, main_colour(p, 5, 0.40))
  end

  if not scene.shrink then
    y = y + 1
    fx:put(x0, y, "│", br, bg, bb)
    fx:put(x0 + width - 1, y, "│", br, bg, bb)
    local mr, mg, mb = main_colour(p, 4, 0.35)
    local text = mode_row
    if mode == "error" then
      local flash = FRESH_ERR and 1.0 or 0.3
      mr, mg, mb = sbg.hsl(0.98, 0.45, math.max(0.30, 0.42 * flash))
    end
    if sbg.text then
      local n = sbg.text(fx, x0 + 1, y, text, mr, mg, mb)
      local cx = x0 + 1 + n + 1
      if mode == "tool" then
        local marchn = 1 + math.floor((mod.burst or 0) * 3)
        for i = 1, marchn do
          if cx + i - 1 < x0 + width - 1 then fx:put(cx + i - 1, y, ">", mr, mg, mb) end
        end
      elseif mode == "waiting" then
        if math.floor(T * 2) % 2 == 0 then fx:put(cx, y, "?", mr, mg, mb) end
        local kx = cx + 2
        for i, ch in ipairs(KANA_WAIT) do
          if kx + i - 1 < x0 + width - 1 then fx:put(kx + i - 1, y, ch, mr, mg, mb) end
        end
      elseif mode == "error" and jnum(j.errors) > 0 then
        if sbg.text then sbg.text(fx, cx, y, tostring(jnum(j.errors)), mr, mg, mb) end
      end
    end
  end

  if not scene.shrink then
    for _, row in ipairs(content_rows) do
      y = y + 1
      if y >= H - 1 then break end
      fx:put(x0, y, "│", br, bg, bb)
      fx:put(x0 + width - 1, y, "│", br, bg, bb)
      local text = row.text
      local gauge_w = sbg.clamp(width - 12, 4, 30)
      if row.key == "MANA" then
        local pct = sbg.clamp(100 - (tonumber(state.context_pct) or 0), 0, 100)
        local bar_w = gauge_w
        local filled = math.floor((pct / 100) * bar_w)
        local bar = {}
        for i = 1, bar_w do bar[i] = (i <= filled) and "█" or "░" end
        text = "MANA [" .. table.concat(bar) .. "]"
      elseif row.key == "XP" then
        local bar_w = gauge_w
        local filled = math.floor((scene.xp / 25) * bar_w)
        local bar = {}
        for i = 1, bar_w do bar[i] = (i <= filled) and "█" or "░" end
        text = "XP [" .. table.concat(bar) .. "]"
      end
      text = trunc_cells(text, width - 3)
      local rr, rg, rb = main_colour(p, 2, 0.32)
      if row.key == "WOUNDS" and FRESH_ERR then rr, rg, rb = sbg.hsl(0.98, 0.45, 0.35) end
      if sbg.text then sbg.text(fx, x0 + 1, y, text, rr, rg, rb) end
    end
  end

  y = y + 1
  if y < H then box_row(fx, x0, y, width, "└", "─", "┘", br, bg, bb) end

  local pbr, pbg, pbb = main_colour(p, 2, 0.32)
  local ptr, ptg, ptb = main_colour(p, 4, 0.35)

  if #scene.skills > 0 and y + 3 <= H - 1 then
    local py = y + 1
    box_row(fx, x0, py, width, "┌", "─", "┐", pbr, pbg, pbb)
    fx:put(x0, py + 1, "│", pbr, pbg, pbb)
    fx:put(x0 + width - 1, py + 1, "│", pbr, pbg, pbb)
    local text = trunc_cells("SKILL " .. table.concat(scene.skills, " "), width - 3)
    if sbg.text then sbg.text(fx, x0 + 1, py + 1, text, ptr, ptg, ptb) end
    box_row(fx, x0, py + 2, width, "└", "─", "┘", pbr, pbg, pbb)
    y = py + 2
  end

  if #scene.recent > 0 and y + 4 <= H - 1 then
    local py = y + 1
    box_row(fx, x0, py, width, "┌", "─", "┐", pbr, pbg, pbb)
    fx:put(x0, py + 1, "│", pbr, pbg, pbb)
    fx:put(x0 + width - 1, py + 1, "│", pbr, pbg, pbb)
    if sbg.text then sbg.text(fx, x0 + 1, py + 1, "RECENT", ptr, ptg, ptb) end
    local dr, dg, db = main_colour(p, 2, 0.30)
    local ry = py + 2
    for _, tool_name in ipairs(scene.recent) do
      if ry >= H - 2 then break end
      fx:put(x0, ry, "│", pbr, pbg, pbb)
      fx:put(x0 + width - 1, ry, "│", pbr, pbg, pbb)
      local label = trunc_cells("> " .. tool_name, width - 3)
      if sbg.text then sbg.text(fx, x0 + 1, ry, label, ptr, ptg, ptb) end
      local pad = width - 3 - cell_len(label)
      if pad > 0 then
        local lx = x0 + 1 + cell_len(label) + 1
        for k = 1, pad - 1 do
          if lx + k - 1 < x0 + width - 1 then fx:put(lx + k - 1, ry, ".", dr, dg, db) end
        end
      end
      ry = ry + 1
    end
    box_row(fx, x0, ry, width, "└", "─", "┘", pbr, pbg, pbb)
  end

  if mode == "idle" and (tonumber(state.age) or 0) > 60 then
    if sbg.text then sbg.text(fx, math.max(0, x0 - 9), y0, "(-_-) zz", main_colour(p, 3, 0.32)) end
  end

  if #scene.quest > 0 and sbg.text then
    sbg.text(fx, 1, H - 1, ">> " .. scene.quest, main_colour(p, 3, 0.32))
  end

  local nsp = scene.sparkle_n
  local sparkle = { "⠁", "⠂", "⠄" }
  for i = 1, nsp do
    local hs = sbg.hash("hud-sp-" .. i)
    local bx = hs % math.max(1, math.min(3, W))
    local phase = (hs % 100) / 100.0
    local yy = sbg.wrap((H - 1) - (T * 1.2 + phase * H), H)
    local ch = sparkle[(hs % #sparkle) + 1]
    fx:put(bx, math.floor(yy), ch, pal(p, 2, 0.35))
  end
end
  return M
end)()

local Studyroom = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local COMPACT = 0.0
local scene = nil
local sig = ""

local KANA_THINK = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_TOOL = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_ERR = { "ｴ", "ﾏ", "ｰ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }
local KANA_IDLE = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" }

local BOOK_GLYPHS = { "▌", "▐", "│", "▍" }
local SPIN = { "|", "/", "-", "\\" }

local EXT_HUE = {
  py = 0.34, rs = 0.055, ts = 0.14, tsx = 0.14, js = 0.14, jsx = 0.14,
  go = 0.50, md = 0.0, txt = 0.0, rst = 0.0, toml = 0.78, json = 0.78,
  yaml = 0.80, yml = 0.80, lua = 0.63, sh = 0.42, rb = 0.98, c = 0.56,
  h = 0.56, cpp = 0.56, java = 0.03, sql = 0.50, css = 0.52, html = 0.03,
}

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
    out = {
      { sbg.hex(0x18171E) }, { sbg.hex(0x292833) }, { sbg.hex(0x414152) },
      { sbg.hex(0x65545A) }, { sbg.hex(0x776448) },
    }
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

local function ext_colour(ext, l)
  local s, h = 0.46, EXT_HUE[ext]
  if ext == "md" or ext == "txt" or ext == "rst" then s = 0.0 end
  if not h then h = (sbg.hash(ext or "?") % 997) / 997.0 end
  return sbg.hsl(h, s, l or 0.42)
end

local function top_exts(j)
  local list = {}
  for k, v in pairs(j.files or {}) do
    if type(k) == "string" then list[#list + 1] = { k, jnum(v) } end
  end
  table.sort(list, function(a, b)
    if a[2] == b[2] then return a[1] < b[1] end
    return a[2] > b[2]
  end)
  local out = {}
  for i = 1, math.min(6, #list) do out[i] = list[i][1] end
  if #out == 0 then out[1] = "md" end
  return out
end

local function total_files(j)
  local n = 0
  for _, v in pairs(j.files or {}) do n = n + jnum(v) end
  return n
end

local function kana_for(mode)
  if mode == "thinking" then return KANA_THINK end
  if mode == "tool" then return KANA_TOOL end
  if mode == "waiting" then return KANA_WAIT end
  if mode == "error" then return KANA_ERR end
  if mode == "compacting" then return KANA_COMPACT end
  return KANA_IDLE
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local prompts = jnum(j.prompts)
  local errors = jnum(j.errors)
  local added = jnum(state.lines_added)

  local desk_w = sbg.clamp(math.floor(W * 0.22), 8, 16)
  local desk_x = 1
  local desk_y = math.max(3, H - 3)
  local surface_y = desk_y - 1

  local win_w, win_h = 5, 5
  local win_x = math.max(desk_x + desk_w + 3, W - win_w - 2)
  local win_y = 0

  local shelf_w = sbg.clamp(math.floor(W * 0.28), 6, 18)
  local shelf_x0 = 1
  local shelf_slots = {}
  local sy = math.max(1, desk_y - 6)
  for i = 1, 3 do
    local ry = sy - (i - 1) * 2
    if ry >= 1 and ry < surface_y - 1 then shelf_slots[i] = ry end
  end

  local books_total = math.min(total_files(j), shelf_w * #shelf_slots)
  local active_shelves = math.min(#shelf_slots, math.max(1, math.ceil(books_total / shelf_w)))
  local shelf_rows = {}
  for i = 1, active_shelves do shelf_rows[i] = shelf_slots[i] end
  local exts = top_exts(j)

  local plant_stems = sbg.clamp(math.floor(added / 300), 0, 4)
  local plant_x0 = desk_x + desk_w + 2

  local grain_base = math.floor(W * H * 0.028)
  local grain_grow = math.floor(W * H * 0.065 * sbg.clamp(tools / 300, 0, 1))
  local grain_n = math.min(grain_base + grain_grow, math.floor(W * H * 0.18))

  local notes = math.min(24, prompts)
  local papers = math.min(6, errors)

  scene = {
    desk_x = desk_x, desk_y = desk_y, desk_w = desk_w, surface_y = surface_y,
    win_x = win_x, win_y = win_y, win_w = win_w, win_h = win_h,
    shelf_x0 = shelf_x0, shelf_w = shelf_w, shelf_rows = shelf_rows,
    books_total = books_total, exts = exts,
    plant_stems = plant_stems, plant_x0 = plant_x0, added = added,
    grain_n = grain_n, notes = notes, papers = papers,
    cat = tools >= 20,
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.prompts), jnum(j.errors), total_files(j),
    math.floor(jnum(state.lines_added) / 50), W, H,
  }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
  COMPACT = 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  if state.mode == "compacting" then
    COMPACT = math.min(1.0, COMPACT + dt * 1.4)
  else
    COMPACT = math.max(0.0, COMPACT - dt * 0.6)
  end
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}
  local age = tonumber(state.age) or 0
  local err = (mode == "error") or FRESH_ERR

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Study " .. jstr(j.repo, "unnamed")
  end
  local kana = kana_for(mode)
  local status = title .. "  " .. table.concat(kana)
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local gcr, gcg, gcb = pal(p, 3, 0.18)
  local blink = 1.0
  if mode == "idle" and age > 30 then
    blink = 0.65 + 0.35 * math.sin(T * 0.4)
  end
  for i = 1, scene.grain_n do
    local h = sbg.hash("grain" .. i .. SEED)
    local x = h % W
    local y = 1 + (math.floor(h / 97) % math.max(1, H - 4))
    local ch = ((i % 3) == 0) and ":" or "."
    fx:put(x, y, ch, sbg.scale(gcr, gcg, gcb, 0.5 + 0.5 * blink))
  end

  local dx, dy, dw = scene.desk_x, scene.desk_y, scene.desk_w
  local dr, dg, db = pal(p, 2, 0.45)
  fx:put(dx, dy, "┌", dr, dg, db)
  fx:put(dx + dw - 1, dy, "┐", dr, dg, db)
  for x = dx + 1, dx + dw - 2 do fx:put(x, dy, "─", dr, dg, db) end
  fx:put(dx, dy + 1, "│", dr, dg, db)
  fx:put(dx + dw - 1, dy + 1, "│", dr, dg, db)
  fx:put(dx, dy + 2, "└", dr, dg, db)
  fx:put(dx + dw - 1, dy + 2, "┘", dr, dg, db)
  for x = dx + 1, dx + dw - 2 do fx:put(x, dy + 2, "─", dr, dg, db) end

  local wx, wy, ww, wh = scene.win_x, scene.win_y, scene.win_w, scene.win_h
  local wr, wg, wb = pal(p, 3, 0.5)
  for x = wx, wx + ww - 1 do
    fx:put(x, wy, "─", wr, wg, wb)
    fx:put(x, wy + wh - 1, "─", wr, wg, wb)
    fx:put(x, wy + math.floor(wh / 2), "─", wr, wg, wb)
  end
  for y = wy, wy + wh - 1 do
    fx:put(wx, y, "│", wr, wg, wb)
    fx:put(wx + math.floor(ww / 2), y, "│", wr, wg, wb)
    fx:put(wx + ww - 1, y, "│", wr, wg, wb)
  end
  fx:put(wx, wy, "┌", wr, wg, wb)
  fx:put(wx + ww - 1, wy, "┐", wr, wg, wb)
  fx:put(wx, wy + wh - 1, "└", wr, wg, wb)
  fx:put(wx + ww - 1, wy + wh - 1, "┘", wr, wg, wb)
  local midy = wy + math.floor(wh / 2)
  local midx = wx + math.floor(ww / 2)
  fx:put(wx, midy, "├", wr, wg, wb)
  fx:put(wx + ww - 1, midy, "┤", wr, wg, wb)
  fx:put(midx, wy, "┬", wr, wg, wb)
  fx:put(midx, wy + wh - 1, "┴", wr, wg, wb)
  fx:put(midx, midy, "┼", wr, wg, wb)

  local ctx_pct = tonumber(state.context_pct) or 0
  local sr, sg, sb = sky_colour(ctx_pct, 0.65)
  local panes = { { wx + 1, wy + 1 }, { midx + 1, wy + 1 }, { wx + 1, midy + 1 }, { midx + 1, midy + 1 } }
  for i, pos in ipairs(panes) do
    fx:put(pos[1], pos[2], "░", sr, sg, sb)
  end
  if ctx_pct > 72 then
    fx:put(midx + 1, wy + 1, "☾", sky_colour(ctx_pct, 1.2))
  end

  if mode == "tool" then
    local burst = mod.burst or 0
    for i = 1, 3 do
      local hh = sbg.hash("rain" .. i .. math.floor(T * 4))
      local rx = wx - 1 - (hh % 3)
      local ry = wy + (hh % wh)
      if rx >= 0 then
        fx:put(rx, ry, (i % 2 == 0) and "┆" or "╲", sbg.scale(sr, sg, sb, 0.5 + 0.4 * burst))
      end
    end
  end

  local shr, shg, shb = pal(p, 4, 0.4)
  local shown_shelves = #scene.shelf_rows
  local book_col_dim = 1.0 - 0.5 * COMPACT
  local drawn_books = math.floor(scene.books_total * (1.0 - COMPACT * 0.7) + 0.5)
  for i, ry in ipairs(scene.shelf_rows) do
    for x = scene.shelf_x0, scene.shelf_x0 + scene.shelf_w - 1 do
      fx:put(x, ry, "═", shr, shg, shb)
    end
  end
  local per_shelf = math.max(1, scene.shelf_w)
  for b = 1, drawn_books do
    local shelf_i = 1 + math.floor((b - 1) / per_shelf)
    if shelf_i > #scene.shelf_rows then break end
    local col_i = ((b - 1) % per_shelf) + 1
    local ry = scene.shelf_rows[shelf_i]
    local ext = scene.exts[((b - 1) % #scene.exts) + 1]
    local ecol = { ext_colour(ext, 0.4) }
    local fade = (b > drawn_books - 4) and (0.5 + 0.5 * (drawn_books - b) / 4.0) or 1.0
    local glyph = BOOK_GLYPHS[(b % #BOOK_GLYPHS) + 1]
    if COMPACT > 0.5 then glyph = "█" end
    fx:put(scene.shelf_x0 + col_i - 1, ry - 1, glyph,
      sbg.scale(ecol[1], ecol[2], ecol[3], fade * book_col_dim))
  end

  for i = 1, scene.plant_stems do
    local px = scene.plant_x0 + (i - 1) * 2
    local height = sbg.clamp(math.floor(scene.added / 150) - (i - 1) * 2, 1, math.max(1, math.floor(H / 3)))
    local pr, pg, pb = pal(p, 2, 0.5)
    for hgt = 1, height do
      local py = scene.surface_y - hgt
      if py >= 0 then fx:put(px, py, "│", pr, pg, pb) end
    end
    local topy = scene.surface_y - height - 1
    if topy >= 0 then fx:put(px, topy, "♣", pal(p, 2, 0.55)) end
  end

  do
    local mr, mg, mb = pal(p, 5, 0.5)
    fx:put(scene.desk_x + 1, scene.surface_y, "☕", mr, mg, mb)
  end

  local lamp_x = scene.desk_x + scene.desk_w - 2
  local lamp_bright = 0.5
  local halo_r = 1
  if mode == "thinking" then
    halo_r = 2 + math.floor(1.5 * (0.5 + 0.5 * math.sin(T * 1.3)))
  end
  if err then
    lamp_bright = 0.35 + 0.35 * (0.5 + 0.5 * math.sin(T * 14.0))
  elseif mode == "idle" and age > 30 then
    lamp_bright = 0.3 + 0.2 * blink
  end
  fx:put(lamp_x, scene.surface_y, "┬", pal(p, 5, lamp_bright + 0.2))
  for r = 1, halo_r do
    local n = r * 3
    for k = 0, n - 1 do
      local ang = (k / n) * 6.28318
      local hx = math.floor(lamp_x + math.cos(ang) * r + 0.5)
      local hy = math.floor(scene.surface_y - 1 - math.sin(ang) * r * 0.5 + 0.5)
      if hx >= 0 and hx < W and hy >= 0 and hy < scene.surface_y then
        fx:put(hx, hy, "·", pal(p, 5, lamp_bright * (1.0 - (r - 1) * 0.3)))
      end
    end
  end

  local chibi_x = scene.desk_x + math.floor(scene.desk_w / 2)
  local typing = (mode == "tool")
  local frame_a = math.floor(T * 6) % 2 == 0
  local ccr, ccg, ccb = pal(p, 1, 0.55)
  if typing then
    sbg.text(fx, chibi_x - 1, scene.surface_y - 2, frame_a and "o/" or "\\o", ccr, ccg, ccb)
  else
    fx:put(chibi_x, scene.surface_y - 2, "o", ccr, ccg, ccb)
  end
  if mode == "waiting" then
    sbg.text(fx, chibi_x - 1, scene.surface_y - 3, "._.", pal(p, 4, 0.5))
    fx:put(chibi_x + 2, scene.surface_y - 3, "?", pal(p, 4, 0.55))
  end
  sbg.text(fx, chibi_x - 1, scene.surface_y - 1, "_|_", ccr, ccg, ccb)

  local spin_on = (mode == "thinking") or (mode == "tool")
  if spin_on then
    local sp = SPIN[(math.floor(T * 8) % #SPIN) + 1]
    fx:put(scene.desk_x + 3, scene.surface_y - 1, sp, pal(p, 4, 0.55))
  end
  sbg.text(fx, scene.desk_x + 2, scene.surface_y, "(o)", pal(p, 3, 0.5))

  for i = 1, scene.notes do
    local h = sbg.hash("note" .. i .. SEED)
    local nx = scene.shelf_x0 + (h % math.max(1, scene.shelf_w))
    local ny = 1 + (math.floor(h / 53) % math.max(1, scene.desk_y - 3))
    fx:put(nx, ny, "▪", pal(p, 5, 0.42))
  end

  for i = 1, scene.papers do
    local h = sbg.hash("paper" .. i .. SEED)
    local px = scene.desk_x + scene.desk_w + 1 + (h % 3)
    fx:put(px, H - 1, "x", sbg.hsl(0.02, 0.5, 0.30))
  end

  if scene.cat then
    local cat_x = math.min(W - 6, scene.desk_x + scene.desk_w + 2)
    local cat_y = H - 1
    local sleepy = (mode == "idle") and age > 60
    sbg.text(fx, cat_x, cat_y, "=^.^=", pal(p, 2, 0.5))
    if sleepy then
      fx:put(cat_x + 5, cat_y - 1, "z", pal(p, 4, 0.4))
    end
  end
end
  return M
end)()

local Sparkfield = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local COMPACT = 0.0
local scene = nil
local sig = ""

local KANA_THINK = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_TOOL = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_ERR = { "ｴ", "ﾏ", "ｰ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }
local KANA_IDLE = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" }

local TWINKLE = { ".", "+", "*", "+" }
local COMET_TAIL = { "·", "∙", "." }
local BRAILLE_DUST = { "⠁", "⠂", "⠄", "⠈" }

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
    out = {
      { sbg.hex(0x17141D) }, { sbg.hex(0x2B2437) }, { sbg.hex(0x4B3C61) },
      { sbg.hex(0x66547F) }, { sbg.hex(0x8B678B) },
    }
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

local function kana_for(mode)
  if mode == "thinking" then return KANA_THINK end
  if mode == "tool" then return KANA_TOOL end
  if mode == "waiting" then return KANA_WAIT end
  if mode == "error" then return KANA_ERR end
  if mode == "compacting" then return KANA_COMPACT end
  return KANA_IDLE
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local area = W * H

  local star_n = math.min(math.floor(area * 0.06), 12 + math.floor(area * 0.015) + math.floor(tools / 3))
  local stars = {}
  local cx, cy = math.floor(W / 2), math.floor(H / 2)
  for i = 1, star_n do
    local rng = sbg.rng(SEED + i * 9187)
    local x = rng:below(math.max(1, W))
    local y = 1 + rng:below(math.max(1, H - 1))
    stars[i] = { x = x, y = y, seed = sbg.hash("star" .. i .. SEED) }
  end

  local link_n = math.min(#stars - 1, math.floor(tools / 6))
  link_n = math.max(0, link_n)
  local links = {}
  for i = 1, link_n do
    local a = stars[((i - 1) % math.max(1, #stars)) + 1]
    local b = stars[(i % math.max(1, #stars)) + 1]
    if a and b then
      links[#links + 1] = { ax = a.x, ay = a.y, bx = b.x, by = b.y, age = link_n - i }
    end
  end

  local subagents_peak = jnum(j.subagents_peak)
  local rings = sbg.clamp(subagents_peak + 1, 1, 4)

  local dust_n = math.min(math.floor(area * 0.05), 6 + math.floor(area * 0.02))
  local link_budget = math.floor(area * 0.06)

  scene = {
    stars = stars,
    links = links,
    cx = cx, cy = cy,
    rings = rings,
    dust_n = dust_n,
    link_budget = link_budget,
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.subagents_peak), W, H,
  }, "/")
end

local function line_cells(ax, ay, bx, by)
  local pts = {}
  local dx, dy = bx - ax, by - ay
  local steps = math.max(math.abs(dx), math.abs(dy))
  if steps < 1 then return pts end
  for s = 1, steps - 1 do
    local t = s / steps
    local x = ax + dx * t
    local y = ay + dy * t
    local ch = "·"
    if math.abs(dx) > math.abs(dy) * 2 then ch = "─"
    elseif math.abs(dy) > math.abs(dx) * 2 then ch = "│"
    elseif (dx > 0) == (dy > 0) then ch = "╲"
    else ch = "╱" end
    pts[#pts + 1] = { x = math.floor(x + 0.5), y = math.floor(y + 0.5), ch = ch }
  end
  return pts
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
  COMPACT = 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  if state.mode == "compacting" then
    COMPACT = math.min(1.0, COMPACT + dt * 1.4)
  else
    COMPACT = math.max(0.0, COMPACT - dt * 0.6)
  end
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}
  local age = tonumber(state.age) or 0
  local err = (mode == "error") or FRESH_ERR

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Sparkfield " .. jstr(j.repo, "unnamed")
  end
  local kana = kana_for(mode)
  local status = title .. "  " .. table.concat(kana)
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local dr, dg, db = pal(p, 3, 0.22)
  for i = 1, scene.dust_n do
    local h = sbg.hash("dust" .. i .. SEED)
    local bx = h % W
    local by = 1 + (math.floor(h / 61) % math.max(1, H - 1))
    local drift = T * 0.6
    local nx = sbg.noise2(i * 0.3, T * 0.15)
    local x = sbg.wrap(bx + nx * 2.0, W)
    local y = sbg.wrap(by - drift + math.sin(i * 1.7) * 1.5, H)
    local ch = BRAILLE_DUST[(i % #BRAILLE_DUST) + 1]
    fx:put(math.floor(x), math.floor(y), ch, dr, dg, db)
  end

  local gather = (mode == "thinking")
  local fold = COMPACT
  local link_left = scene.link_budget
  for i, link in ipairs(scene.links) do
    if link_left <= 0 then break end
    local fade = math.max(0.2, 1.0 - link.age * 0.02)
    local scar = (i == 1 and #scene.links > 4)
    for _, pt in ipairs(line_cells(link.ax, link.ay, link.bx, link.by)) do
      if link_left <= 0 then break end
      if pt.x >= 0 and pt.x < W and pt.y >= 0 and pt.y < H then
        local ch = scar and "┄" or pt.ch
        fx:put(pt.x, pt.y, ch, pal(p, 3, 0.35 * fade))
        link_left = link_left - 1
      end
    end
  end

  local burst = mod.burst or 0
  local comet_shown = (mode == "tool") and burst > 0.02
  local comet_x, comet_y
  if comet_shown and #scene.stars >= 2 then
    local idx = (math.floor(T * 3) % #scene.stars) + 1
    local a = scene.stars[idx]
    local b = scene.stars[(idx % #scene.stars) + 1]
    local t = 1.0 - burst
    comet_x = a.x + (b.x - a.x) * t
    comet_y = a.y + (b.y - a.y) * t
  end

  for _, s in ipairs(scene.stars) do
    local phase = sbg.hash("ph" .. s.seed) % 100 / 100.0
    local cyc = (T * 0.6 + phase * 4.0) % 4
    local ch = TWINKLE[math.floor(cyc) + 1]
    local x, y = s.x, s.y
    if gather then
      local t = 0.12
      x = x + (scene.cx - x) * t * math.min(1.0, T * 0.02)
      y = y + (scene.cy - y) * t * math.min(1.0, T * 0.02)
    end
    if fold > 0.05 then
      x = x + (scene.cx - x) * fold
      y = y + (scene.cy - y) * fold
    end
    local bright = 0.35 + 0.25 * (0.5 + 0.5 * math.sin(T * 2.0 + phase * 6.28))
    if mode == "idle" and age > 10 then bright = bright * 0.6 end
    fx:put(math.floor(x + 0.5), math.floor(y + 0.5), ch, pal(p, 4, bright))
  end

  if comet_x then
    fx:put(math.floor(comet_x + 0.5), math.floor(comet_y + 0.5), "*", pal(p, 5, 0.7))
    for t = 1, 3 do
      local tx = comet_x - t * 1.2
      local ty = comet_y
      fx:put(math.floor(tx + 0.5), math.floor(ty + 0.5), COMET_TAIL[t], pal(p, 4, 0.4 - t * 0.08))
    end
  end

  if mode == "waiting" then
    local h = sbg.hash("wait" .. math.floor(T * 0.5))
    local wx = sbg.clamp((h % W), 2, W - 2)
    local wy = sbg.clamp((math.floor(h / 37) % H), 2, H - 2)
    local pulse = 0.4 + 0.35 * (0.5 + 0.5 * math.sin(T * 3.0))
    fx:put(wx, wy, "*", pal(p, 5, pulse))
    fx:put(wx + 2, wy, "?", pal(p, 4, 0.5))
  end

  local sr, sg, sb = pal(p, 5, err and (0.4 + 0.4 * (0.5 + 0.5 * math.sin(T * 16.0))) or 0.55)
  local ring_scale = 1.0 - fold * 0.7
  for r = 0, scene.rings - 1 do
    local rr = (1 + r) * ring_scale
    local pts = {
      { math.floor(scene.cx - rr + 0.5), scene.cy },
      { math.floor(scene.cx + rr + 0.5), scene.cy },
      { scene.cx, math.floor(scene.cy - rr * 0.6 + 0.5) },
      { scene.cx, math.floor(scene.cy + rr * 0.6 + 0.5) },
    }
    local glyphs = { "╱", "╲", "╲", "╱" }
    for k, pt in ipairs(pts) do
      if pt[1] >= 0 and pt[1] < W and pt[2] >= 0 and pt[2] < H then
        fx:put(pt[1], pt[2], glyphs[k], sr, sg, sb)
      end
    end
  end
  fx:put(scene.cx, scene.cy, "*", pal(p, 5, err and 0.75 or 0.6))

  if err then
    local burst_pts = { { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } }
    local gl = { "x", "+", "*", "x" }
    for k, o in ipairs(burst_pts) do
      local x, y = scene.cx + o[1], scene.cy + o[2]
      if x >= 0 and x < W and y >= 0 and y < H then
        fx:put(x, y, gl[k], sbg.hsl(0.98, 0.55, 0.42))
      end
    end
  end

  if mode == "idle" and age > 60 then
    fx:put(math.min(W - 1, scene.cx + 4), math.max(0, scene.cy - 4), "☾", sky_colour(state.context_pct, 1.1))
  end
end
  return M
end)()

local Dust = (function()
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local COMPACT = 0.0
local scene = nil
local sig = ""

local KANA_THINK = { "ｼ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_TOOL = { "ｼ", "ﾞ", "ｯ", "ｺ", "ｰ", "ﾁ", "ｭ", "ｰ" }
local KANA_WAIT = { "ｷ", "ｮ", "ｶ", "ﾏ", "ﾞ", "ﾁ" }
local KANA_ERR = { "ｴ", "ﾏ", "ｰ" }
local KANA_COMPACT = { "ｾ", "ｰ", "ﾘ", "ﾁ", "ｭ", "ｰ" }
local KANA_IDLE = { "ｷ", "ｭ", "ｰ", "ｹ", "ｰ" }

local DIGITS = { "0", "1", "2", "3", "4", "5", "6", "7", "8", "9" }

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
    out = {
      { sbg.hex(0x111216) }, { sbg.hex(0x1C1E24) }, { sbg.hex(0x2A3038) },
      { sbg.hex(0x4B535D) }, { sbg.hex(0x746653) },
    }
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

local function kana_for(mode)
  if mode == "thinking" then return KANA_THINK end
  if mode == "tool" then return KANA_TOOL end
  if mode == "waiting" then return KANA_WAIT end
  if mode == "error" then return KANA_ERR end
  if mode == "compacting" then return KANA_COMPACT end
  return KANA_IDLE
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local prompts = jnum(j.prompts)
  local subagents = jnum(j.subagents)
  local area = W * H

  local floor_y = H - 2
  local rail_y = H - 1

  local pile_h = math.min(8, math.floor(tools / 10))
  local pile_x = W - 3

  local shelf_x0 = 1
  local shelf_w = sbg.clamp(math.floor(W * 0.32), 6, W - 4)
  local shelf_y = math.max(2, floor_y - 2)
  local shelf_rows_avail = math.max(1, shelf_y - 1)

  local mote_n = math.min(18, 3 + subagents + math.floor(tools / 25))

  local motes = {}
  for i = 1, mote_n do
    local seed_i = SEED + i * 733
    motes[i] = { seed = seed_i, face = (i % 3 == 0) }
  end

  local shelved = tools
  local shelf_cap = shelf_w * shelf_rows_avail
  local shelved_cells = math.min(tools, math.floor(area * 0.04), shelf_cap)

  local dust_n = 6 + math.floor(area / 600) + math.floor(area * 0.05 * sbg.clamp(tools / 300, 0, 1))
  local cobweb_thin = sbg.clamp(prompts / 20.0, 0, 1)

  scene = {
    floor_y = floor_y, rail_y = rail_y,
    pile_h = pile_h, pile_x = pile_x,
    shelf_x0 = shelf_x0, shelf_w = shelf_w, shelf_y = shelf_y,
    motes = motes,
    shelved = shelved, shelved_cells = shelved_cells,
    dust_n = dust_n, cobweb_thin = cobweb_thin,
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.prompts), jnum(j.subagents), W, H,
  }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
  COMPACT = 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  scene, sig = nil, ""
end

function M.step(dt, state)
  T = T + dt
  track_error(state, dt)
  if state.mode == "compacting" then
    COMPACT = math.min(1.0, COMPACT + dt * 1.4)
  else
    COMPACT = math.max(0.0, COMPACT - dt * 0.6)
  end
  if state.changed or scene == nil then
    local s = signature(state)
    if s ~= sig then
      sig = s
      build(state)
    end
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local j = state.journey or {}
  local mode = state.mode
  local mod = state.mod or {}
  local p = palette(state)
  local mood = state.mood or {}
  local age = tonumber(state.age) or 0
  local err = (mode == "error") or FRESH_ERR

  local title = mood.title
  if type(title) ~= "string" or title == "" then
    title = "Workshop " .. jstr(j.repo, "unnamed")
  end
  local kana = kana_for(mode)
  local status = title .. "  " .. table.concat(kana)
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local dr, dg, db = pal(p, 3, 0.22)
  local scatter = (mode == "error") and FRESH_ERR
  for i = 1, scene.dust_n do
    local h = sbg.hash("motedust" .. i .. SEED)
    local bx = h % W
    local by = 1 + (math.floor(h / 43) % math.max(1, scene.floor_y - 1))
    local nx = sbg.noise2(i * 0.4, T * 0.2)
    local ny = sbg.noise2(i * 0.4 + 40.0, T * 0.2)
    local x = sbg.wrap(bx + nx * 2.0, W)
    local y = sbg.wrap(by + ny * 1.5, math.max(1, scene.floor_y))
    local ch = (i % 2 == 0) and ":" or "."
    fx:put(math.floor(x), math.floor(y), ch, dr, dg, db)
  end

  local web_r, web_g, web_b = pal(p, 3, 0.3)
  local thin = scene.cobweb_thin
  local corners = { { 0, 1, 1, 1 }, { W - 1, 1, -1, 1 } }
  for _, c in ipairs(corners) do
    local cx, cy, sxn, syn = c[1], c[2], c[3], c[4]
    local reach = math.floor(3 * (1.0 - thin) + 0.5)
    for k = 0, reach do
      local x = cx + sxn * k
      local y = cy + (reach > 0 and math.floor(k * 0.4) or 0)
      if x >= 0 and x < W and y >= 0 and y < H then
        local ch = (k == 0) and "·" or ((k % 2 == 0) and "╲" or "╱")
        if sxn < 0 then ch = (k == 0) and "·" or ((k % 2 == 0) and "╱" or "╲") end
        fx:put(x, y, ch, web_r, web_g, web_b)
      end
    end
  end

  local floor_col = pal(p, 2, 0.4)
  for x = 0, W - 1 do
    fx:put(x, scene.floor_y, "─", floor_col)
  end
  local rail_r, rail_g, rail_b = pal(p, 3, 0.35)
  local rail_glyphs = { "-", "=", "-" }
  for x = 0, W - 1 do
    fx:put(x, scene.rail_y, rail_glyphs[(x % 3) + 1], rail_r, rail_g, rail_b)
  end

  local pile_col = pal(p, 4, 0.45)
  for r = 1, scene.pile_h do
    local py = scene.floor_y - r
    if py >= 0 then
      local width = math.max(1, scene.pile_h - r + 1)
      for x = scene.pile_x, math.min(W - 1, scene.pile_x + width - 1) do
        fx:put(x, py, "*", pile_col)
      end
    end
  end

  local shelf_r, shelf_g, shelf_b = pal(p, 4, 0.42)
  for x = scene.shelf_x0, scene.shelf_x0 + scene.shelf_w - 1 do
    if x < W then fx:put(x, scene.shelf_y, "═", shelf_r, shelf_g, shelf_b) end
  end
  local per_row = math.max(1, scene.shelf_w)
  local drawn = math.floor(scene.shelved_cells * (1.0 - COMPACT * 0.5) + 0.5)
  local rows = math.max(1, scene.shelf_y - 1)
  for i = 1, drawn do
    local row = 1 + math.floor((i - 1) / per_row)
    if row > rows then break end
    local col = ((i - 1) % per_row)
    local sx = scene.shelf_x0 + col
    local sy = scene.shelf_y - row
    if sx < W and sy >= 0 then
      local glyph = (COMPACT > 0.5) and "█" or "*"
      fx:put(sx, sy, glyph, sbg.scale(shelf_r, shelf_g, shelf_b, 0.9))
    end
  end
  if scene.shelved > 0 then
    local label = "x" .. tostring(scene.shelved)
    sbg.text(fx, scene.shelf_x0, scene.shelf_y + 1, label, pal(p, 5, 0.5))
  end

  local burst = mod.burst or 0
  local sprint_i = 1 + (math.floor(T * 2) % math.max(1, #scene.motes))
  local gather = (mode == "thinking")
  local scatter_now = (mode == "error") and FRESH_ERR
  for i, m in ipairs(scene.motes) do
    local rng_x = sbg.hash("motex" .. m.seed)
    local base_x = rng_x % W
    local phase = (sbg.hash("motep" .. m.seed) % 1000) / 1000.0
    local walk = sbg.noise2(i * 0.5, T * 0.3 + phase * 10.0)
    local x = sbg.wrap(base_x + walk * (W * 0.3), W)
    local y = scene.rail_y - 1
    local sprinting = (mode == "tool") and (i == sprint_i)
    if sprinting then
      x = sbg.wrap(scene.pile_x - (scene.pile_x - scene.shelf_x0) * (1.0 - burst), W)
    elseif gather then
      local t = 0.15
      x = x + (scene.pile_x - x) * t
    elseif scatter_now then
      local dir = (sbg.hash("scat" .. m.seed) % 2 == 0) and 1 or -1
      x = sbg.wrap(x + dir * 6.0, W)
    end
    local mx = math.floor(x)
    local walking = (math.floor(T * 4 + i) % 2 == 0)
    if walking and y - 1 >= 0 then
      fx:put(mx, y - 1, "'", pal(p, 4, 0.35))
      fx:put(mx + 1, y - 1, "'", pal(p, 4, 0.35))
    end
    if m.face then
      sbg.text(fx, mx - 1, y, "o_o", pal(p, 5, 0.5))
    else
      fx:put(mx, y, "o", pal(p, 5, 0.55))
    end
    if sprinting then
      fx:put(mx - 1, y, "*", pal(p, 4, 0.6))
    end
    if mode == "waiting" and i == 1 then
      fx:put(mx + 2, y, "?", pal(p, 4, 0.5))
    end
    if mode == "idle" and age > 60 and i == 1 then
      fx:put(mx + 1, y - 1, "z", pal(p, 4, 0.4))
    end
  end

  if err then
    local h = sbg.hash("scar" .. math.floor(T))
    local sx = scene.pile_x - (h % 4)
    fx:put(sx, scene.floor_y - 1, "*", sbg.hsl(0.02, 0.5, 0.32))
  end
end
  return M
end)()


local MOTIFS = {
  forest = Forest,
  skyline = Skyline,
  reef = Reef,
  circuit = Circuit,
  office = Office,
  sakura = Sakura,
  kana = Kana,
  shrine = Shrine,
  hangar = Hangar,
  dojo = Dojo,
  hud = Hud,
  studyroom = Studyroom,
  sparkfield = Sparkfield,
  dust = Dust,
}
local ORDER = { "forest", "skyline", "reef", "circuit", "office", "sakura", "kana", "shrine", "hangar", "dojo", "hud", "studyroom", "sparkfield", "dust" }

local CTX = nil
local CURRENT = nil
local ACTIVE = nil
local SAVED = nil
local INITIALIZED = {}

local function choose(state)
  local mood = state.mood or {}
  local want = mood.motif
  if want == "fortress" then return "office" end
  if type(want) == "string" and MOTIFS[want] then return want end
  local j = state.journey or {}
  local key = j.repo
  if type(key) ~= "string" or key == "" then
    key = tostring((CTX and CTX.seed) or 0)
  end
  local pick = sbg.pick(ORDER, key)
  if type(pick) == "string" and MOTIFS[pick] then return pick end
  return "office"
end

function init(ctx)
  CTX = ctx
  CURRENT, ACTIVE = nil, nil
  INITIALIZED = {}
end

function step(dt, state)
  if CTX == nil then return end
  local want = choose(state)
  if want ~= CURRENT then
    CURRENT = want
    ACTIVE = MOTIFS[want]
    if not INITIALIZED[want] then ACTIVE.init(CTX); INITIALIZED[want] = true
    elseif ACTIVE.resize then ACTIVE.resize(CTX) end
    if SAVED and ACTIVE.restore then ACTIVE.restore(SAVED); SAVED = nil end
  end
  ACTIVE.step(dt, state)
end

function resize(ctx)
  CTX = ctx
  if ACTIVE then
    if ACTIVE.resize then ACTIVE.resize(ctx) else ACTIVE.init(ctx) end
  end
end

function restore(data) SAVED = data end
function foreground_halo() return (ACTIVE and ACTIVE.export) and 1 or 0 end
function checkpoint() if ACTIVE and ACTIVE.export then return ACTIVE.export() end end

function render(fx, state)
  if ACTIVE == nil then return end
  ACTIVE.render(fx, state)
end
