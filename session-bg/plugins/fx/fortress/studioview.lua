local Studioview = {}
Studioview.TIERS = {
  {name = "Garage", points = 0, staff = 2, floors = {"garage", "loft"}},
  {name = "Startup", points = 45, staff = 4, floors = {"lobby", "dev", "lab", "boss"}},
  {name = "Studio", points = 135, staff = 6, floors = {"lobby", "dev", "library", "servers", "design", "boss"}},
  {name = "HQ", points = 315, staff = 8, floors = {"lobby", "dev", "hotdesk", "library", "servers", "qa", "design", "boss"}},
  {name = "Tower", points = 675, staff = 10, floors = {"lobby", "dev", "hotdesk", "library", "servers", "qa", "design", "boss"}, terrace = true},
}
Studioview.MERGES = {
  {"hotdesk", "dev"}, {"qa", "servers"}, {"library", "servers"}, {"design", "boss"}, {"lab", "dev"},
  {"servers", "dev"}, {"library", "dev"}, {"loft", "garage"}, {"lobby", "dev"}, {"boss", "dev"},
}
Studioview.ROOMS = {
  garage = {"desk", "board", "rack"},
  loft = {"you", "shelf", "couch", "coffee"},
  lobby = {"reception", "coffee", "couch", "plant"},
  dev = {"desk", "board", "desk", "desk"},
  lab = {"rack", "shelf", "desk"},
  library = {"shelf", "desk", "shelf"},
  servers = {"rack", "desk", "rack"},
  design = {"board", "desk", "plant"},
  boss = {"you", "desk", "window"},
  hotdesk = {"hotdesk", "hotdesk"},
  qa = {"desk", "rack"},
}
local STATIONS = {
  desk = {w = 2, spot = 0, cells = {{1, 2, "monitor", "screen"}, {1, 3, "keyboard", "furniture"}}},
  reception = {w = 2, spot = 0, cells = {{1, 2, "monitor", "screen"}, {1, 3, "keyboard", "furniture"}}},
  hotdesk = {w = 2, spot = 0, cells = {{1, 2, "monitor", "screen"}, {1, 3, "keyboard", "furniture"}}},
  board = {w = 2, spot = 1, cells = {{0, 1, "board", "board"}, {0, 2, "board", "board"}}},
  rack = {w = 2, spot = 1, cells = {{0, 2, "rack", "metal"}, {0, 3, "rack", "metal"}}},
  shelf = {w = 2, spot = 1, cells = {{0, 2, "shelf", "furniture"}, {0, 3, "shelf", "furniture"}}},
  coffee = {w = 2, spot = 1, cells = {{0, 3, "coffee", "metal"}}},
  couch = {w = 2, spot = 0, cells = {{1, 3, "couch", "fabric"}}},
  plant = {w = 1, cells = {{0, 3, "plant", "leaf"}}, decor = true},
  window = {w = 1, spot = 0, cells = {{0, 1, "window_day", "sky"}}, decor = true},
  you = {w = 2, spot = 0, cells = {{1, 2, "door", "door"}, {1, 3, "door", "door"}}},
}
Studioview.STATIONS = STATIONS
Studioview.colours = {
  frame = {0.50, 0.60, 0.70}, slab = {0.34, 0.42, 0.47}, shaft = {0.44, 0.50, 0.56},
  screen = {0.48, 0.66, 0.78}, furniture = {0.66, 0.54, 0.40}, board = {0.70, 0.74, 0.78},
  metal = {0.55, 0.62, 0.68}, fabric = {0.62, 0.50, 0.70}, leaf = {0.42, 0.76, 0.52},
  sky = {0.92, 0.82, 0.52}, door = {0.94, 0.72, 0.40}, label = {0.40, 0.48, 0.52},
  text = {0.80, 0.82, 0.84}, dim = {0.52, 0.57, 0.60}, amber = {0.96, 0.72, 0.30}, green = {0.50, 0.84, 0.56},
  red = {0.94, 0.42, 0.38}, violet = {0.72, 0.60, 0.92}, neon = {0.98, 0.52, 0.70},
}
local FLOOR_H = 4
local STATIC_SHARE = 0.7
local GLOWS = {rack = {dx = 0, row = 1, key = "led", colour = "green"}, coffee = {dx = 0, row = 2, key = "steam", colour = "dim"}}

function Studioview.points(counts)
  counts = counts or {}
  return math.max(0, math.floor(tonumber(counts.tools) or 0)) + math.max(0, math.floor(tonumber(counts.prompts) or 0))
end
function Studioview.tier(points)
  local tier = 1
  for i, t in ipairs(Studioview.TIERS) do if points >= t.points then tier = i end end
  return tier
end
function Studioview.budget(w, h, params)
  params = params or {}
  local density = math.max(0.1, math.min(3, tonumber(params.density) or 1))
  local share = params.presentation == "compact" and 0.15 or 0.22
  return math.floor(w * h * math.min(0.25, share * density))
end
function Studioview.program(tier, fit)
  local floors = {}
  for _, name in ipairs(Studioview.TIERS[tier].floors) do floors[#floors + 1] = {name = name, rooms = {name}} end
  local function find(name)
    for i, f in ipairs(floors) do for _, room in ipairs(f.rooms) do if room == name then return i end end end
  end
  for _, merge in ipairs(Studioview.MERGES) do
    if #floors <= fit then break end
    local from, into = find(merge[1]), find(merge[2])
    if from and into and from ~= into and floors[from].name == merge[1] then
      for _, room in ipairs(floors[from].rooms) do table.insert(floors[into].rooms, room) end
      table.remove(floors, from)
    end
  end
  return floors
end

local function station_order(rooms)
  local order, depth = {}, 0
  for _, room in ipairs(rooms) do depth = math.max(depth, #Studioview.ROOMS[room]) end
  for rank = 1, depth do
    for _, room in ipairs(rooms) do
      local kind = Studioview.ROOMS[room][rank]
      if kind then order[#order + 1] = {kind = kind, room = room, rank = rank} end
    end
  end
  return order
end

local MAX_GAP = 5
local function place(order, left, right)
  local chosen, you, need = {}, nil, 0
  for _, s in ipairs(order) do
    local spec = STATIONS[s.kind]
    local extra = spec.w + ((#chosen > 0 or you) and 1 or 0)
    if need + extra <= right - left + 1 and (s.kind ~= "you" or not you) then
      need = need + extra
      if s.kind == "you" then you = s else chosen[#chosen + 1] = s end
    end
  end
  local placed = {}
  if you then
    local x = right - STATIONS.you.w + 1
    placed[#placed + 1] = {s = you, x = x}
    right = x - 2
  end
  local widths = 0
  for _, s in ipairs(chosen) do widths = widths + STATIONS[s.kind].w end
  local gap = #chosen > 0 and math.max(1, math.min(MAX_GAP, math.floor((right - left + 1 - widths) / #chosen))) or 1
  local x = left
  for _, s in ipairs(chosen) do
    placed[#placed + 1] = {s = s, x = x}
    x = x + STATIONS[s.kind].w + gap
  end
  return placed
end

local function frame_geometry(w, h, params)
  local strip = math.floor(w * 0.18)
  local compact = (params or {}).presentation == "compact"
  local tw = compact and (strip - 2) or math.max(22, math.min(52, math.floor(w * 0.30)))
  local x1 = w - 3
  local head = h >= 12 and 3 or 1
  local foot = h >= 12 and 3 or 1
  return {strip = strip, compact = compact, tw = tw, x1 = x1, x0 = x1 - tw + 1, head = head, foot = foot,
    top = head, bottom = h - foot}
end

local function build(g, tier, fit, vocabulary)
  local floors = Studioview.program(tier, fit)
  local out = {form = "tower", floors = {}, stations = {}, static = {}, lights = {}, lit = {}, tier = tier}
  local ground = g.bottom - 1
  local roof = ground - FLOOR_H * #floors
  out.ground, out.roof, out.sign_y = ground, roof, roof - 1
  out.shaft_x, out.door_x = g.x0 + 1, g.x0 + 2
  local taken = {}
  local function add(x, y, key, colour, class)
    local key_y = y * 65536 + x
    if taken[key_y] or x < g.x0 or x > g.x1 then return end
    taken[key_y] = true
    out.static[#out.static + 1] = {x = x, y = y, ch = vocabulary[key] or key, colour = Studioview.colours[colour], class = class}
  end
  local shaft = tier == 1 and "ladder" or "rail"
  local glows = {}
  for i, f in ipairs(floors) do
    local slab = ground - FLOOR_H * (i - 1)
    local floor = {index = i, name = f.name, rooms = f.rooms, r1 = slab - 3, r2 = slab - 2, r3 = slab - 1, slab = slab, stations = {}}
    out.floors[i] = floor
    local placed = place(station_order(f.rooms), g.x0 + 4, g.x1 - 1)
    for _, p in ipairs(placed) do
      local spec = STATIONS[p.s.kind]
      local class = spec.decor and 4 or (p.s.rank == 1 and 2 or 3)
      local rows = {floor.r1, floor.r2, floor.r3}
      for _, c in ipairs(spec.cells) do add(p.x + c[1], rows[c[2]], c[3], c[4], class) end
      if spec.spot then
        local station = {id = f.name .. ":" .. p.s.room .. ":" .. p.s.kind .. ":" .. #out.stations + 1, kind = p.s.kind,
          room = p.s.room, floor = i, x = p.x + spec.spot, y = floor.r3, anchor = p.x, rank = p.s.rank}
        out.stations[#out.stations + 1] = station
        floor.stations[#floor.stations + 1] = station
        for _, c in ipairs(spec.cells) do
          if c[2] == 2 and not out.lit[station.id] then out.lit[station.id] = {x = p.x + c[1], y = floor.r2, key = c[3]} end
        end
      end
      local glow = GLOWS[p.s.kind]
      if glow then
        glows[#glows + 1] = {x = p.x + glow.dx, y = rows[glow.row], key = glow.key, colour = Studioview.colours[glow.colour], class = class}
      end
    end
    local label = f.name
    local lx = g.x1 - #label
    for k = 1, #label do add(lx + k - 1, floor.r1, label:sub(k, k), "label", 4) end
    for _, y in ipairs({floor.r1, floor.r2, floor.r3}) do
      add(g.x0, y, "wall", "frame", 1)
      add(g.x0 + 1, y, shaft, "shaft", 1)
      if y ~= floor.r3 then add(g.x0 + 2, y, "mast", "frame", 1) end
      add(g.x1, y, "wall", "frame", 1)
    end
    if i == 1 then
      add(g.x0, slab, "corner_bl", "frame", 1)
      for x = g.x0 + 1, g.x1 - 1 do add(x, slab, "roof", "frame", 1) end
      add(g.x1, slab, "corner_br", "frame", 1)
    else
      add(g.x0, slab, "joint_l", "frame", 1)
      add(g.x0 + 1, slab, shaft, "shaft", 1)
      for x = g.x0 + 2, g.x1 - 1 do add(x, slab, "slab", "slab", 1) end
      add(g.x1, slab, "joint_r", "frame", 1)
    end
  end
  add(g.x0, roof, "corner_tl", "frame", 1)
  for x = g.x0 + 1, g.x1 - 1 do add(x, roof, "roof", "frame", 1) end
  add(g.x1, roof, "corner_tr", "frame", 1)
  if Studioview.TIERS[tier].terrace then
    add(g.x0 + 1, out.sign_y, "tree", "leaf", 4)
    add(g.x1 - 1, out.sign_y, "umbrella", "door", 4)
    if out.sign_y - 1 >= g.top then out.antenna = {x = g.x0 + math.floor(g.tw / 2), y = out.sign_y - 1} end
  end
  for _, light in ipairs(glows) do
    if not taken[light.y * 65536 + light.x] then out.lights[#out.lights + 1] = light end
  end
  return out
end

local function shed(out, limit)
  if #out.static <= limit then return out end
  for class = 4, 3, -1 do
    local kept, lights = {}, {}
    for _, c in ipairs(out.static) do if c.class < class then kept[#kept + 1] = c end end
    for _, light in ipairs(out.lights) do if light.class < class then lights[#lights + 1] = light end end
    out.static, out.lights = kept, lights
    if #out.static <= limit then return out end
  end
  return nil
end

local function strip_form(g, tier, h, vocabulary)
  local y = g.bottom - 1
  if y < 1 or y > h - 2 or g.x1 < 1 then return {form = "none", floors = {}, stations = {}, static = {}, lights = {}, lit = {}, tier = tier} end
  local names = {}
  for _, name in ipairs(Studioview.TIERS[tier].floors) do names[#names + 1] = name end
  local width = g.x1 + 1 - math.max(0, g.x0)
  return {form = "strip", y = y, x1 = g.x1, width = math.max(0, width), names = names, floors = {}, stations = {}, static = {},
    lights = {}, lit = {}, tier = tier, left = vocabulary.strip_l, right = vocabulary.strip_r, sep = vocabulary.strip_sep}
end

function Studioview.layout(w, h, tier, params)
  params = params or {}
  local vocabulary = Glyphs.vocabulary(params.glyphs)
  local g = frame_geometry(w, h, params)
  local budget = Studioview.budget(w, h, params)
  local fit = math.floor((g.bottom - g.top - 2) / FLOOR_H)
  local out
  if g.tw >= 14 and g.x0 > g.strip and fit >= 1 then
    for n = math.min(fit, #Studioview.TIERS[tier].floors), 1, -1 do
      out = shed(build(g, tier, n, vocabulary), math.floor(budget * STATIC_SHARE))
      if out then break end
    end
  end
  out = out or strip_form(g, tier, h, vocabulary)
  for k, v in pairs(g) do if out[k] == nil then out[k] = v end end
  out.w, out.h, out.budget, out.glyphs, out.vocabulary = w, h, budget, params.glyphs or "unicode", vocabulary
  out.edge_only, out.fit = g.compact, fit
  return out
end

Studioview.VERBS = {edit = "Editing", read = "Reading", exec = "Running", web = "Browsing", mcp = "Calling", task = "Delegating", other = "Working"}
Studioview.EFFORT = {low = 1, medium = 2, high = 3, xhigh = 4, max = 4}
Studioview.TICKER = {
  embark = "Doors open", resume = "Back at work", prompt = "New brief", success = "Task shipped", tool_failed = "Bug found",
  wait_open = "Needs sign-off", wait_resolved = "Signed off", subagent_start = "Contractor in", subagent_stop = "Contractor out",
  compact = "Archived", idle = "Coffee break",
}
local TOAST_COLOURS = {amber = "amber", green = "green", red = "red", violet = "violet"}
local SPARK_TICKS = 60

local function field(value)
  if type(value) ~= "string" then return nil end
  local clean = Glyphs.clean(value)
  return clean ~= "" and clean or nil
end
local function whole(value) return math.max(0, math.floor(tonumber(value) or 0)) end
local function pips(vocabulary, filled, total)
  return string.rep(vocabulary.full, filled) .. string.rep(vocabulary.empty, total - filled)
end
local function fit(candidates, width)
  for _, candidate in ipairs(candidates) do if Glyphs.len(candidate) <= width then return candidate end end
end
local function short(n)
  if n >= 10000 then return string.format("%dk", n // 1000) end
  if n >= 1000 then return string.format("%.1fk", n / 1000) end
  return tostring(n)
end

local function event_kind(event)
  if type(event) ~= "table" then return nil end
  return event.kind or (event.k == "wait" and "wait_open") or event.k
end
function Studioview.permission_open(recent)
  if type(recent) ~= "table" then return false end
  for i = #recent, 1, -1 do
    local kind = event_kind(recent[i])
    if kind == "wait_resolved" then return false end
    if kind == "wait_open" then return true end
  end
  return false
end

function Studioview.status(state, vocabulary)
  local mode = type(state.mode) == "string" and state.mode or "idle"
  if mode == "tool" then return Studioview.VERBS[state.tool_kind] or "Working", "green", false end
  if mode == "thinking" then return "Thinking " .. vocabulary.thinking, "violet", false end
  if mode == "waiting" then
    if Studioview.permission_open((state.journey or {}).recent) then return "Approve?", "amber", true end
    return "Your move", "amber", false
  end
  if mode == "error" then return "Bug " .. vocabulary.bug, "red", false end
  if mode == "compacting" then return "Filing", "violet", false end
  if mode == "start" then return "Opening", "text", false end
  if mode == "end" then return "Closed", "dim", false end
  return (tonumber(state.age) or 0) > 60 and "Break" or "Idle", "dim", false
end

function Studioview.sparkline(recent, n, vocabulary)
  if type(recent) ~= "table" or n < 1 then return nil end
  local newest
  for _, event in ipairs(recent) do
    local tick = type(event) == "table" and (tonumber(event.tick) or (tonumber(event.t) and tonumber(event.t) * 4))
    if tick and (not newest or tick > newest) then newest = tick end
  end
  if not newest then return nil end
  local buckets, peak = {}, 0
  for i = 1, n do buckets[i] = 0 end
  for _, event in ipairs(recent) do
    local tick = tonumber(event.tick) or (tonumber(event.t) and tonumber(event.t) * 4)
    if tick and event_kind(event) == "tool" then
      local slot = n - math.floor((newest - tick) / SPARK_TICKS)
      if slot >= 1 then
        buckets[slot] = buckets[slot] + 1
        peak = math.max(peak, buckets[slot])
      end
    end
  end
  if peak == 0 then return nil end
  local out = {}
  for i = 1, n do
    out[i] = buckets[i] == 0 and " " or vocabulary.spark[math.max(1, math.ceil(buckets[i] * 8 / peak))]
  end
  return table.concat(out)
end

function Studioview.hud(state, layout, extras)
  extras = extras or {}
  local vocabulary, w, h, strip = layout.vocabulary, layout.w, layout.h, layout.strip
  local j = type(state.journey) == "table" and state.journey or {}
  local left, right = strip, strip - 2
  local items = {}
  local function add(id, side, y, text, colour, bright)
    local width = side == "left" and left or right
    if not text or width < 1 then return end
    text = Glyphs.clip(text, width, vocabulary.ellipsis)
    local cells = Glyphs.len(text)
    if cells == 0 then return end
    local x = side == "left" and 0 or (w - 3 - cells + 1)
    items[#items + 1] = {id = id, x = x, y = y, text = text, width = width, colour = Studioview.colours[colour], bright = bright or 1}
  end

  local repo, branch = field(j.repo), field(state.branch)
  local title = field(state.session_name) or field(j.session_name) or repo or "Session"
  add("title", "left", 0, title, extras.title_hot and "amber" or "text")

  local label, colour, blink = Studioview.status(state, vocabulary)
  local mode = state.mode
  if extras.toast and mode ~= "waiting" and mode ~= "error" then
    label, colour = extras.toast:gsub("^[*!] ", ""), TOAST_COLOURS[extras.toast_colour] or "text"
  end
  local lamp = (blink and not extras.quiet and math.floor((extras.t or 0) * 2) % 2 == 1) and " " or vocabulary.lamp
  local lamp_row = lamp .. " " .. label

  local level = Studioview.EFFORT[state.effort]
  local model = field(state.model)
  local effort
  if level then
    local meter = pips(vocabulary, level, 4)
    effort = fit(model and {model .. " " .. meter, meter} or {meter}, right)
  else
    effort = model
  end

  local pct = tonumber(state.context_pct) or 0
  local context, context_colour, clock
  if pct > 0 then
    pct = math.min(100, pct)
    local percent = string.format("%d%%", math.floor(pct))
    local meter = pips(vocabulary, math.floor(pct * 4 / 100 + 0.5), 4)
    context = fit({"ctx " .. meter .. " " .. percent, meter .. " " .. percent, percent}, right)
    context_colour = pct >= 90 and "red" or (pct >= 60 and "amber" or "green")
    local minutes = 540 + math.floor(pct * 7.2)
    local time = string.format("%02d:%02d", minutes // 60, minutes % 60)
    local day = whole(j.compactions) + 1
    clock = fit({string.format("Day %d %s %s", day, vocabulary.dot, time), string.format("D%d %s", day, time), time}, right)
  end

  local kinds = type(j.tool_kinds) == "table" and j.tool_kinds or {}
  local tallies = {}
  for _, entry in ipairs({
    {vocabulary.prompt, whole(j.prompts)}, {vocabulary.edit, whole(kinds.edit) + whole(kinds.other)}, {vocabulary.read, whole(kinds.read)},
    {vocabulary.exec, whole(kinds.exec)}, {vocabulary.web, whole(kinds.web) + whole(kinds.mcp)}, {vocabulary.bug, whole(j.errors)},
  }) do
    if entry[2] > 0 then
      local piece = entry[1] .. short(entry[2])
      local line = #tallies > 0 and table.concat(tallies, " ") .. " " .. piece or piece
      if Glyphs.len(line) <= left then tallies[#tallies + 1] = piece end
    end
  end

  local points = Studioview.points(j)
  local tier = Studioview.tier(points)
  local info = Studioview.TIERS[tier]
  local next_tier = Studioview.TIERS[tier + 1]
  local filled = next_tier and math.floor(5 * (points - info.points) / (next_tier.points - info.points)) or 5
  local tier_text = fit({string.format("T%d %s %s", tier, info.name, pips(vocabulary, filled, 5)), string.format("T%d %s", tier, info.name), "T" .. tier}, right)

  local last = type(j.recent) == "table" and j.recent[#j.recent]
  local ticker = Studioview.TICKER[event_kind(last)]

  local head, foot = layout.head, layout.foot
  add("status", "right", 0, lamp_row, colour)
  if head >= 3 then
    if repo and branch and Glyphs.len(vocabulary.repo .. " " .. repo .. " " .. vocabulary.branch .. " " .. branch) <= left then
      add("location", "left", 1, vocabulary.repo .. " " .. repo .. " " .. vocabulary.branch .. " " .. branch, "dim")
    else
      add("location", "left", 1, repo and (vocabulary.repo .. " " .. repo), "dim")
      add("branch", "left", repo and 2 or 1, branch and (vocabulary.branch .. " " .. branch), "dim")
    end
    add("effort", "right", 1, effort, "text")
    add("context", "right", 2, context, context_colour, extras.meter_bright)
  end
  if h - foot < head then return items end
  if foot >= 3 then
    add("tallies", "left", h - 3, #tallies > 0 and table.concat(tallies, " ") or nil, "text")
    add("spark", "left", h - 2, Studioview.sparkline(j.recent, math.min(left, 16), vocabulary), "green")
    add("tier", "right", h - 3, tier_text, "amber")
    add("clock", "right", h - 2, clock, "dim")
    add("ticker", "right", h - 1, ticker, "dim")
  else
    add("tallies", "left", h - 1, #tallies > 0 and table.concat(tallies, " ") or nil, "text")
    add("tier", "right", h - 1, tier_text, "amber")
  end
  return items
end

function Studioview.sign(state, layout)
  if layout.form ~= "tower" then return nil end
  local j = type(state.journey) == "table" and state.journey or {}
  local name = field(state.session_name) or field(j.session_name) or field(j.repo)
  local room = layout.tw - 8
  if not name or room < 1 then return nil end
  local vocabulary = layout.vocabulary
  local text = vocabulary.sign_l .. " " .. Glyphs.clip(name:upper(), room, vocabulary.ellipsis) .. " " .. vocabulary.sign_r
  local cells = Glyphs.len(text)
  return {x = layout.x0 + 2 + math.floor((layout.tw - 4 - cells) / 2), y = layout.sign_y, text = text, width = cells, colour = Studioview.colours.neon}
end

function Studioview.strip_line(layout)
  if layout.form ~= "strip" then return nil end
  local body = table.concat(layout.names, layout.sep)
  local line = Glyphs.clip(layout.left .. body .. layout.right, layout.width, layout.vocabulary.ellipsis)
  local cells = Glyphs.len(line)
  return {x = layout.x1 - cells + 1, y = layout.y, text = line, width = layout.width, colour = Studioview.colours.label}
end

Studioview.CLASS_COLOURS = {work = "text", errand = "amber", chase = "red", carry = "violet", think = "text", idle = "dim",
  contract = "violet", leave = "violet"}
Studioview.PROP_COLOURS = {edit = "green", read = "screen", exec = "amber", web = "violet", done = "green", lamp = "amber",
  thinking = "text", shelf = "violet", bug = "red"}
Studioview.LIT = 1.3
Studioview.CLOSED = 0.45
Studioview.CLOSING = 4
local HELD = {think = "thinking", errand = "lamp", carry = "shelf"}

local function glowing(light, i, now, quiet)
  if light.key == "led" then return quiet or (now // 2 + i) % 3 ~= 0 end
  return not quiet and (now // 3 + i) % 2 == 0
end
function Studioview.cast(frame, layout, clock)
  if layout.form ~= "tower" or clock.ending then return {} end
  local vocabulary, colours, now, quiet = layout.vocabulary, Studioview.colours, clock.now, clock.quiet
  local items = {}
  local function add(part, x, y, key, colour, bright)
    items[#items + 1] = {part = part, x = x, y = y, ch = vocabulary[key], colour = colours[colour], bright = bright}
  end
  for _, mark in ipairs(frame.marks) do add(mark.kind, mark.x, mark.y, mark.glyph, Studioview.PROP_COLOURS[mark.glyph], Studioview.LIT) end
  local function cast_actor(actor)
    add("actor", actor.x, actor.y, actor.glyph, Studioview.CLASS_COLOURS[actor.class], 1)
    local held = HELD[actor.class]
    if held and (held ~= "lamp" or quiet or now // 2 % 2 == 0) then
      add("prop", actor.x, actor.y - 1, held, Studioview.PROP_COLOURS[held], Studioview.LIT)
    end
    local lit = actor.station and layout.lit[actor.station]
    if lit then add("lit", lit.x, lit.y, lit.key, Studioview.PROP_COLOURS[actor.prop] or Studioview.CLASS_COLOURS[actor.class], Studioview.LIT) end
  end
  for _, actor in ipairs(frame.actors) do if actor.x and actor.class ~= "idle" then cast_actor(actor) end end
  for _, actor in ipairs(frame.actors) do if actor.x and actor.class == "idle" then cast_actor(actor) end end
  if layout.tier >= 2 then
    local bottom = layout.floors[1].r3
    local span = bottom - layout.floors[#layout.floors].r1
    local phase = quiet and 0 or now // 2 % (2 * span)
    add("car", layout.shaft_x, bottom - math.min(phase, 2 * span - phase), "car", "amber", 1)
  end
  for i, light in ipairs(layout.lights) do
    if glowing(light, i, now, quiet) then
      items[#items + 1] = {part = "light", x = light.x, y = light.y, ch = vocabulary[light.key], colour = light.colour, bright = 1}
    end
  end
  return items
end

function Studioview.dark(layout, seconds, quiet)
  if quiet then return #layout.floors end
  return math.min(#layout.floors, math.floor(math.max(0, tonumber(seconds) or 0) * 4 / Studioview.CLOSING))
end

function Studioview.render(put, text, layout, scene)
  local strip = Studioview.strip_line(layout)
  if strip then
    text(strip.x, strip.y, strip.text, strip.width, strip.colour, 2, 1, true)
    return
  end
  local dark_to = layout.roof + FLOOR_H * scene.dark
  local function bright(y) return scene.dark > 0 and y <= dark_to and Studioview.CLOSED or 1 end
  for _, item in ipairs(scene.cast) do put(item.x, item.y, item.ch, item.colour, 1, item.bright, true) end
  local sign = scene.sign
  if sign then text(sign.x, sign.y, sign.text, sign.width, sign.colour, 1, bright(sign.y), true) end
  for _, c in ipairs(layout.static) do put(c.x, c.y, c.ch, c.colour, 2, bright(c.y), true) end
end

return Studioview
