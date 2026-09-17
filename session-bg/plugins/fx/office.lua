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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
