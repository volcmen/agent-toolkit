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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
