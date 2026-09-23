local H = dofile("scripts/world/harness.lua")
local SEED = tonumber(os.getenv("STUDIOVIEW_SEED")) or (os.time() ~ math.floor(os.clock() * 1e9))
math.randomseed(SEED)
Glyphs = dofile("plugins/fx/fortress/glyphs.lua")
local env = H.sandbox()
env.Glyphs = Glyphs
local Studioview = assert(loadfile("plugins/fx/fortress/studioview.lua", "t", env))()
local View = dofile("plugins/fx/fortress/render.lua")
View.studioview = Studioview
local tests = 0
local function check(ok, message, case)
  if not ok then error(string.format("%s (STUDIOVIEW_SEED=%d case=%s)", message, SEED, tostring(case)), 2) end
  tests = tests + 1
end

local function viewport()
  local w, h = math.random(6, 240), math.random(3, 70)
  local params = {
    presentation = math.random(3) == 1 and "compact" or "auto",
    glyphs = math.random(2) == 1 and "ascii" or "unicode",
    density = ({ 0.1, 0.4, 1, 1.7, 3 })[math.random(5)],
  }
  local tier = math.random(#Studioview.TIERS)
  local case = string.format("%dx%d tier=%d %s %s density=%s", w, h, tier, params.presentation, params.glyphs, params.density)
  return w, h, tier, params, case
end
local function in_centre_band(layout, x) return x >= layout.strip and x < layout.w - layout.strip end

for _ = 1, 2500 do
  local w, h, tier, params, case = viewport()
  local layout = Studioview.layout(w, h, tier, params)
  local seen = {}
  for _, c in ipairs(layout.static) do
    check(c.x >= 0 and c.x <= w - 3 and c.y >= 0 and c.y < h, "static cells stay in bounds and off the right margin", case)
    check(not in_centre_band(layout, c.x) or (c.y >= 1 and c.y <= h - 2), "centre-band cells avoid the first and last rows", case)
    check(params.presentation ~= "compact" or c.x >= w - layout.strip, "compact towers stay in the right strip", case)
    check(not seen[c.y * w + c.x], "static cells never overlap", case)
    seen[c.y * w + c.x] = true
    check(utf8.len(c.ch) == 1, "every static glyph is one code point", case)
    check(params.glyphs ~= "ascii" or c.ch:match("^[!-~]$"), "ascii mode emits printable ascii only", case)
  end
  check(#layout.static <= math.floor(Studioview.budget(w, h, params) * 0.7), "static layer stays within 70% of the budget", case)
end

local function home(layout, room)
  local found
  for _, floor in ipairs(layout.floors) do
    for _, name in ipairs(floor.rooms) do
      if name == room then
        if found then return nil end
        found = floor
      end
    end
  end
  return found
end
for _ = 1, 2500 do
  local w, h, tier, params, case = viewport()
  local layout = Studioview.layout(w, h, tier, params)
  if layout.form == "tower" then
    local program = Studioview.TIERS[tier].floors
    check(#layout.floors >= 1 and #layout.floors <= layout.fit, "the tower never exceeds the floors that fit", case)
    for _, room in ipairs(program) do check(home(layout, room) ~= nil, "every program room is on exactly one floor: " .. room, case) end
    check(home(layout, program[1]).slab == layout.ground, "the entry room is on the ground floor", case)
    check(home(layout, program[#program]).r1 == layout.roof + 1, "the owner's room is on the top floor", case)
    local spots = {}
    for _, station in ipairs(layout.stations) do
      local key = station.floor * 65536 + station.x
      check(not spots[key], "stations on one floor never share a spot", case)
      spots[key] = true
      check(station.x > layout.x0 + 2 and station.x < layout.x1, "stations stand inside the rooms", case)
      check(station.y == layout.floors[station.floor].r3, "stations stand on their floor", case)
    end
  end
end

local ORACLE = { 0, 45, 135, 315, 675 }
local function oracle_tier(points)
  local tier = 0
  for i, threshold in ipairs(ORACLE) do if points >= threshold then tier = i end end
  return tier
end
for _ = 1, 2000 do
  local threshold = ORACLE[math.random(#ORACLE)]
  local points = math.max(0, threshold + math.random(-2, 2)) + (math.random(4) == 1 and math.random(0, 2000) or 0)
  check(Studioview.tier(points) == oracle_tier(points), "tiers follow the published thresholds", points)
end
for _ = 1, 2000 do
  local function value()
    return ({ nil, -math.random(1, 50), math.random(0, 900), math.random() * 900, tostring(math.random(0, 900)), "tools" })[math.random(6)]
  end
  local counts = { tools = value(), prompts = value() }
  local function whole(v) return math.max(0, math.floor(tonumber(v) or 0)) end
  check(Studioview.points(counts) == whole(counts.tools) + whole(counts.prompts), "points are whole tools plus prompts",
    tostring(counts.tools) .. "+" .. tostring(counts.prompts))
end

local worked = {
  { 80, 24, "auto", 24, 4 }, { 120, 35, "auto", 36, 6 }, { 200, 60, "auto", 52, 13 }, { 120, 35, "compact", 19, nil },
}
for _, spec in ipairs(worked) do
  local w, h, presentation, width, fit = table.unpack(spec)
  local layout = Studioview.layout(w, h, 5, { presentation = presentation })
  local case = w .. "x" .. h .. " " .. presentation
  check(layout.x1 - layout.x0 + 1 == width and layout.x1 == w - 3, "worked tower width", case)
  check(fit == nil or layout.fit == fit, "worked floor capacity", case)
end
check(Studioview.layout(120, 35, 5, { presentation = "compact" }).x0 == 99, "compact tower starts at column 99 at 120 columns", "120x35")

local MODES = { "tool", "thinking", "waiting", "error", "compacting", "idle", "start", "end", nil, "bogus" }
local KINDS = { "edit", "read", "exec", "web", "mcp", "task", "other", nil, "bogus" }
local LEVELS = { "low", "medium", "high", "xhigh", "max", nil, "", "extreme" }
local EVENTS = { "embark", "resume", "prompt", "tool", "success", "tool_failed", "wait_open", "wait_resolved",
  "subagent_start", "subagent_stop", "compact", "idle" }
local function word(n)
  local out = {}
  for i = 1, n do out[i] = string.char(math.random(97, 122)) end
  return table.concat(out)
end
local function maybe(value) return math.random(3) > 1 and value or nil end
local function history(n, tick)
  local recent = {}
  for i = 1, n do
    tick = tick + math.random(0, 90)
    recent[i] = { seq = i, kind = EVENTS[math.random(#EVENTS)], tick = tick, payload = {} }
  end
  return recent
end
local function hud_state()
  local journey = {
    repo = maybe(word(math.random(1, 30))), session_name = maybe(word(math.random(1, 12))),
    prompts = maybe(math.random(0, 99)), tools = maybe(math.random(0, 900)), errors = maybe(math.random(0, 99)),
    compactions = maybe(math.random(0, 9)),
    tool_kinds = maybe({ edit = maybe(math.random(0, 99)), read = maybe(math.random(0, 99)), exec = maybe(math.random(0, 99)),
      web = maybe(math.random(0, 49)), mcp = maybe(math.random(0, 49)), other = maybe(math.random(0, 49)) }),
    recent = maybe(history(math.random(0, 64), math.random(0, 5000))),
  }
  return {
    session_name = maybe(word(math.random(1, 40))), branch = maybe(word(math.random(1, 30))),
    mode = MODES[math.random(#MODES)], tool_kind = KINDS[math.random(#KINDS)], model = maybe(word(math.random(1, 10))),
    effort = LEVELS[math.random(#LEVELS)], context_pct = maybe(math.random(-5, 120) + math.random()),
    age = math.random(0, 200), journey = journey,
  }
end
local function hud_case(state, case)
  return case .. " mode=" .. tostring(state.mode) .. " effort=" .. tostring(state.effort) .. " pct=" .. tostring(state.context_pct)
end

for _ = 1, 3000 do
  local w, h, tier, params, case = viewport()
  local state = hud_state()
  case = hud_case(state, case)
  local layout = Studioview.layout(w, h, tier, params)
  local items = Studioview.hud(state, layout, { t = math.random() * 100, quiet = math.random(2) == 1 })
  local used = {}
  for _, item in ipairs(items) do
    local cells = Glyphs.len(item.text)
    check(cells >= 1 and cells <= item.width, "hud text fits its slot", case)
    check(item.y < layout.head or item.y >= h - layout.foot, "hud rows stay in the head and foot", case)
    check(item.y < layout.top or item.y >= layout.bottom, "hud rows never meet the tower", case)
    check(item.x >= 0 and item.x + cells - 1 <= w - 3, "hud text stays off the right margin", case)
    check(item.x + cells - 1 < layout.strip or item.x >= w - layout.strip, "hud text stays in the edge strips", case)
    for i = 0, cells - 1 do
      check(not used[item.y * w + item.x + i], "hud items never overlap", case)
      used[item.y * w + item.x + i] = true
    end
    check(params.glyphs ~= "ascii" or item.text:match("^[ -~]+$"), "ascii hud text is printable ascii", case)
  end
end

local function hud_of(state, t)
  local layout = Studioview.layout(200, 60, 5, {})
  local items = {}
  for _, item in ipairs(Studioview.hud(state, layout, { t = t or 0 })) do items[item.id] = item.text end
  return items, layout.vocabulary
end
local function oracle_spark(recent, n)
  local newest
  for _, e in ipairs(recent or {}) do newest = math.max(newest or e.tick, e.tick) end
  local lit = {}
  for _, e in ipairs(recent or {}) do
    local slot = n - (newest - e.tick) // 60
    if e.kind == "tool" and slot >= 1 then lit[slot] = true end
  end
  local count = 0
  for _ in pairs(lit) do count = count + 1 end
  return count
end
local function count(text, glyph)
  local n = 0
  for _, c in ipairs(Glyphs.chars(text or "")) do if c == glyph then n = n + 1 end end
  return n
end
local function contains(text, piece) return text ~= nil and text:find(piece, 1, true) ~= nil end
for _ = 1, 3000 do
  local state = hud_state()
  local j = state.journey
  local hud, v = hud_of(state)
  local case = hud_case(state, "200x60")
  local title = state.session_name or j.session_name or j.repo or "Session"
  check(hud.title == Glyphs.clip(title, 36, v.ellipsis), "the title is the session name", case)
  check(contains(hud.location, j.repo) == (j.repo ~= nil), "the location shows the repo only when known", case)
  local branch_text = (hud.location or "") .. (hud.branch or "")
  check(contains(branch_text, v.branch .. " " .. (state.branch or "")) == (state.branch ~= nil), "the branch shows only when known", case)
  local level = ({ low = 1, medium = 2, high = 3, xhigh = 4, max = 4 })[state.effort]
  check(count(hud.effort, v.full) == (level or 0), "effort pips follow the effort level", case)
  check((hud.effort == nil) == (level == nil and state.model == nil), "the effort row hides only without model and effort", case)
  local pct = tonumber(state.context_pct) or 0
  check((hud.context ~= nil) == (pct > 0) and (hud.clock ~= nil) == (pct > 0), "context and clock hide without context", case)
  if pct > 0 then
    check(contains(hud.context, string.format("%d%%", math.floor(math.min(100, pct)))), "the context meter shows the percentage", case)
    check(contains(hud.clock, "Day " .. ((j.compactions or 0) + 1) .. " "), "the day follows compactions", case)
  end
  local kinds = j.tool_kinds or {}
  local tallies = {
    { v.prompt, j.prompts or 0 }, { v.edit, (kinds.edit or 0) + (kinds.other or 0) }, { v.read, kinds.read or 0 },
    { v.exec, kinds.exec or 0 }, { v.web, (kinds.web or 0) + (kinds.mcp or 0) }, { v.bug, j.errors or 0 },
  }
  for _, t in ipairs(tallies) do
    check(contains(hud.tallies, t[1] .. t[2]) == (t[2] > 0), "tallies show exactly the nonzero counters", case)
  end
  local lit = hud.spark and 16 - count(hud.spark, " ") or 0
  check(lit == oracle_spark(j.recent, 16), "the sparkline lights one cell per busy quarter minute", case)
  check(hud.tier:sub(1, 3) == "T" .. oracle_tier((j.tools or 0) + (j.prompts or 0)) .. " ", "the tier meter follows points", case)
  local last = j.recent and j.recent[#j.recent]
  check(hud.ticker == (last and Studioview.TICKER[last.kind] or nil), "the ticker names the latest event", case)
  local verb = state.mode == "tool" and (Studioview.VERBS[state.tool_kind] or "Working")
  check(not verb or hud.status == v.lamp .. " " .. verb, "the lamp names the tool at work", case)
end

for _ = 1, 1500 do
  local w, h, tier, params, case = viewport()
  local state = hud_state()
  local layout = Studioview.layout(w, h, tier, params)
  local sign = Studioview.sign(state, layout)
  local name = state.session_name or state.journey.session_name or state.journey.repo
  if sign then
    local cells = Glyphs.len(sign.text)
    check(layout.form == "tower" and sign.y == layout.sign_y and sign.y >= 1, "the sign hangs on the roof row", case)
    check(sign.x >= layout.x0 + 2 and sign.x + cells - 1 <= layout.x1 - 2, "the sign stays between the terrace corners", case)
    local shown = Glyphs.chars(sign.text)
    check(shown[3] == name:upper():sub(1, 1), "the sign spells the session name", case)
  else
    check(layout.form ~= "tower" or name == nil or layout.tw - 8 < 1, "a tower with a name always has a sign", case)
  end
end

for _ = 1, 500 do
  local state = hud_state()
  state.mode = "waiting"
  local recent = history(math.random(0, 20), 0)
  local open = math.random(2) == 1
  recent[#recent + 1] = { seq = #recent + 1, kind = open and "wait_open" or "wait_resolved", tick = 9000, payload = {} }
  if math.random(2) == 1 then recent[#recent + 1] = { seq = #recent + 1, kind = "tool", tick = 9001, payload = {} } end
  state.journey.recent = recent
  local lit, v = hud_of(state, 0)
  local dark = hud_of(state, 0.5)
  check(lit.status == v.lamp .. (open and " Approve?" or " Your move"), "waiting names the decision", tostring(open))
  check((dark.status ~= lit.status) == open, "only an open permission blinks the lamp", tostring(open))
end

local function frame(w, h, tier, params, text_api, state)
  local layout = Studioview.layout(w, h, tier, params)
  layout.scene = "studio"
  state = state or hud_state()
  state.params = params
  local fx = H.mkfx(w, h)
  sbg = text_api
  View.render(fx, nil, layout, state, 0, nil, nil, nil)
  sbg = nil
  return layout, fx, state
end
local function expected_cells(layout, state)
  local cells, w = {}, layout.w
  local function spread(item)
    for i, ch in ipairs(Glyphs.chars(item.text)) do
      if ch ~= " " and not cells[item.y * w + item.x + i - 1] then cells[item.y * w + item.x + i - 1] = ch end
    end
  end
  for _, item in ipairs(Studioview.hud(state, layout, { t = 0 })) do spread(item) end
  local sign = Studioview.sign(state, layout)
  if sign then spread(sign) end
  local chrome = 0
  for _ in pairs(cells) do chrome = chrome + 1 end
  local strip = Studioview.strip_line(layout)
  if strip then spread(strip) end
  for _, c in ipairs(layout.static) do if not cells[c.y * w + c.x] then cells[c.y * w + c.x] = c.ch end end
  return cells, chrome
end
for _ = 1, 1500 do
  local w, h, tier, params, case = viewport()
  local layout, fx, state = frame(w, h, tier, params, nil)
  case = hud_case(state, case)
  check(fx:unique() <= math.floor(w * h * 0.25), "the studio frame stays under the hard cap", case)
  local cells, chrome = expected_cells(layout, state)
  for key, cell in pairs(fx.cells) do check(cells[key] == cell.ch, "the frame holds only the hud, the sign and the tower", case) end
  if layout.form == "tower" and chrome + #layout.static <= layout.budget then
    for key, ch in pairs(cells) do check(fx.cells[key] and fx.cells[key].ch == ch, "every hud, sign and tower cell reaches the screen", case) end
  end
  for _, item in ipairs(Studioview.hud(state, layout, { t = 0 })) do
    for i, ch in ipairs(Glyphs.chars(item.text)) do
      local cell = fx.cells[item.y * w + item.x + i - 1]
      check(ch == " " or (cell and cell.ch == ch), "the hud is never shed by the budget", case)
    end
  end
  local strip = Studioview.strip_line(layout)
  if strip then
    local line = layout.left .. table.concat(layout.names, layout.sep) .. layout.right
    local drawn = 0
    for x = 0, w - 1 do if fx.cells[strip.y * w + x] then drawn = drawn + 1 end end
    check(drawn == math.min(layout.width, Glyphs.len(line), math.max(0, layout.budget - chrome)), "the strip form shows its whole clipped status row", case)
  end
  for key, cell in pairs(fx.cells) do
    local x, y = key % w, key // w
    check(x <= w - 3, "nothing is drawn on the right margin", case)
    check(not in_centre_band(layout, x) or (y >= 1 and y <= h - 2), "centre-band cells avoid the first and last rows", case)
    check(params.glyphs ~= "ascii" or cell.ch:match("^[!-~]$"), "ascii mode renders printable ascii only", case)
  end
end

local function same(a, b)
  for key, cell in pairs(a.cells) do
    local other = b.cells[key]
    if not other or other.ch ~= cell.ch or other.r ~= cell.r or other.g ~= cell.g or other.b ~= cell.b then return false end
  end
  return a:unique() == b:unique()
end
for _ = 1, 600 do
  local w, h, tier, params, case = viewport()
  local state = hud_state()
  local _, batched = frame(w, h, tier, params, H.sbg, state)
  local _, single = frame(w, h, tier, params, nil, state)
  check(same(batched, single), "run batching paints exactly the per-cell frame", case)
end

local function studio_state(tools, params, seq)
  local journey = H.journey(tools, {})
  journey.schema_version, journey.seq, journey.tick, journey.recent = 2, seq, seq * 4, {}
  local state = H.mkstate("idle", journey, {})
  for k, v in pairs(params) do state.params[k] = v end
  state.params.scene = "studio"
  return state
end
for _ = 1, 60 do
  local w, h, _, params, case = viewport()
  local bundle = H.sandbox()
  assert(loadfile("plugins/fx/fortress.lua", "t", bundle))()
  bundle.init({ w = w, h = h, seed = math.random(1, 1 << 30), fps = 30, density = 1 })
  local tools = math.random(0, 900)
  local state = studio_state(tools, params, 10)
  state.session_name = word(math.random(1, 20))
  for _ = 1, math.random(1, 40) do bundle.step(1 / 30, state) end
  local fx = H.mkfx(w, h)
  bundle.render(fx, state)
  check(fx.cells[0] and fx.cells[0].ch == state.session_name:sub(1, 1), "the session name starts at row 0, column 0", case)
  check(fx:unique() <= math.floor(w * h * 0.25), "the bundled studio stays under the hard cap", case)
  for _, cell in pairs(fx.cells) do check(cell.ch ~= "?", "the bundled studio never emits a substitution glyph", case) end
  local status = bundle.checkpoint().status
  check(status.scene == "studio", "the export names the studio scene", case)
  local points = tools + state.journey.prompts
  check(status.studio.points == points and status.studio.tier == oracle_tier(points), "the export reports points and tier", case .. " tools=" .. tools)
  local grown = studio_state(tools + 700, params, 20)
  for _ = 1, 3 do bundle.step(1 / 30, grown) end
  check(bundle.checkpoint().status.studio.tier == 5, "the tower is rebuilt when the tier changes", case .. " tools=" .. tools)
end

for _ = 1, 60 do
  local w, h, _, params, case = viewport()
  local bundle = H.sandbox()
  assert(loadfile("plugins/fx/fortress.lua", "t", bundle))()
  bundle.init({ w = w, h = h, seed = math.random(1, 1 << 30), fps = 30, density = 1 })
  local requested = ({ "office", "settlement", "studio", word(math.random(1, 12)) })[math.random(5)]
  local state = studio_state(math.random(0, 900), params, 10)
  state.params.scene = requested
  bundle.step(1 / 30, state)
  local expected = requested == "settlement" and "settlement" or "studio"
  check(bundle.checkpoint().status.scene == expected, "only an explicit settlement leaves the studio", case .. " scene=" .. tostring(requested))
end

print("studioview ok (" .. tests .. " checks, STUDIOVIEW_SEED=" .. SEED .. ")")
