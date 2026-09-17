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
local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local FLOOR_H = 6
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

local function words_of(text)
  local out = {}
  if type(text) ~= "string" then return out end
  for raw in text:gmatch("[^%s]+") do
    local word = raw
    if #word > 14 then
      local cut = 14
      while cut > 1 and word:byte(cut + 1) and word:byte(cut + 1) >= 128 and word:byte(cut + 1) < 192 do
        cut = cut - 1
      end
      word = word:sub(1, cut)
    end
    out[#out + 1] = word
    if #out >= 24 then break end
  end
  return out
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local floors = 1 + math.floor(tools / 40)
  local visible = math.max(1, math.floor((H - 2) / FLOOR_H))
  local shown = math.min(visible, floors)
  local subs = math.floor(sbg.clamp(jnum(j.subagents), 0, 6))
  local desks = {}
  local slot = math.max(10, math.floor((W - 22) / math.max(1, subs + 1)))
  for i = 0, subs do
    local x = 3 + i * slot
    if x > W - 16 then break end
    desks[#desks + 1] = { x = x, lead = i == 0, id = i }
  end
  scene = {
    floors = floors,
    shown = shown,
    desks = desks,
    plant = math.floor(sbg.clamp(1 + jnum(state.lines_added) / 160.0, 1, 5)),
    words = words_of(j.last_prompt or state.prompt),
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(state.lines_added), jnum(j.subagents),
    tostring(j.last_prompt or state.prompt), W, H,
  }, "/")
end

local function sprite_for(state, i)
  local mode = state.mode
  local age = tonumber(state.age) or 0
  if mode == "error" then return "⚡", "☻" end
  if mode == "waiting" then return "☕", "☺" end
  if mode == "idle" or mode == "end" or mode == "start" then
    if age > 60 then return "☾", "☺" end
    return "·", "☺"
  end
  if mode == "compacting" then return "⚙", "☺" end
  local blink = math.floor(T * 3.0 + i) % 2
  return blink == 0 and "✎" or "⌨", "☺"
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T = 0.0
  LAST_ERR, ERR_AGE, FRESH_ERR = "", 99.0, false
  FLOOR_H = (H >= 20) and 6 or 5
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
    title = "Studio " .. jstr(j.repo, "unnamed")
  end
  local status = title .. string.format("  ·  %d tools  ·  +%d -%d",
    math.floor(jnum(j.tools)), math.floor(jnum(state.lines_added)),
    math.floor(jnum(state.lines_removed)))
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local wr, wg, wb = pal(p, 1, 0.45)
  local err = (mode == "error") or FRESH_ERR

  for k = 0, scene.shown - 1 do
    local top = 2 + k * FLOOR_H
    local fy = top + FLOOR_H - 2
    if fy >= H then break end
    local newest = k == 0
    local fade = newest and 1.0 or math.max(0.30, 0.85 - k * 0.18)
    local fr, fg, fb = sbg.scale(wr, wg, wb, fade)

    for x = 0, W - 1 do
      if x % 2 == 0 then fx:put(x, fy, "─", fr, fg, fb) end
    end

    local sr, sg, sb = sky_colour(state.context_pct, 0.55 * fade)
    local wx = W - 14
    while wx < W - 3 do
      fx:put(wx, fy - 3, "▦", sr, sg, sb)
      fx:put(wx + 1, fy - 3, "▦", sr, sg, sb)
      wx = wx + 5
    end
    if newest then
      local pct = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)
      fx:put(W - 9, fy - 4, pct > 0.72 and "☾" or "☀", sky_colour(state.context_pct, 1.4))
    end

    if newest then
      for i, d in ipairs(scene.desks) do
        local above, face = sprite_for(state, i)
        if not d.lead then face = "♟" end
        if err then face = d.lead and "☻" or "♙" end
        local dr, dg, db = pal(p, 2, 0.55)
        fx:put(d.x + 1, fy - 1, "▤", dr, dg, db)
        fx:put(d.x + 2, fy - 1, "▦", dr, dg, db)
        local cr, cg, cb = sbg.hsl(d.lead and 0.14 or 0.48, 0.45, 0.38)
        if err then cr, cg, cb = sbg.hsl(0.02, 0.55, 0.40) end
        fx:put(d.x, fy - 1, face, cr, cg, cb)
        if above ~= "·" then
          local ar, ag, ab = sbg.hsl(err and 0.08 or 0.12, 0.40, 0.34)
          fx:put(d.x + 2, fy - 2, above, ar, ag, ab)
        end
        if mode == "idle" and (tonumber(state.age) or 0) > 60 then
          local zz = math.floor(T * 1.5 + i) % 3
          fx:put(d.x + 3 + zz, fy - 3 - zz, "z", sbg.hsl(0.58, 0.20, 0.28))
        end
      end

      local bx = math.min(W - 20, math.max(18, math.floor(W * 0.42)))
      local by = fy - 4
      if by > 1 and #scene.words > 0 then
        local br2, bg2, bb2 = pal(p, 3, 0.40)
        for x = bx, math.min(W - 1, bx + 17) do
          fx:put(x, by - 1, "─", br2, bg2, bb2)
        end
        fx:put(bx, by, "│", br2, bg2, bb2)
        fx:put(math.min(W - 1, bx + 17), by, "│", br2, bg2, bb2)
        local n = #scene.words
        local start = math.floor(T / 2.2) % n
        local line = {}
        for i = 0, 2 do
          line[#line + 1] = scene.words[(start + i) % n + 1]
        end
        local text = table.concat(line, " ")
        if #text > 15 then text = text:sub(1, 15) end
        if sbg.text then
          sbg.text(fx, bx + 1, by, text, pal(p, 4, 0.45))
        end
      end

      local mr, mg, mb = pal(p, 2, 0.45)
      fx:put(W - 3, fy - 1, "▥", mr, mg, mb)
      fx:put(W - 3, fy - 2, "☕", sbg.hsl(0.07, 0.45, 0.34))
      local pr, pg, pb = sbg.hsl(0.33, 0.45, 0.32)
      fx:put(1, fy - 1, "▣", sbg.scale(mr, mg, mb, 0.8))
      local tall = math.min(scene.plant, math.max(1, FLOOR_H - 3))
      for s = 1, tall do
        local lean = math.floor(math.sin(T * 0.5 + s) * 0.6)
        local y = fy - 1 - s
        if y >= top then
          fx:put(1 + lean, y, s == tall and "♣" or "│", pr, pg, pb)
        end
      end
    else
      local ghosts = math.min(4, 1 + math.floor(jnum(j.tools) / 80))
      for i = 1, ghosts do
        local gx = 4 + (i - 1) * math.max(8, math.floor(W / (ghosts + 1)))
        if gx < W - 4 then
          fx:put(gx, fy - 1, "♟", sbg.scale(fr, fg, fb, 0.8))
          fx:put(gx + 1, fy - 1, "▤", sbg.scale(fr, fg, fb, 0.7))
        end
      end
    end
  end

  if (mod.burst or 0) > 0.15 or mode == "tool" then
    local fy = 2 + FLOOR_H - 2
    local x = math.floor(sbg.wrap(T * 22.0, W))
    local y = math.max(1, fy - 5 + math.floor(math.sin(T * 3.0) * 1.2))
    fx:put(x, y, "✧", sbg.hsl(0.12, 0.35, 0.36))
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
}
local ORDER = { "forest", "skyline", "reef", "circuit", "office" }

local CTX = nil
local CURRENT = nil
local ACTIVE = nil

local function choose(state)
  local mood = state.mood or {}
  local want = mood.motif
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
end

function step(dt, state)
  if CTX == nil then return end
  local want = choose(state)
  if want ~= CURRENT then
    CURRENT = want
    ACTIVE = MOTIFS[want]
    ACTIVE.init(CTX)
  end
  ACTIVE.step(dt, state)
end

function render(fx, state)
  if ACTIVE == nil then return end
  ACTIVE.render(fx, state)
end
