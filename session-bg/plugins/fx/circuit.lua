local M = {}

local W, H = 0, 0
local SEED = 0
local T = 0.0
local SPARK = 0.0
local scene = nil
local sig = ""

local KIND_HUE = {
  exec = 0.10, edit = 0.34, read = 0.55, web = 0.48,
  task = 0.78, mcp = 0.88, other = 0.0,
}
local KIND_ORDER = { "exec", "edit", "read", "web", "task", "mcp", "other" }

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

local function kind_colour(kind, l)
  local h = KIND_HUE[kind or "other"]
  local s = 0.5
  if h == nil then
    h = (sbg.hash(tostring(kind)) % 997) / 997.0
  end
  if kind == "other" or kind == nil then s = 0.06 end
  return sbg.hsl(h, s, l or 0.40)
end

local function kind_for(j, index, total)
  local recent = j.recent
  if type(recent) == "table" then
    local back = total - index
    local e = recent[#recent - back]
    if type(e) == "table" and type(e.tool) == "string" then
      if e.k == "error" then return "exec" end
    end
  end
  local kinds = j.tool_kinds or {}
  local weights, sum = {}, 0
  for i, k in ipairs(KIND_ORDER) do
    local v = jnum(kinds[k])
    weights[i] = v
    sum = sum + v
  end
  if sum <= 0 then return "other" end
  local pick = (sbg.hash("k" .. index) % sum)
  for i, k in ipairs(KIND_ORDER) do
    if pick < weights[i] then return k end
    pick = pick - weights[i]
  end
  return "other"
end

local function spiral_slots(cols, rows, limit)
  local slots = {}
  local cx, cy = math.floor(cols / 2), math.floor(rows / 2)
  local x, y = 0, 0
  local dx, dy = 1, 0
  local steps, run, turns = 1, 0, 0
  local guard = 0
  while #slots < limit and guard < 40000 do
    guard = guard + 1
    local gx, gy = cx + x, cy + y
    if gx >= 0 and gy >= 0 and gx < cols and gy < rows then
      slots[#slots + 1] = { gx, gy }
    end
    x, y = x + dx, y + dy
    run = run + 1
    if run == steps then
      run = 0
      dx, dy = -dy, dx
      turns = turns + 1
      if turns % 2 == 0 then steps = steps + 1 end
    end
    if steps > cols + rows then break end
  end
  return slots
end

local function trace(x0, y0, x1, y1)
  local cells = {}
  local step = x1 > x0 and 1 or -1
  if x0 ~= x1 then
    for x = x0 + step, x1 - step, step do
      cells[#cells + 1] = { x, y0, "─" }
    end
  end
  if y0 ~= y1 then
    local corner = "┐"
    if step > 0 and y1 > y0 then corner = "┐"
    elseif step > 0 and y1 < y0 then corner = "┘"
    elseif step < 0 and y1 > y0 then corner = "┌"
    else corner = "└" end
    cells[#cells + 1] = { x1, y0, corner }
    local vstep = y1 > y0 and 1 or -1
    for y = y0 + vstep, y1 - vstep, vstep do
      cells[#cells + 1] = { x1, y, "│" }
    end
  end
  return cells
end

local function build(state)
  local j = state.journey or {}
  local tools = jnum(j.tools)
  local added = jnum(state.lines_added)
  local gw = 6
  local gh = 3
  local cols = math.max(1, math.floor((W - 2) / gw))
  local rows = math.max(1, math.floor((H - 2) / gh))
  local growth = math.floor(sbg.clamp(12 + added / 10.0, 12, 160))
  local limit = math.min(cols * rows, growth)
  local slots = spiral_slots(cols, rows, limit)
  local total = 1 + math.floor(tools)
  local cap = #slots
  local first = math.max(0, total - cap)
  local nodes = {}
  local traces = {}
  local px, py
  for i = first, total - 1 do
    local s = slots[i - first + 1]
    if s == nil then break end
    local x = 1 + s[1] * gw + math.floor(gw / 2)
    local y = 1 + s[2] * gh + math.floor(gh / 2)
    local age = (total - i) / math.max(1, cap)
    local n = {
      x = x, y = y, i = i,
      kind = kind_for(j, i, total),
      fade = sbg.clamp(1.15 - age * 0.9, 0.22, 1.0),
    }
    nodes[#nodes + 1] = n
    if px ~= nil then
      traces[#traces + 1] = { cells = trace(px, py, x, y), fade = n.fade }
    end
    px, py = x, y
  end
  scene = { nodes = nodes, traces = traces, cols = cols, rows = rows }
end

local function signature(state)
  local j = state.journey or {}
  return table.concat({ jnum(j.tools), jnum(state.lines_added), jstr(j.repo, ""), W, H }, "/")
end

function M.init(ctx)
  W, H = ctx.w, ctx.h
  SEED = ctx.seed or 0
  T, SPARK = 0.0, 0.0
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
    SPARK = math.min(1.0, SPARK + dt * 4.0)
  else
    SPARK = math.max(0.0, SPARK - dt * 1.5)
  end
end

function M.render(fx, state)
  if scene == nil or W == 0 or H == 0 then return end
  local mode = state.mode
  local mod = state.mod or {}
  local density = sbg.clamp((mod.density or 1.0) * (state.params and state.params.density or 1.0), 0.2, 1.6)
  local p = palette(state)
  local ntr = #scene.traces
  local tr0, tg0, tb0 = pal(p, 1, 1.0)

  local br, bg, bb = sky_colour(state.context_pct, 0.30)

  for ti, tr in ipairs(scene.traces) do
    local k = 0.30 + 0.45 * tr.fade
    local r, g, b = sbg.mix(br, bg, bb, tr0, tg0, tb0, 0.65)
    r, g, b = sbg.scale(r, g, b, k)
    for _, c in ipairs(tr.cells) do
      fx:put(c[1], c[2], c[3], r, g, b)
    end
    local live = (mode == "thinking") or (mode == "tool") or (mod.burst or 0) > 0.2
    if live and ti > ntr - 8 and #tr.cells > 0 then
      local speed = (mode == "tool") and 14.0 or 7.0
      local pos = math.floor(sbg.wrap(T * speed + ti * 3.0, #tr.cells)) + 1
      local c = tr.cells[pos]
      if c then
        local pr, pg, pb = pal(p, 4, 1.0)
        fx:put(c[1], c[2], "●", sbg.scale(pr, pg, pb, 0.65))
      end
    end
  end

  for _, n in ipairs(scene.nodes) do
    local r, g, b = kind_colour(n.kind, 0.30 + 0.16 * n.fade)
    local glyph = "▣"
    if n.fade < 0.45 then glyph = "▫"
    elseif n.fade < 0.8 then glyph = "▪" end
    fx:put(n.x, n.y, glyph, r, g, b)
  end

  local last = scene.nodes[#scene.nodes]
  if last then
    local beat = 0.5 + 0.5 * math.sin(T * (mode == "thinking" and 5.0 or 2.0))
    local r, g, b = kind_colour(state.tool_kind or last.kind, 0.34 + 0.22 * beat)
    fx:put(last.x, last.y, "◉", r, g, b)
    if mode == "waiting" then
      local ring = 1 + math.floor(sbg.wrap(T * 2.0, 3.0))
      local rr, rg, rb = sbg.hsl(0.58, 0.25, 0.26)
      fx:put(last.x - ring, last.y, "·", rr, rg, rb)
      fx:put(last.x + ring, last.y, "·", rr, rg, rb)
    end
  end

  if SPARK > 0.05 and last then
    local n = math.floor(14 * SPARK * density)
    for i = 1, n do
      local sr = sbg.rng(SEED + i * 99991 + math.floor(T * 6.0) * 13)
      local a = sr:range(0, 6.28318)
      local rad = sr:range(1.0, 6.0) * SPARK
      local x = math.floor(last.x + math.cos(a) * rad * 2.0)
      local y = math.floor(last.y + math.sin(a) * rad)
      local cr, cg, cb = sbg.hsl(0.12, 0.55, 0.34 + 0.16 * SPARK)
      fx:put(x, y, sr:chance(0.5) and "✦" or "✧", cr, cg, cb)
    end
  end

  if mode == "compacting" then
    local edge = sbg.wrap(T * 18.0, W + 10)
    for y = 0, H - 1, 2 do
      local x = math.floor(edge - (y % 4))
      if x >= 0 and x < W then
        local cr, cg, cb = pal(p, 5, 0.5)
        fx:put(x, y, "│", cr, cg, cb)
      end
    end
  end
end

function init(ctx) M.init(ctx) end
function step(dt, state) M.step(dt, state) end
function render(fx, state) M.render(fx, state) end
