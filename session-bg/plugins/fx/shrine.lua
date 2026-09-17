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
  local ctx = sbg.clamp((tonumber(state.context_pct) or 0) / 100.0, 0, 1)

  local gate_h = math.max(5, math.floor(H * 0.30))
  local gy = H - 1
  local gx = math.max(3, math.floor(W * 0.10))

  local path_len = math.max(1, W - gx - 3)
  local base_steps = math.max(3, math.floor(path_len * 0.30))
  local grow_steps = math.floor(tools / 5)
  local steps = sbg.clamp(base_steps + grow_steps, base_steps, path_len)

  local top_y = math.max(0, gy - gate_h)
  local avail_h = math.max(1, top_y)
  local rows_max = sbg.clamp(math.floor(avail_h * 0.4), 2, 24)
  local stage = 0
  if ctx >= 0.9 or tools >= 240 then stage = 4
  elseif ctx >= 0.75 or tools >= 180 then stage = 3
  elseif ctx >= 0.5 or tools >= 120 then stage = 2
  elseif ctx >= 0.25 or tools >= 60 then stage = 1
  end
  local base_layers = math.max(1, math.floor(rows_max * 0.28))
  local layers = sbg.clamp(base_layers + math.ceil(stage * (rows_max - base_layers) / 4.0), base_layers, rows_max)

  local base_posts = sbg.clamp(math.floor(path_len / 30), 1, 8)
  local posts = sbg.clamp(base_posts + math.floor(tools / 25), base_posts, 8)
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
    rows_max = rows_max,
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
  local gr, gg, gb = mainc(p, 5, 0.65)
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
  local pr1, pr2, pr3 = mainc(p, 5, 0.5)
  for y = top_y + 2, gy do
    fx:put(gx, y, "┃", pr1, pr2, pr3)
    fx:put(gx + 4, y, "┃", pr1, pr2, pr3)
  end

  if mode == "waiting" and (tonumber(state.age) or 0) > 8 then
    if sbg.text then sbg.text(fx, gx - 4, gy - 1, "(-_-)", mainc(p, 4, 0.6)) end
  end

  local layer_y0 = math.max(0, top_y - scene.rows_max)
  local layer_y1 = math.max(0, top_y - 1)
  local tr, tg, tb = pal(p, 3, 0.55)
  local shown_layers = math.floor(math.max(1, scene.layers) * (1.0 - COMPACT) + 0.5)
  for li = 1, shown_layers do
    local y = layer_y1 - (li - 1)
    if y >= layer_y0 then
      local fade = (1.0 - (shown_layers - li) * 0.10) * (1.0 - COMPACT)
      for x = 0, W - 1 do
        local n = sbg.noise2(x * 0.15 + li * 3.1, T * 0.02)
        if n > 0.12 then
          local mask = 1 + (math.floor(sbg.clamp((n + 1) * 4, 0, 7)))
          local ch = sbg.glyphs.braille[mask]
          fx:put(x, y, ch, sbg.scale(tr, tg, tb, math.max(0.25, fade)))
        end
      end
    end
  end

  local dot_r, dot_g, dot_b = mainc(p, 2, 0.55)
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
      fx:put(mx, gy - 1, "▸", mainc(p, 4, 0.7))
    end
  end

  local lr, lg, lb = sbg.hsl(0.10, 0.55, 0.42)
  for i, x in ipairs(scene.posts) do
    if x < W then
      fx:put(x, gy - 1, "┬", mainc(p, 3, 0.5))
      local bright = 0.7
      if mode == "tool" and i == #scene.posts then
        bright = 0.7 + 0.5 * (mod.burst or 0)
      end
      local hr, hg, hb = sbg.scale(lr, lg, lb, bright)
      fx:put(x, gy - 2, "▣", floor_l(hr, hg, hb, 0.30))
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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
