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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
