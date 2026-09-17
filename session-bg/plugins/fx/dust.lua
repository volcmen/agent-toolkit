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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
