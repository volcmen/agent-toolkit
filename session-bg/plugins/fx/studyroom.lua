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

local BOOK_GLYPHS = { "▌", "▐", "│", "▍" }
local SPIN = { "|", "/", "-", "\\" }

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
    out = {
      { sbg.hex(0x18171E) }, { sbg.hex(0x292833) }, { sbg.hex(0x414152) },
      { sbg.hex(0x65545A) }, { sbg.hex(0x776448) },
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

local function ext_colour(ext, l)
  local s, h = 0.46, EXT_HUE[ext]
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
  for i = 1, math.min(6, #list) do out[i] = list[i][1] end
  if #out == 0 then out[1] = "md" end
  return out
end

local function total_files(j)
  local n = 0
  for _, v in pairs(j.files or {}) do n = n + jnum(v) end
  return n
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
  local errors = jnum(j.errors)
  local added = jnum(state.lines_added)

  local desk_w = sbg.clamp(math.floor(W * 0.22), 8, 16)
  local desk_x = 1
  local desk_y = math.max(3, H - 3)
  local surface_y = desk_y - 1

  local win_w, win_h = 5, 5
  local win_x = math.max(desk_x + desk_w + 3, W - win_w - 2)
  local win_y = 0

  local shelf_w = sbg.clamp(math.floor(W * 0.28), 6, 18)
  local shelf_x0 = 1
  local shelf_slots = {}
  local sy = math.max(1, desk_y - 6)
  for i = 1, 3 do
    local ry = sy - (i - 1) * 2
    if ry >= 1 and ry < surface_y - 1 then shelf_slots[i] = ry end
  end

  local books_total = math.min(total_files(j), shelf_w * #shelf_slots)
  local active_shelves = math.min(#shelf_slots, math.max(1, math.ceil(books_total / shelf_w)))
  local shelf_rows = {}
  for i = 1, active_shelves do shelf_rows[i] = shelf_slots[i] end
  local exts = top_exts(j)

  local plant_stems = sbg.clamp(math.floor(added / 300), 0, 4)
  local plant_x0 = desk_x + desk_w + 2

  local grain_base = math.floor(W * H * 0.028)
  local grain_grow = math.floor(W * H * 0.065 * sbg.clamp(tools / 300, 0, 1))
  local grain_n = math.min(grain_base + grain_grow, math.floor(W * H * 0.18))

  local notes = math.min(24, prompts)
  local papers = math.min(6, errors)

  scene = {
    desk_x = desk_x, desk_y = desk_y, desk_w = desk_w, surface_y = surface_y,
    win_x = win_x, win_y = win_y, win_w = win_w, win_h = win_h,
    shelf_x0 = shelf_x0, shelf_w = shelf_w, shelf_rows = shelf_rows,
    books_total = books_total, exts = exts,
    plant_stems = plant_stems, plant_x0 = plant_x0, added = added,
    grain_n = grain_n, notes = notes, papers = papers,
    cat = tools >= 20,
  }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({
    jnum(j.tools), jnum(j.prompts), jnum(j.errors), total_files(j),
    math.floor(jnum(state.lines_added) / 50), W, H,
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
    title = "Study " .. jstr(j.repo, "unnamed")
  end
  local kana = kana_for(mode)
  local status = title .. "  " .. table.concat(kana)
  if sbg.text then
    sbg.text(fx, 1, 0, status, pal(p, 5, 0.85))
  end

  local gcr, gcg, gcb = pal(p, 3, 0.18)
  local blink = 1.0
  if mode == "idle" and age > 30 then
    blink = 0.65 + 0.35 * math.sin(T * 0.4)
  end
  for i = 1, scene.grain_n do
    local h = sbg.hash("grain" .. i .. SEED)
    local x = h % W
    local y = 1 + (math.floor(h / 97) % math.max(1, H - 4))
    local ch = ((i % 3) == 0) and ":" or "."
    fx:put(x, y, ch, sbg.scale(gcr, gcg, gcb, 0.5 + 0.5 * blink))
  end

  local dx, dy, dw = scene.desk_x, scene.desk_y, scene.desk_w
  local dr, dg, db = pal(p, 2, 0.45)
  fx:put(dx, dy, "┌", dr, dg, db)
  fx:put(dx + dw - 1, dy, "┐", dr, dg, db)
  for x = dx + 1, dx + dw - 2 do fx:put(x, dy, "─", dr, dg, db) end
  fx:put(dx, dy + 1, "│", dr, dg, db)
  fx:put(dx + dw - 1, dy + 1, "│", dr, dg, db)
  fx:put(dx, dy + 2, "└", dr, dg, db)
  fx:put(dx + dw - 1, dy + 2, "┘", dr, dg, db)
  for x = dx + 1, dx + dw - 2 do fx:put(x, dy + 2, "─", dr, dg, db) end

  local wx, wy, ww, wh = scene.win_x, scene.win_y, scene.win_w, scene.win_h
  local wr, wg, wb = pal(p, 3, 0.5)
  for x = wx, wx + ww - 1 do
    fx:put(x, wy, "─", wr, wg, wb)
    fx:put(x, wy + wh - 1, "─", wr, wg, wb)
    fx:put(x, wy + math.floor(wh / 2), "─", wr, wg, wb)
  end
  for y = wy, wy + wh - 1 do
    fx:put(wx, y, "│", wr, wg, wb)
    fx:put(wx + math.floor(ww / 2), y, "│", wr, wg, wb)
    fx:put(wx + ww - 1, y, "│", wr, wg, wb)
  end
  fx:put(wx, wy, "┌", wr, wg, wb)
  fx:put(wx + ww - 1, wy, "┐", wr, wg, wb)
  fx:put(wx, wy + wh - 1, "└", wr, wg, wb)
  fx:put(wx + ww - 1, wy + wh - 1, "┘", wr, wg, wb)
  local midy = wy + math.floor(wh / 2)
  local midx = wx + math.floor(ww / 2)
  fx:put(wx, midy, "├", wr, wg, wb)
  fx:put(wx + ww - 1, midy, "┤", wr, wg, wb)
  fx:put(midx, wy, "┬", wr, wg, wb)
  fx:put(midx, wy + wh - 1, "┴", wr, wg, wb)
  fx:put(midx, midy, "┼", wr, wg, wb)

  local ctx_pct = tonumber(state.context_pct) or 0
  local sr, sg, sb = sky_colour(ctx_pct, 0.65)
  local panes = { { wx + 1, wy + 1 }, { midx + 1, wy + 1 }, { wx + 1, midy + 1 }, { midx + 1, midy + 1 } }
  for i, pos in ipairs(panes) do
    fx:put(pos[1], pos[2], "░", sr, sg, sb)
  end
  if ctx_pct > 72 then
    fx:put(midx + 1, wy + 1, "☾", sky_colour(ctx_pct, 1.2))
  end

  if mode == "tool" then
    local burst = mod.burst or 0
    for i = 1, 3 do
      local hh = sbg.hash("rain" .. i .. math.floor(T * 4))
      local rx = wx - 1 - (hh % 3)
      local ry = wy + (hh % wh)
      if rx >= 0 then
        fx:put(rx, ry, (i % 2 == 0) and "┆" or "╲", sbg.scale(sr, sg, sb, 0.5 + 0.4 * burst))
      end
    end
  end

  local shr, shg, shb = pal(p, 4, 0.4)
  local shown_shelves = #scene.shelf_rows
  local book_col_dim = 1.0 - 0.5 * COMPACT
  local drawn_books = math.floor(scene.books_total * (1.0 - COMPACT * 0.7) + 0.5)
  for i, ry in ipairs(scene.shelf_rows) do
    for x = scene.shelf_x0, scene.shelf_x0 + scene.shelf_w - 1 do
      fx:put(x, ry, "═", shr, shg, shb)
    end
  end
  local per_shelf = math.max(1, scene.shelf_w)
  for b = 1, drawn_books do
    local shelf_i = 1 + math.floor((b - 1) / per_shelf)
    if shelf_i > #scene.shelf_rows then break end
    local col_i = ((b - 1) % per_shelf) + 1
    local ry = scene.shelf_rows[shelf_i]
    local ext = scene.exts[((b - 1) % #scene.exts) + 1]
    local ecol = { ext_colour(ext, 0.4) }
    local fade = (b > drawn_books - 4) and (0.5 + 0.5 * (drawn_books - b) / 4.0) or 1.0
    local glyph = BOOK_GLYPHS[(b % #BOOK_GLYPHS) + 1]
    if COMPACT > 0.5 then glyph = "█" end
    fx:put(scene.shelf_x0 + col_i - 1, ry - 1, glyph,
      sbg.scale(ecol[1], ecol[2], ecol[3], fade * book_col_dim))
  end

  for i = 1, scene.plant_stems do
    local px = scene.plant_x0 + (i - 1) * 2
    local height = sbg.clamp(math.floor(scene.added / 150) - (i - 1) * 2, 1, math.max(1, math.floor(H / 3)))
    local pr, pg, pb = pal(p, 2, 0.5)
    for hgt = 1, height do
      local py = scene.surface_y - hgt
      if py >= 0 then fx:put(px, py, "│", pr, pg, pb) end
    end
    local topy = scene.surface_y - height - 1
    if topy >= 0 then fx:put(px, topy, "♣", pal(p, 2, 0.55)) end
  end

  do
    local mr, mg, mb = pal(p, 5, 0.5)
    fx:put(scene.desk_x + 1, scene.surface_y, "☕", mr, mg, mb)
  end

  local lamp_x = scene.desk_x + scene.desk_w - 2
  local lamp_bright = 0.5
  local halo_r = 1
  if mode == "thinking" then
    halo_r = 2 + math.floor(1.5 * (0.5 + 0.5 * math.sin(T * 1.3)))
  end
  if err then
    lamp_bright = 0.35 + 0.35 * (0.5 + 0.5 * math.sin(T * 14.0))
  elseif mode == "idle" and age > 30 then
    lamp_bright = 0.3 + 0.2 * blink
  end
  fx:put(lamp_x, scene.surface_y, "┬", pal(p, 5, lamp_bright + 0.2))
  for r = 1, halo_r do
    local n = r * 3
    for k = 0, n - 1 do
      local ang = (k / n) * 6.28318
      local hx = math.floor(lamp_x + math.cos(ang) * r + 0.5)
      local hy = math.floor(scene.surface_y - 1 - math.sin(ang) * r * 0.5 + 0.5)
      if hx >= 0 and hx < W and hy >= 0 and hy < scene.surface_y then
        fx:put(hx, hy, "·", pal(p, 5, lamp_bright * (1.0 - (r - 1) * 0.3)))
      end
    end
  end

  local chibi_x = scene.desk_x + math.floor(scene.desk_w / 2)
  local typing = (mode == "tool")
  local frame_a = math.floor(T * 6) % 2 == 0
  local ccr, ccg, ccb = pal(p, 1, 0.55)
  if typing then
    sbg.text(fx, chibi_x - 1, scene.surface_y - 2, frame_a and "o/" or "\\o", ccr, ccg, ccb)
  else
    fx:put(chibi_x, scene.surface_y - 2, "o", ccr, ccg, ccb)
  end
  if mode == "waiting" then
    sbg.text(fx, chibi_x - 1, scene.surface_y - 3, "._.", pal(p, 4, 0.5))
    fx:put(chibi_x + 2, scene.surface_y - 3, "?", pal(p, 4, 0.55))
  end
  sbg.text(fx, chibi_x - 1, scene.surface_y - 1, "_|_", ccr, ccg, ccb)

  local spin_on = (mode == "thinking") or (mode == "tool")
  if spin_on then
    local sp = SPIN[(math.floor(T * 8) % #SPIN) + 1]
    fx:put(scene.desk_x + 3, scene.surface_y - 1, sp, pal(p, 4, 0.55))
  end
  sbg.text(fx, scene.desk_x + 2, scene.surface_y, "(o)", pal(p, 3, 0.5))

  for i = 1, scene.notes do
    local h = sbg.hash("note" .. i .. SEED)
    local nx = scene.shelf_x0 + (h % math.max(1, scene.shelf_w))
    local ny = 1 + (math.floor(h / 53) % math.max(1, scene.desk_y - 3))
    fx:put(nx, ny, "▪", pal(p, 5, 0.42))
  end

  for i = 1, scene.papers do
    local h = sbg.hash("paper" .. i .. SEED)
    local px = scene.desk_x + scene.desk_w + 1 + (h % 3)
    fx:put(px, H - 1, "x", sbg.hsl(0.02, 0.5, 0.30))
  end

  if scene.cat then
    local cat_x = math.min(W - 6, scene.desk_x + scene.desk_w + 2)
    local cat_y = H - 1
    local sleepy = (mode == "idle") and age > 60
    sbg.text(fx, cat_x, cat_y, "=^.^=", pal(p, 2, 0.5))
    if sleepy then
      fx:put(cat_x + 5, cat_y - 1, "z", pal(p, 4, 0.4))
    end
  end
end

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
