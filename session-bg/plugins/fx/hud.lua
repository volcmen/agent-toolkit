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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
