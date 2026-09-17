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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
