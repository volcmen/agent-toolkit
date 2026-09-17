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
  local area = W * H
  local ctx_pct = sbg.clamp((tonumber(state.context_pct) or 0), 0, 100)

  local growth = sbg.clamp(tools / 300.0, 0.0, 1.0)
  local frac = sbg.lerp(0.065, 0.16, growth)
  local trail = 6 + math.floor(ctx_pct / 12) + math.floor(tools / 50)
  local target_cells = frac * area

  local min_cols = 6 + math.floor(W / 25)
  local max_cols = math.max(min_cols, math.floor(W * 0.6))
  local col_n = math.floor(sbg.clamp(target_cells / trail, min_cols, max_cols))

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

  local tail_col = { pal(p, 2, 0.32) }

  if COLLAPSE > 0.02 then
    local bandw = math.max(1, math.floor(W * 0.06))
    local x0 = W - bandw
    for i, c in ipairs(scene.cols) do
      local tx = x0 + ((i - 1) % bandw)
      local x = sbg.lerp(c.x, tx, COLLAPSE)
      local ch = (i % 2 == 0) and "│" or "┆"
      for row = 1, 6 do
        local y = math.floor(sbg.wrap(RT * c.speed * 0.4 + row * 2 + c.phase, H))
        put1(fx, math.floor(x + 0.5), y, ch, tail_col[1], tail_col[2], tail_col[3])
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
            r, g, b = sbg.hsl(0.0, 0.5, 0.30 + 0.10 * GLITCH)
            glyph = ({ "x", "/", "\\" })[(t % 3) + 1]
          else
            r, g, b = sbg.mix(tail_col[1], tail_col[2], tail_col[3], head_r, head_g, head_b, k)
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
    sbg.text(fx, math.max(0, W - 4), H - 2, "zz", pal(p, 3, 0.32))
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

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
