local Studio = {}
Studio.ROLES = {"developer", "researcher", "operator", "liaison", "archivist"}
Studio.KIND_ROLE = {edit = "developer", other = "developer", read = "researcher", exec = "operator", web = "liaison", mcp = "liaison", task = "liaison"}
Studio.FOLD = {operator = "developer", liaison = "researcher", archivist = "researcher"}
Studio.PROP = {edit = "edit", other = "edit", read = "read", exec = "exec", web = "web", mcp = "web", task = "done"}
Studio.IDLE = {"coffee", "couch", "window", "wander"}
Studio.PREFS = {
  developer = {kinds = {"desk", "hotdesk"}, rooms = {"dev", "garage", "hotdesk", "design", "lab", "boss"}},
  researcher = {kinds = {"shelf", "desk"}, rooms = {"library", "lab", "loft", "garage", "dev"}},
  operator = {kinds = {"rack", "desk"}, rooms = {"servers", "qa", "lab", "garage", "dev"}},
  liaison = {kinds = {"reception", "desk", "hotdesk"}, rooms = {"lobby", "hotdesk", "boss", "dev", "garage"}},
  archivist = {kinds = {"shelf", "desk"}, rooms = {"library", "servers", "loft", "lab"}},
  contractor = {kinds = {"hotdesk", "desk"}, rooms = {"hotdesk", "dev", "lobby", "lab", "garage"}},
  think = {kinds = {"board"}, rooms = {"dev", "design", "garage", "lab"}},
  errand = {kinds = {"you"}, rooms = {"boss", "loft"}},
  carry = {kinds = {"shelf"}, rooms = {"library", "servers", "loft", "lab"}},
}
Studio.TURN = {tool = true, thinking = true, waiting = true, error = true}
Studio.GLYPH = {work = "staff", errand = "staff", chase = "staff", carry = "staff", think = "staff", idle = "idle",
  contract = "contractor", leave = "contractor"}
Studio.CONTRACTORS = 3
Studio.BUBBLES = 4
Studio.MIN_BEAT = 12
Studio.SLOT = 80
Studio.BUBBLE = 8
Studio.INCIDENT = 40
Studio.PACE = 2
local FOREVER = math.huge
local BEFORE = -(1 << 40)
local SLOT_MEMO = 16

local function key(x, y) return y * 65536 + x end

function Studio.roster(tier)
  local staff, contractors, count = {}, {}, {}
  for i = 1, Studioview.TIERS[tier].staff do
    local role = Studio.ROLES[(i - 1) % #Studio.ROLES + 1]
    staff[i] = {id = "s" .. i, role = role, staff = true}
    count[role] = (count[role] or 0) + 1
  end
  for k = 1, Studio.CONTRACTORS do contractors[k] = {id = "c" .. k, role = "contractor", slot = k} end
  return staff, contractors, count
end
function Studio.resolve(role, count)
  while not count[role] do role = Studio.FOLD[role] end
  return role
end

local function timeline(recent)
  local events = {}
  if type(recent) ~= "table" then return events end
  for index, e in ipairs(recent) do
    if type(e) == "table" and type(e.kind) == "string" and tonumber(e.seq) and tonumber(e.tick) then
      events[#events + 1] = {seq = math.floor(tonumber(e.seq)), tick = math.max(0, math.floor(tonumber(e.tick))), kind = e.kind,
        payload = type(e.payload) == "table" and e.payload or {}, index = index}
    end
  end
  table.sort(events, function(a, b) return a.seq < b.seq or (a.seq == b.seq and a.index < b.index) end)
  return events
end
local function tool_kind(payload) return Studio.KIND_ROLE[payload.kind] and payload.kind or "other" end

function Studio.story(recent)
  local story = {beats = {}, successes = {}, failures = {}, compacts = {}, waits = {}, crew = {}, last = 0}
  local open = {}
  local function close(index, tick, outcome)
    local beat = table.remove(open, index)
    beat.close, beat.outcome = tick, outcome
    return beat
  end
  for _, e in ipairs(timeline(recent)) do
    story.last = math.max(story.last, e.tick)
    local kind = e.kind
    if kind == "tool" then
      local beat = {seq = e.seq, kind = tool_kind(e.payload), open = e.tick}
      story.beats[#story.beats + 1] = beat
      open[#open + 1] = beat
    elseif kind == "success" then
      local tool, found = tool_kind(e.payload), nil
      for index, beat in ipairs(open) do
        if beat.kind == tool then found = close(index, e.tick, "success"); break end
      end
      story.successes[#story.successes + 1] = {seq = e.seq, tick = e.tick, kind = tool, beat = found and found.seq}
    elseif kind == "tool_failed" then
      local found = open[1] and close(1, e.tick, "failed")
      story.failures[#story.failures + 1] = {seq = e.seq, tick = e.tick, kind = found and found.kind}
    elseif kind == "prompt" or kind == "idle" or kind == "compact" then
      while open[1] do close(1, e.tick, "cut") end
      if kind == "compact" then story.compacts[#story.compacts + 1] = {seq = e.seq, tick = e.tick} end
    elseif kind == "wait_open" or kind == "wait_resolved" then
      story.waits[#story.waits + 1] = {seq = e.seq, tick = e.tick, open = kind == "wait_open"}
    elseif (kind == "subagent_start" or kind == "subagent_stop") and tonumber(e.payload.count) then
      story.crew[#story.crew + 1] = {seq = e.seq, tick = e.tick, start = kind == "subagent_start",
        count = math.max(0, math.floor(tonumber(e.payload.count)))}
    end
  end
  return story
end

local function crew_intervals(story, live)
  local first = story.crew[1]
  local count = first and math.max(0, first.start and first.count - 1 or first.count + 1) or math.floor(tonumber(live.subagents) or 0)
  local since, intervals = {}, {}
  local function set(n, tick, seq)
    n = math.max(0, math.min(Studio.CONTRACTORS, n))
    for k = n + 1, Studio.CONTRACTORS do
      if since[k] then
        intervals[#intervals + 1] = {slot = k, start = since[k].tick, finish = tick, seq = since[k].seq}
        since[k] = nil
      end
    end
    for k = 1, n do if not since[k] then since[k] = {tick = tick, seq = seq} end end
  end
  set(count, BEFORE, nil)
  for _, c in ipairs(story.crew) do set(c.count, c.tick, c.seq) end
  if tonumber(live.subagents) then set(math.floor(tonumber(live.subagents)), story.last, nil) end
  for k = 1, Studio.CONTRACTORS do
    if since[k] then intervals[#intervals + 1] = {slot = k, start = since[k].tick, finish = FOREVER, seq = since[k].seq} end
  end
  return intervals
end

local function rank(station, prefs)
  local kind_rank
  for i, kind in ipairs(prefs.kinds) do if kind == station.kind then kind_rank = i; break end end
  if not kind_rank then return nil end
  local room_rank = #prefs.rooms + 1
  for i, room in ipairs(prefs.rooms) do if room == station.room then room_rank = i; break end end
  return room_rank * 16 + kind_rank
end
local function best_station(layout, prefs, taken)
  local best, best_rank
  for _, station in ipairs(layout.stations) do
    local r = rank(station, prefs)
    if r and not (taken and taken[key(station.x, station.y)]) and (not best_rank or r < best_rank) then best, best_rank = station, r end
  end
  return best
end
local function station_cell(station) return {x = station.x, y = station.y, floor = station.floor, station = station.id} end
local function home_floor(model, prefs_name)
  local floor = model.homes[prefs_name]
  if floor then return floor end
  local station = best_station(model.layout, Studio.PREFS[prefs_name])
  floor = station and station.floor or 1
  model.homes[prefs_name] = floor
  return floor
end
local function wander(model, floor_index, start, taken, lane)
  local floor = model.layout.floors[floor_index]
  for step = 0, model.span - 1 do
    local x = model.left + (start - model.left + step) % model.span
    local k = key(x, floor.r3)
    if (not lane or (x - model.left) % 2 == lane) and not model.blocked[k] and not (taken and taken[k]) then
      return {x = x, y = floor.r3, floor = floor_index}
    end
  end
end

local function distance(layout, from, to)
  if from.y == to.y then return math.abs(from.x - to.x) end
  return math.abs(from.x - layout.shaft_x) + math.abs(from.y - to.y) + math.abs(to.x - layout.shaft_x)
end
local function route(layout, from, to)
  if from.y == to.y then return {from, to} end
  return {from, {x = layout.shaft_x, y = from.y}, {x = layout.shaft_x, y = to.y}, to}
end
local function walk(points, fraction)
  local total = 0
  for i = 2, #points do total = total + math.abs(points[i].x - points[i - 1].x) + math.abs(points[i].y - points[i - 1].y) end
  local remaining = math.max(0, math.min(1, fraction)) * total
  for i = 2, #points do
    local a, b = points[i - 1], points[i]
    local n = math.abs(b.x - a.x) + math.abs(b.y - a.y)
    if remaining <= n and n > 0 then
      return math.floor(a.x + (b.x - a.x) * remaining / n + 0.5), math.floor(a.y + (b.y - a.y) * remaining / n + 0.5)
    end
    remaining = remaining - n
  end
  return points[#points].x, points[#points].y
end
local function floor_of(layout, y)
  for i, floor in ipairs(layout.floors) do if y >= floor.r1 and y <= floor.slab then return i end end
end

local function intents(model)
  local story, live, count = model.story, model.live, model.count
  local list = {}
  local latest = 0
  for _, beat in ipairs(story.beats) do
    local close = beat.close or (Studio.TURN[live.mode] and FOREVER or math.max(story.last, beat.open))
    local finish = math.max(close, beat.open + Studio.MIN_BEAT)
    latest = math.max(latest, finish)
    local natural = Studio.KIND_ROLE[beat.kind]
    list[#list + 1] = {id = "work:" .. beat.seq, class = "work", rank = 1, order = beat.seq, start = beat.open, finish = finish,
      role = Studio.resolve(natural, count), prefs = natural, prop = Studio.PROP[beat.kind], beat = beat.seq}
  end
  local wait = story.waits[#story.waits]
  if wait and wait.open and live.mode == "waiting" then
    list[#list + 1] = {id = "errand:" .. wait.seq, class = "errand", rank = 2, order = wait.seq, start = wait.tick, finish = FOREVER,
      role = Studio.resolve("liaison", count), prefs = "errand", prop = "lamp"}
  end
  local function incidents(events, spec)
    for i, e in ipairs(events) do
      local after = events[i + 1]
      local finish = after and math.min(e.tick + Studio.INCIDENT, after.tick)
        or (live.mode == spec.mode and FOREVER or e.tick + Studio.INCIDENT)
      if finish > e.tick then
        local role = spec.role(e)
        list[#list + 1] = {id = spec.class .. ":" .. e.seq, class = spec.class, rank = spec.rank, order = e.seq, start = e.tick,
          finish = finish, role = Studio.resolve(role, count), prefs = spec.prefs or role, prop = spec.prop}
      end
    end
  end
  incidents(story.failures, {class = "chase", rank = 3, mode = "error", role = function(e) return Studio.KIND_ROLE[e.kind] or "operator" end})
  incidents(story.compacts, {class = "carry", rank = 4, mode = "compacting", role = function() return "archivist" end, prefs = "carry",
    prop = "shelf"})
  if live.mode == "thinking" and latest ~= FOREVER then
    list[#list + 1] = {id = "think", class = "think", rank = 5, order = 0, start = math.max(story.last, latest), finish = FOREVER,
      role = Studio.resolve("developer", count), prefs = "think", prop = "thinking"}
  end
  for _, interval in ipairs(crew_intervals(story, live)) do
    list[#list + 1] = {id = "crew:" .. interval.slot .. ":" .. interval.start, class = "contract", rank = 6, order = interval.slot,
      start = interval.start, finish = interval.finish, slot = interval.slot, prefs = "contractor", beat = interval.seq}
  end
  return list
end

local function before(a, b)
  if a.rank ~= b.rank then return a.rank < b.rank end
  if a.start ~= b.start then return a.start < b.start end
  if a.order ~= b.order then return a.order < b.order end
  return a.id < b.id
end
local function pick(model, intent, active)
  if intent.class == "contract" then return model.contractors[intent.slot] end
  local fallback, displace
  for _, actor in ipairs(model.staff) do
    local busy = active[actor.id]
    if actor.role == intent.role then
      if not busy then return actor end
      if intent.class == "work" and busy.intent.class ~= "work" and not displace then displace = actor end
    elseif not busy and intent.class ~= "work" and not fallback then
      fallback = actor
    end
  end
  return displace or fallback
end
local function place(model, intent, taken)
  if intent.class == "chase" then
    local bug = model.bugs[intent.id]
    if not bug then return nil end
    local marked = {}
    for dx = -1, 1 do
      local k = key(bug.x + dx, bug.y)
      if not taken[k] then taken[k] = true; marked[#marked + 1] = k end
    end
    local cell = wander(model, bug.floor, bug.x + 2, taken, 1)
    for _, k in ipairs(marked) do taken[k] = nil end
    return cell
  end
  local station = best_station(model.layout, Studio.PREFS[intent.prefs], taken)
  if station then return station_cell(station) end
  local start = model.left + Sim.roll(model.seed, intent.order, intent.id, model.span) - 1
  return wander(model, home_floor(model, intent.prefs), start, taken, 1)
end

local function history(model)
  local list = intents(model)
  model.intents = list
  for _, intent in ipairs(list) do
    if intent.class == "chase" then
      local start = model.left + Sim.roll(model.seed, intent.order, "bug", model.span) - 1
      model.bugs[intent.id] = wander(model, home_floor(model, intent.prefs), start, nil, nil)
    end
  end
  local points, marked = {}, {}
  local function mark(t)
    if t == FOREVER or marked[t] then return end
    marked[t] = true
    local i = #points + 1
    while i > 1 and points[i - 1] > t do i = i - 1 end
    table.insert(points, i, t)
  end
  for _, intent in ipairs(list) do mark(intent.start); mark(intent.finish) end
  local active, taken, pending = {}, {}, {}
  local function finish(actor, p)
    local segment = active[actor.id]
    segment.ends = p
    active[actor.id] = nil
    if segment.reserved then taken[segment.reserved] = nil end
    return segment
  end
  local function begin(actor, intent, p, cell)
    if active[actor.id] then finish(actor, p) end
    local reserved = intent.class ~= "leave" and cell and key(cell.x, cell.y) or nil
    local segment = {intent = intent, since = p, ends = intent.finish, cell = cell, reserved = reserved}
    local segments = model.segments[actor.id]
    segments[#segments + 1] = segment
    active[actor.id] = segment
    if segment.reserved then taken[segment.reserved] = true end
    if cell then model.cells[intent.id] = cell end
  end
  local i = 1
  while i <= #points do
    local p = points[i]
    for _, actor in ipairs(model.actors) do
      local segment = active[actor.id]
      if segment and segment.ends <= p then
        finish(actor, p)
        if segment.intent.class == "contract" then
          local from = segment.cell or model.entrance
          local leave = {id = "leave:" .. segment.intent.id, class = "leave", start = p, slot = actor.slot,
            finish = p + Studio.PACE * distance(model.layout, from, model.entrance)}
          begin(actor, leave, p, model.entrance)
          mark(leave.finish)
        end
      end
    end
    for _, intent in ipairs(list) do if intent.start == p then pending[#pending + 1] = intent end end
    local work, other = {}, {}
    for _, intent in ipairs(pending) do
      if intent.finish > p then
        if intent.class == "work" then work[#work + 1] = intent else other[#other + 1] = intent end
      end
    end
    pending = {}
    table.sort(work, before)
    for _, intent in ipairs(work) do
      local actor = pick(model, intent, active)
      if actor then
        if active[actor.id] then other[#other + 1] = finish(actor, p).intent end
        begin(actor, intent, p, place(model, intent, taken))
      else
        pending[#pending + 1] = intent
      end
    end
    table.sort(other, before)
    for _, intent in ipairs(other) do
      local actor = pick(model, intent, active)
      if actor then begin(actor, intent, p, place(model, intent, taken)) else pending[#pending + 1] = intent end
    end
    i = i + 1
  end
end

local function build(scene, live)
  local layout = scene.layout
  local staff, contractors, count = Studio.roster(layout.tier)
  local model = {layout = layout, seed = scene.seed, live = live, quiet = scene.quiet and true or false, story = Studio.story(scene.recent),
    staff = staff, contractors = contractors, count = count, actors = {}, segments = {}, cells = {}, bugs = {}, homes = {}, blocked = {},
    left = layout.x0 + 3, span = math.max(1, layout.x1 - 1 - (layout.x0 + 3) + 1)}
  for _, actor in ipairs(staff) do model.actors[#model.actors + 1] = actor end
  for _, actor in ipairs(contractors) do model.actors[#model.actors + 1] = actor end
  for _, actor in ipairs(model.actors) do model.segments[actor.id] = {} end
  for _, c in ipairs(layout.static) do model.blocked[key(c.x, c.y)] = true end
  for _, s in ipairs(layout.stations) do model.blocked[key(s.x, s.y)] = true end
  model.entrance = {x = layout.door_x, y = layout.floors[1].r3, floor = 1}
  history(model)
  return model
end

local function routine(model, slots, slot)
  local claims = slots.claims[slot]
  if claims then return claims end
  if slots.size >= SLOT_MEMO then slots.claims, slots.size = {}, 0 end
  claims = {}
  local taken = {}
  for _, actor in ipairs(model.staff) do
    local activity = Studio.IDLE[Sim.roll(model.seed, slot, actor.id, #Studio.IDLE)]
    local home = home_floor(model, actor.role)
    local cell
    if activity ~= "wander" then
      local best, gap
      for _, station in ipairs(model.layout.stations) do
        local d = math.abs(station.floor - home)
        if station.kind == activity and not taken[key(station.x, station.y)] and (not gap or d < gap) then best, gap = station, d end
      end
      cell = best and station_cell(best)
    end
    if not cell then
      activity = "wander"
      cell = wander(model, home, model.left + Sim.roll(model.seed, slot, actor.id .. ":x", model.span) - 1, taken, 0)
    end
    if cell then taken[key(cell.x, cell.y)] = true end
    claims[actor.id] = {activity = activity, cell = cell}
  end
  slots.claims[slot], slots.size = claims, slots.size + 1
  return claims
end
local function segment_at(segments, t)
  for i = #segments, 1, -1 do
    local segment = segments[i]
    if segment.since <= t and t < segment.ends then return segment end
  end
end
local function freed(segments, t)
  local last = BEFORE
  for _, segment in ipairs(segments) do if segment.ends <= t and segment.ends > last then last = segment.ends end end
  return last
end
local function slot_of(model, t) return model.quiet and 0 or t // Studio.SLOT end
local function target_at(model, slots, actor, t)
  local segment = segment_at(model.segments[actor.id], t)
  if segment then return segment.cell end
  if actor.staff then return routine(model, slots, slot_of(model, t))[actor.id].cell end
  return model.entrance
end

local function locate(model, slots, actor, now)
  local segments = model.segments[actor.id]
  local segment = segment_at(segments, now)
  local record
  if segment then
    local intent = segment.intent
    if intent.class == "leave" and model.quiet then return nil end
    record = {class = intent.class, beat = intent.beat, since = segment.since, cell = segment.cell, prop = intent.prop}
  elseif actor.staff then
    local slot = slot_of(model, now)
    local claim = routine(model, slots, slot)[actor.id]
    record = {class = "idle", activity = claim.activity, since = math.max(slot * Studio.SLOT, freed(segments, now)), cell = claim.cell,
      prop = claim.activity == "coffee" and "steam" or nil}
  else
    return nil
  end
  record.id, record.role, record.glyph, record.moving = actor.id, actor.role, Studio.GLYPH[record.class], false
  local to = record.cell
  record.cell = nil
  if not to then return record end
  record.x, record.y = to.x, to.y
  local from = target_at(model, slots, actor, record.since - 1)
  if from and not model.quiet then
    local duration = Studio.PACE * distance(model.layout, from, to)
    if now - record.since < duration then
      record.x, record.y = walk(route(model.layout, from, to), (now - record.since) / duration)
      record.moving = true
    end
  end
  record.floor = floor_of(model.layout, record.y)
  record.station = to.station
  return record
end

local function marks(model, now)
  local out = {}
  local right = model.left + model.span - 1
  for _, intent in ipairs(model.intents) do
    local bug = model.bugs[intent.id]
    if bug and intent.start <= now and now < intent.finish then
      local x = model.quiet and bug.x or math.max(model.left, math.min(right, bug.x + (now // 3) % 3 - 1))
      out[#out + 1] = {kind = "bug", glyph = "bug", x = x, y = bug.y, floor = bug.floor, seq = intent.order}
    end
  end
  local shown = 0
  local successes = model.story.successes
  for i = #successes, 1, -1 do
    local s = successes[i]
    if shown < Studio.BUBBLES and s.tick <= now and now < s.tick + Studio.BUBBLE then
      local cell = s.beat and model.cells["work:" .. s.beat]
      if not cell then
        local station = best_station(model.layout, Studio.PREFS[Studio.KIND_ROLE[s.kind]])
        cell = station and station_cell(station)
      end
      if cell then
        local rise = model.quiet and 0 or math.min(1, (now - s.tick) * 2 // Studio.BUBBLE)
        out[#out + 1] = {kind = "bubble", glyph = Studio.PROP[s.kind], x = cell.x, y = cell.y - 1 - rise, floor = cell.floor, seq = s.seq}
        shown = shown + 1
      end
    end
  end
  return out
end

local function signature(scene, live)
  local parts = {tostring(scene.seed), tostring(scene.layout), scene.quiet and "quiet" or "", tostring(live.mode), tostring(live.subagents)}
  if type(scene.recent) == "table" then
    for _, e in ipairs(scene.recent) do
      if type(e) == "table" then
        local payload = type(e.payload) == "table" and e.payload or {}
        parts[#parts + 1] = table.concat({tostring(e.seq), tostring(e.kind), tostring(e.tick), tostring(payload.kind), tostring(payload.count)}, ":")
      end
    end
  end
  return table.concat(parts, "|")
end

function Studio.plan(cache, scene)
  local layout = scene.layout
  local live = type(scene.live) == "table" and scene.live or {}
  if not layout or layout.form ~= "tower" or #layout.floors == 0 or live.mode == "end" then return {actors = {}, marks = {}} end
  cache = cache or {}
  local token = signature(scene, live)
  if cache.token ~= token then
    cache.token, cache.model, cache.slots, cache.at, cache.frame = token, build(scene, live), {claims = {}, size = 0}, nil, nil
  end
  local now = math.floor(tonumber(scene.now) or 0)
  if cache.at == now then return cache.frame end
  local model = cache.model
  local actors = {}
  for _, actor in ipairs(model.actors) do
    local record = locate(model, cache.slots, actor, now)
    if record then actors[#actors + 1] = record end
  end
  cache.at, cache.frame = now, {actors = actors, marks = marks(model, now)}
  return cache.frame
end
return Studio
