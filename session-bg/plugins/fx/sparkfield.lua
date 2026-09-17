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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
