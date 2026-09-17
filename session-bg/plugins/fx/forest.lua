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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
