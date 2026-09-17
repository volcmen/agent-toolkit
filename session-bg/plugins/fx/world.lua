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
  local prompts = jnum(j.prompts)
  local files = sum_files(j)

  local base_x = 2
  local base_y = H - 1

  local max_segments = math.min(220, math.max(10, math.floor((W + H) * 1.4)))
  local segments = math.min(max_segments, 4 + math.floor(tools / 6))
  local depth = math.floor(sbg.clamp(2 + tools / 50, 2, 6))
  local trunk_len = sbg.clamp(4 + depth * 2.0, 4, H * 0.68)

  local rng = sbg.rng(sbg.hash(jstr(j.repo, "sbg") .. ":sakura") + SEED)
  local root = grow(rng, depth, trunk_len, 0.0, { segments })

  local cx = base_x + trunk_len * 0.35
  local cy = base_y - trunk_len - depth * 1.4
  local radius = 3 + depth * 1.8

  local max_bloom = math.max(6, math.floor(W * H * 0.045))
  local bloom_n = math.floor(sbg.clamp(3 + prompts * 1.1, 3, max_bloom))
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

  local max_petals = math.max(4, math.floor(W * H * 0.03))
  local petal_n = math.floor(sbg.clamp(4 + files, 4, max_petals))
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
  local budget = { math.floor(W * H * 0.10) }
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
      local r, g, b = pal(p, 5, 0.30)
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
        r, g, b = sbg.hsl(0.0, 0.55, 0.28)
      else
        r, g, b = pal(p, 5, 0.42)
      end
      put1(fx, math.floor(x), math.floor(y), pt.glyph, r, g, b)
    end
  end

  for i, d in ipairs(DRIFT) do
    local x = W - 1 - (i - 1)
    if x < 0 then break end
    local r, g, b = pal(p, 5, 0.30)
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

  local max_cols = math.max(1, math.floor(W / 6))
  local col_n = math.min(max_cols, 3 + math.floor(tools / 15))
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
    local trail = 4 + math.floor(sbg.clamp((tonumber(state.context_pct) or 0), 0, 100) / 12)
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

  local bg = { pal(p, 1, 0.5) }

  if COLLAPSE > 0.02 then
    local bandw = math.max(1, math.floor(W * 0.06))
    local x0 = W - bandw
    for i, c in ipairs(scene.cols) do
      local tx = x0 + ((i - 1) % bandw)
      local x = sbg.lerp(c.x, tx, COLLAPSE)
      local ch = (i % 2 == 0) and "│" or "┆"
      for row = 1, 6 do
        local y = math.floor(sbg.wrap(RT * c.speed * 0.4 + row * 2 + c.phase, H))
        put1(fx, math.floor(x + 0.5), y, ch, bg[1], bg[2], bg[3])
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
            r, g, b = sbg.hsl(0.0, 0.5, 0.22 * GLITCH + 0.05)
            glyph = ({ "x", "/", "\\" })[(t % 3) + 1]
          else
            r, g, b = sbg.mix(bg[1], bg[2], bg[3], head_r, head_g, head_b, k)
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
    sbg.text(fx, math.max(0, W - 4), H - 2, "zz", pal(p, 3, 0.30))
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

  local steps = math.min(W, 1 + math.floor(tools / 5))
  local path_len = math.max(1, W - gx - 3)
  steps = math.min(steps, path_len)

  local layers = {}
  local seg = math.min(4, 1 + math.floor(sbg.clamp(ctx, 0, 1) * 4))
  local tool_layers = math.min(4, math.floor(tools / 60))
  layers = math.max(seg, tool_layers)
  layers = sbg.clamp(layers, 0, 4)

  local posts = math.min(8, math.floor(tools / 25))
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
  local gr, gg, gb = pal(p, 5, 0.55)
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
  local pr1, pr2, pr3 = pal(p, 5, 0.45)
  for y = top_y + 2, gy do
    fx:put(gx, y, "┃", pr1, pr2, pr3)
    fx:put(gx + 4, y, "┃", pr1, pr2, pr3)
  end

  if mode == "waiting" and (tonumber(state.age) or 0) > 8 then
    if sbg.text then sbg.text(fx, gx - 4, gy - 1, "(-_-)", pal(p, 4, 0.5)) end
  end

  local layer_y0 = math.max(0, top_y - 8)
  local layer_y1 = math.max(0, top_y - 1)
  local tr, tg, tb = pal(p, 3, 0.5)
  local shown_layers = math.floor(math.max(1, scene.layers) * (1.0 - COMPACT) + 0.5)
  for li = 1, shown_layers do
    local y = layer_y1 - (li - 1)
    if y >= layer_y0 then
      local fade = (1.0 - (shown_layers - li) * 0.15) * (1.0 - COMPACT)
      for x = 0, W - 1, 2 do
        local n = sbg.noise2(x * 0.15 + li * 3.1, T * 0.02)
        if n > -0.15 then
          local mask = 1 + (math.floor(sbg.clamp((n + 1) * 4, 0, 7)))
          local ch = sbg.glyphs.braille[mask]
          fx:put(x, y, ch, sbg.scale(tr, tg, tb, math.max(0.2, fade)))
        end
      end
    end
  end

  local dot_r, dot_g, dot_b = pal(p, 2, 0.4)
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
      fx:put(mx, gy - 1, "▸", pal(p, 4, 0.6))
    end
  end

  local lr, lg, lb = sbg.hsl(0.10, 0.55, 0.42)
  for i, x in ipairs(scene.posts) do
    if x < W then
      fx:put(x, gy - 1, "┬", pal(p, 3, 0.45))
      local bright = 0.35
      if mode == "tool" and i == #scene.posts then
        bright = 0.35 + 0.5 * (mod.burst or 0)
      end
      fx:put(x, gy - 2, "▣", sbg.scale(lr, lg, lb, bright))
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
  local bay_h = math.min(5, math.max(3, bot_y - top_y - 1))
  local bay_y0 = math.max(top_y + 1, math.floor((top_y + bot_y) / 2) - math.floor(bay_h / 2))
  local bay_y1 = math.min(bot_y - 1, bay_y0 + bay_h)

  local bay_w = 8
  local max_bays = math.max(1, math.floor((W - 4) / bay_w))
  local total_bays = math.floor(tools / 30) + 1
  local shown = math.min(max_bays, total_bays)
  local first = total_bays - shown

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

  local rail_r, rail_g, rail_b = pal(p, 3, 0.4)
  local tick = math.floor(T * 6.0) % (2 * math.max(1, W))
  for x = 0, W - 1 do
    if x % 2 == 0 then
      fx:put(x, scene.top_y, "\226\149\170", rail_r, rail_g, rail_b)
      fx:put(x, scene.bot_y, "\226\148\128", rail_r, rail_g, rail_b)
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
    local br, bg, bb = pal(p, 2, 0.5 * bay.fade)
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

        local mr, mg, mb = sbg.hsl(0.60, 0.15, 0.32 * bay.fade)
        local midy = math.floor((y0 + y1) / 2)
        fx:put(x + 1, midy - 1, "\226\150\159", mr, mg, mb)
        fx:put(x + 2, midy - 1, "\226\150\136", mr, mg, mb)
        fx:put(x + 3, midy - 1, "\226\150\153", mr, mg, mb)
        fx:put(x + 1, midy, "\226\150\144", mr, mg, mb)
        fx:put(x + 3, midy, "\226\150\140", mr, mg, mb)
        fx:put(x + 2, midy + 1, "=", mr, mg, mb)

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
        fx:put(x + 1, y1 - 1, lamp_ch, sbg.scale(lr, lg, lb, bay.fade))

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
  local bot_y = math.max(top_y + 1, H - 4)
  local band_h = math.max(1, bot_y - top_y + 1)
  local band_cap = math.max(2, math.floor(band_h * 0.55))
  local total_cap = band_cap * 2
  local nlines = math.min(total_cap, math.floor(tools / 4))
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
  local group_cap = math.max(0, math.floor((W * 0.5) / group_w))
  local groups = math.min(group_cap, math.floor(prompts / 5))

  local ticks = math.floor(sbg.clamp((tonumber(state.context_pct) or 0) / 10.0, 0, 10))

  scene = {
    band_w = band_w,
    top_y = top_y,
    bot_y = bot_y,
    speed = speed,
    groups = groups,
    ticks = ticks,
    lvl = math.floor(tools / 25) + 1,
    chibi_x = math.max(band_w + 1, math.floor(W * 0.5) - math.floor(band_w * 0.5)),
    chibi_y = math.max(top_y, H - 3),
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
    sbg.text(fx, 1, 0, title .. "  " .. table.concat(kana), pal(p, 5, 0.85))
  end

  local lr, lg, lb = pal(p, 3, 0.5)
  if sbg.text then sbg.text(fx, 0, 1, "LV" .. tostring(scene.lvl), pal(p, 4, 0.6)) end
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
    local wr, wg, wb = pal(p, 2, 0.5)
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
      local fade = 0.35 + 0.55 * sbg.clamp(1.0 - s.age / math.max(1, #scene.speed), 0, 1)
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
      local cr, cg, cb = pal(p, 2, fade)
      if err and s.band == err_band then
        cr, cg, cb = sbg.hsl(0.98, 0.55, 0.40 * fade)
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

    for gi = 1, scene.groups do
      local side = (gi % 2 == 1) and "L" or "R"
      local slot = math.floor((gi - 1) / 2)
      local x0
      if side == "L" then
        x0 = 1 + slot * 10
      else
        x0 = W - 2 - 9 - slot * 10
      end
      if x0 >= 0 and x0 + 8 < W then
        local tr, tg, tb = pal(p, 4, 0.45)
        local tally = "| | | | /"
        for ci = 1, #tally do
          local ch = tally:sub(ci, ci)
          if ch ~= " " then
            fx:put(x0 + ci - 1, H - 1, ch, tr, tg, tb)
          end
        end
      end
    end
  end

  local age = tonumber(state.age) or 0
  local rows = CHIBI_STAND
  local sr, sg, sb = pal(p, 5, 0.6)
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
        if ax >= 0 then fx:put(ax, cy - 1, ch, pal(p, 3, 0.4)) end
        if bxp < W then fx:put(bxp, cy - 1, ch, pal(p, 3, 0.4)) end
      end
    elseif mode == "waiting" then
      if sbg.text then sbg.text(fx, scene.chibi_x, scene.chibi_y - 1, "...", pal(p, 4, 0.5)) end
    elseif mode == "error" then
      if sbg.text then sbg.text(fx, scene.chibi_x, scene.chibi_y - 1, "!!!", sbg.hsl(0.98, 0.6, 0.45)) end
    elseif (mode == "idle" or mode == "start" or mode == "end") and age > 60 then
      fx:put(scene.chibi_x + 2, scene.chibi_y - 1, "z", pal(p, 3, 0.35))
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
    if type(k) == "string" then list[#list + 1] = { k, jnum(v) } end
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
  local width = shrink and math.min(24, W - 2) or math.min(34, W - 2)
  width = math.max(10, width)
  local x0 = math.max(0, W - width - 1)

  local rows = {}
  if jnum(j.prompts) > 0 then rows[#rows + 1] = { key = "PROMPTS", text = "PROMPTS " .. tostring(jnum(j.prompts)) } end
  if jnum(j.tools) > 0 then rows[#rows + 1] = { key = "TOOLS", text = "TOOLS " .. tostring(jnum(j.tools)) } end
  local exts = top_n(j.files, 3)
  if #exts > 0 then rows[#rows + 1] = { key = "FILES", text = "FILES " .. table.concat(exts, " ") } end
  if jnum(j.subagents_peak) > 0 then rows[#rows + 1] = { key = "PARTY", text = "PARTY x" .. tostring(jnum(j.subagents_peak)) } end
  if (tonumber(state.context_pct) or 0) > 0 then rows[#rows + 1] = { key = "MANA", text = "MANA" } end
  if jnum(j.errors) > 0 then rows[#rows + 1] = { key = "WOUNDS", text = "WOUNDS " .. tostring(jnum(j.errors)) } end
  if jnum(j.compactions) > 0 then rows[#rows + 1] = { key = "RESTS", text = "RESTS " .. tostring(jnum(j.compactions)) } end

  local words = {}
  for k, v in pairs(j.words or {}) do
    if type(k) == "string" then words[#words + 1] = { k, jnum(v) } end
  end
  table.sort(words, function(a, b)
    if a[2] == b[2] then return a[1] < b[1] end
    return a[2] > b[2]
  end)
  local skills = {}
  for i = 1, math.min(4, #words) do skills[i] = words[i][1] end

  local prompt_src = jstr(j.last_prompt, jstr(state.prompt, ""))
  local qmax = math.max(4, math.floor(W / 3))
  prompt_src = trunc_cells(prompt_src, qmax)

  scene = {
    x0 = x0,
    width = width,
    shrink = shrink,
    rows = rows,
    skills = skills,
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

  local dim = (mode == "idle") and 0.55 or 1.0
  local br, bg, bb = pal(p, 3, 0.55 * dim)

  local content_rows = {}
  if mode == "compacting" then
    content_rows = {}
  elseif mode ~= "idle" then
    for _, row in ipairs(scene.rows) do content_rows[#content_rows + 1] = row end
  end

  local mode_row = nil
  if mode == "thinking" then
    mode_row = "STATE FOCUS"
  elseif mode == "tool" then
    mode_row = "ACTION >>>"
  elseif mode == "waiting" then
    mode_row = "CONFIRM ?"
  elseif mode == "error" then
    mode_row = "ERROR"
  end

  local box_h
  if mode == "compacting" then
    box_h = 2
  else
    box_h = 3 + #content_rows + (mode_row and 1 or 0)
    local max_h = H - 1
    box_h = math.min(box_h, max_h)
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
      if x > x0 and x < x0 + width - 1 then fx:put(x, y0, ch, pal(p, 4, 0.6)) end
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
    sbg.text(fx, x0 + 1, y, label, pal(p, 5, 0.9 * dim))
  end

  if mode_row and not scene.shrink then
    y = y + 1
    fx:put(x0, y, "│", br, bg, bb)
    fx:put(x0 + width - 1, y, "│", br, bg, bb)
    local mr, mg, mb = pal(p, 4, 0.6)
    local text = mode_row
    if mode == "error" then
      local flash = FRESH_ERR and 1.0 or 0.3
      mr, mg, mb = sbg.hsl(0.98, 0.45, 0.30 * flash)
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

  if not scene.shrink and mode ~= "idle" then
    for _, row in ipairs(content_rows) do
      y = y + 1
      if y >= H - 1 then break end
      fx:put(x0, y, "│", br, bg, bb)
      fx:put(x0 + width - 1, y, "│", br, bg, bb)
      local text = row.text
      if row.key == "MANA" then
        local pct = sbg.clamp(100 - (tonumber(state.context_pct) or 0), 0, 100)
        local bar_w = 10
        local filled = math.floor((pct / 100) * bar_w)
        local bar = {}
        for i = 1, bar_w do bar[i] = (i <= filled) and "█" or "░" end
        text = "MANA [" .. table.concat(bar) .. "]"
      end
      text = trunc_cells(text, width - 3)
      local rr, rg, rb = pal(p, 2, 0.6)
      if row.key == "WOUNDS" and FRESH_ERR then rr, rg, rb = sbg.hsl(0.98, 0.45, 0.35) end
      if sbg.text then sbg.text(fx, x0 + 1, y, text, rr, rg, rb) end
    end
  end

  y = y + 1
  if y < H then box_row(fx, x0, y, width, "└", "─", "┘", br, bg, bb) end

  if #scene.skills > 0 and y + 3 <= H - 1 then
    local py = y + 1
    box_row(fx, x0, py, width, "┌", "─", "┐", pal(p, 2, 0.4 * dim))
    fx:put(x0, py + 1, "│", pal(p, 2, 0.4 * dim))
    fx:put(x0 + width - 1, py + 1, "│", pal(p, 2, 0.4 * dim))
    local text = trunc_cells("SKILL " .. table.concat(scene.skills, " "), width - 3)
    if sbg.text then sbg.text(fx, x0 + 1, py + 1, text, pal(p, 4, 0.5 * dim)) end
    box_row(fx, x0, py + 2, width, "└", "─", "┘", pal(p, 2, 0.4 * dim))
  end

  if mode == "idle" and (tonumber(state.age) or 0) > 60 then
    if sbg.text then sbg.text(fx, math.max(0, x0 - 9), y0, "(-_-) zz", pal(p, 3, 0.4)) end
  end

  if #scene.quest > 0 and sbg.text then
    sbg.text(fx, 1, H - 1, ">> " .. scene.quest, pal(p, 3, 0.5))
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
}
local ORDER = { "forest", "skyline", "reef", "circuit", "office", "sakura", "kana", "shrine", "hangar", "dojo", "hud" }

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
