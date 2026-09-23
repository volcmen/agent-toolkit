local H = dofile("scripts/world/harness.lua")
local SEED = tonumber(os.getenv("STUDIO_SEED")) or (os.time() ~ math.floor(os.clock() * 1e9))
math.randomseed(SEED)
Glyphs = dofile("plugins/fx/fortress/glyphs.lua")
local env = H.sandbox()
env.Glyphs = Glyphs
env.Sim = dofile("plugins/fx/fortress/sim.lua")
local Studioview = assert(loadfile("plugins/fx/fortress/studioview.lua", "t", env))()
env.Studioview = Studioview
local Studio = assert(loadfile("plugins/fx/fortress/studio.lua", "t", env))()
local FIXTURE = dofile("tests/fixtures/fortress/three-hour.lua")
local tests = 0
local function check(ok, message, case)
  if not ok then error(string.format("%s (STUDIO_SEED=%d case=%s)", message, SEED, tostring(case)), 2) end
  tests = tests + 1
end

local function copy(v)
  if type(v) ~= "table" then return v end
  local out = {}
  for k, x in pairs(v) do out[k] = copy(x) end
  return out
end
local function with(scene, changes)
  local out = {}
  for k, v in pairs(scene) do out[k] = v end
  for k, v in pairs(changes) do out[k] = v end
  return out
end
local function serialize(v, seen)
  if type(v) ~= "table" then return type(v) .. ":" .. tostring(v) end
  if seen[v] then return seen[v] end
  local names, keys, out = {}, {}, {}
  for i = 1, #v do out[i] = serialize(v[i], seen) end
  for k in pairs(v) do
    if math.type(k) ~= "integer" or k < 1 or k > #v then
      local name = type(k) .. ":" .. tostring(k)
      names[#names + 1], keys[name] = name, k
    end
  end
  table.sort(names)
  for _, name in ipairs(names) do out[#out + 1] = name .. "=" .. serialize(v[keys[name]], seen) end
  seen[v] = "{" .. table.concat(out, ";") .. "}"
  return seen[v]
end
local function canonical(v) return serialize(v, {}) end

local KINDS = { "edit", "read", "exec", "web", "mcp", "task", "other", "bogus" }
local MODES = { "tool", "thinking", "waiting", "error", "compacting", "idle", "start", "end", "bogus" }
local EVENTS = {
  { "tool", 30 }, { "success", 24 }, { "tool_failed", 5 }, { "prompt", 5 }, { "idle", 3 }, { "compact", 3 },
  { "wait_open", 5 }, { "wait_resolved", 4 }, { "subagent_start", 5 }, { "subagent_stop", 4 }, { "embark", 1 }, { "resume", 1 },
}
local function mix()
  local weights, total = {}, 0
  for i, e in ipairs(EVENTS) do
    weights[i] = e[2] * math.random(0, 3)
    total = total + weights[i]
  end
  if total == 0 then weights[1], total = 1, 1 end
  return weights, total
end
local function weighted(weights, total)
  local r = math.random(total)
  for i, e in ipairs(EVENTS) do
    if r <= weights[i] then return e[1] end
    r = r - weights[i]
  end
end
local function random_ring()
  local seq, tick, crew = math.random(1, 5000), math.random(0, 20000), math.random(0, 4)
  local burst = math.random(3) == 1 and math.random(0, 2)
  local weights, total = mix()
  local ring, tools = {}, {}
  for i = 1, math.random(0, 64) do
    local kind = weighted(weights, total)
    tick = tick + (burst and math.random(0, burst) or (math.random(10) == 1 and math.random(0, 600) or math.random(0, 24)))
    local payload = {}
    if kind == "tool" then
      payload = { kind = KINDS[math.random(#KINDS)], ext = "rs" }
      tools[#tools + 1] = payload.kind
    elseif kind == "success" then
      payload = { kind = (#tools > 0 and math.random(4) > 1) and tools[math.random(#tools)] or KINDS[math.random(#KINDS)] }
    elseif kind == "subagent_start" then
      crew = crew + 1
      payload = { count = crew }
    elseif kind == "subagent_stop" then
      crew = math.max(0, crew - 1)
      payload = { count = crew }
    end
    ring[i] = { seq = seq + i, kind = kind, tick = tick, payload = payload }
  end
  return ring
end
local function fixture_ring()
  local events = FIXTURE.events
  local last = math.random(1, #events)
  local ring = {}
  for i = math.max(1, last - 63), last do ring[#ring + 1] = copy(events[i]) end
  return ring
end
local function last_tick(ring)
  local last = 0
  for _, e in ipairs(ring) do last = math.max(last, e.tick) end
  return last
end
local function tower(tier, w, h, density)
  w, h = w or math.random(80, 240), h or math.random(16, 70)
  local params = { glyphs = math.random(2) == 1 and "ascii" or "unicode", density = density or ({ 1, 1.7, 3 })[math.random(3)] }
  local layout = Studioview.layout(w, h, tier, params)
  assert(layout.form == "tower", "the generated viewport holds a tower")
  return layout, string.format("%dx%d tier=%d density=%s", w, h, tier, params.density)
end
local function scenario()
  local ring = math.random(2) == 1 and fixture_ring() or random_ring()
  local tier = math.random(#Studioview.TIERS)
  local layout, where = tower(tier)
  local live = { mode = MODES[math.random(#MODES + 1)], subagents = math.random(3) > 1 and math.random(0, 5) or nil }
  local scene = { seed = math.random(0, 2 ^ 31), layout = layout, recent = ring, live = live,
    now = last_tick(ring) + math.random(0, ({ 12, 60, 300 })[math.random(3)]) + math.random(), quiet = math.random(4) == 1 }
  local case = string.format("%s mode=%s subagents=%s events=%d now=%.2f quiet=%s", where, tostring(live.mode), tostring(live.subagents),
    #ring, scene.now, tostring(scene.quiet))
  return scene, case
end

local ROLE = { edit = "developer", other = "developer", read = "researcher", exec = "operator", web = "liaison", mcp = "liaison", task = "liaison" }
local STAFF = { 2, 4, 6, 8, 10 }
local ORDER = { "developer", "researcher", "operator", "liaison", "archivist" }
local function staffing(tier)
  local cap = {}
  for i = 1, STAFF[tier] do
    local role = ORDER[(i - 1) % 5 + 1]
    cap[role] = (cap[role] or 0) + 1
  end
  local function resolve(role)
    if cap[role] then return role end
    if role == "archivist" or role == "liaison" then return "researcher" end
    return "developer"
  end
  return cap, resolve
end
local function ordered(ring)
  local events = {}
  for _, e in ipairs(ring) do events[#events + 1] = e end
  table.sort(events, function(a, b) return a.seq < b.seq end)
  return events
end
local function oracle(scene)
  local events = ordered(scene.recent)
  local mode = scene.live.mode
  local turn = mode == "tool" or mode == "thinking" or mode == "waiting" or mode == "error"
  local last = last_tick(scene.recent)
  local beats, open = {}, {}
  local function closes(tick, choose)
    local chosen
    for seq, beat in pairs(open) do if choose(beat) and (not chosen or seq < chosen) then chosen = seq end end
    if chosen then open[chosen].close = tick; open[chosen] = nil end
    return chosen
  end
  local failures, compacts, successes, waits = {}, {}, {}, {}
  for _, e in ipairs(events) do
    local kind = ROLE[e.payload.kind] and e.payload.kind or "other"
    if e.kind == "tool" then
      local beat = { seq = e.seq, kind = kind, open = e.tick }
      beats[#beats + 1], open[e.seq] = beat, beat
    elseif e.kind == "success" then
      local closed = closes(e.tick, function(beat) return beat.kind == kind end)
      successes[#successes + 1] = { tick = e.tick, kind = kind, seq = e.seq, beat = closed }
    elseif e.kind == "tool_failed" then
      failures[#failures + 1] = e
      closes(e.tick, function() return true end)
    elseif e.kind == "prompt" or e.kind == "idle" or e.kind == "compact" then
      for seq, beat in pairs(open) do beat.close = e.tick; open[seq] = nil end
      if e.kind == "compact" then compacts[#compacts + 1] = e end
    elseif e.kind == "wait_open" or e.kind == "wait_resolved" then
      waits[#waits + 1] = e
    end
  end
  local visible, latest = {}, 0
  for _, beat in ipairs(beats) do
    local ends = beat.close or (turn and math.huge or math.max(last, beat.open))
    ends = math.max(ends, beat.open + 12)
    latest = math.max(latest, ends)
    if beat.open <= scene.now and scene.now < ends then visible[#visible + 1] = beat end
  end
  local function window(list, class_mode)
    for i, e in ipairs(list) do
      local after = list[i + 1]
      local ends = after and math.min(e.tick + 40, after.tick) or (mode == class_mode and math.huge or e.tick + 40)
      if e.tick <= scene.now and scene.now < ends then return e end
    end
  end
  local wait = waits[#waits]
  return {
    visible = visible, successes = successes,
    chase = window(failures, "error"), carry = window(compacts, "compacting"),
    errand = wait and wait.kind == "wait_open" and mode == "waiting" and wait.tick <= scene.now,
    think = mode == "thinking" and latest ~= math.huge and scene.now >= math.max(last, latest),
  }
end

local function by_class(plan, class)
  local out = {}
  for _, actor in ipairs(plan.actors) do if actor.class == class then out[#out + 1] = actor end end
  return out
end
local function marks_of(plan, kind)
  local out = {}
  for _, mark in ipairs(plan.marks) do if mark.kind == kind then out[#out + 1] = mark end end
  return out
end
local function floor_rows(layout, y)
  for _, floor in ipairs(layout.floors) do if floor.r3 == y then return floor end end
end

local function placement(scene, plan, case)
  local layout, cells, static = scene.layout, {}, {}
  for _, c in ipairs(layout.static) do static[c.y * 65536 + c.x] = true end
  for _, actor in ipairs(plan.actors) do
    check(not (scene.quiet and actor.moving), "reduced motion draws actors at their stations", case)
    if actor.x then
      check(actor.x >= layout.x0 + 1 and actor.x <= layout.x1 - 1 and actor.y > layout.roof and actor.y <= layout.ground,
        "actors stay inside the tower", case)
      if not actor.moving then
        local k = actor.y * 65536 + actor.x
        check(floor_rows(layout, actor.y) ~= nil, "standing actors stand on a floor", case)
        check(not static[k], "standing actors never cover furniture", case)
        check(not cells[k], "one actor per cell and station", case)
        cells[k] = true
      end
    end
  end
end

for _ = 1, 300 do
  local tier = math.random(#Studioview.TIERS)
  local layout, where = tower(tier)
  local kind = KINDS[math.random(7)]
  local open = math.random(0, 5000)
  local close = open + math.random(0, 11)
  local ring = {
    { seq = 1, kind = "tool", tick = open, payload = { kind = kind } },
    { seq = 2, kind = "success", tick = close, payload = { kind = kind } },
  }
  local now = open + math.random(0, 40)
  local plan = Studio.plan({}, { seed = math.random(0, 2 ^ 31), layout = layout, recent = ring, live = { mode = "idle" }, now = now })
  local workers = by_class(plan, "work")
  check(#workers == (now < open + 12 and 1 or 0), "a short tool stays visible for three seconds", where .. " kind=" .. kind .. " dt=" .. (now - open))
end

for _, quiet in ipairs({ true, false }) do
  local layout, where = tower(math.random(#Studioview.TIERS))
  local ring = {
    { seq = 1, kind = "subagent_start", tick = 10, payload = { count = 1 } },
    { seq = 2, kind = "subagent_start", tick = 12, payload = { count = 2 } },
    { seq = 3, kind = "subagent_stop", tick = 400, payload = { count = 1 } },
    { seq = 4, kind = "subagent_stop", tick = 400, payload = { count = 0 } },
  }
  local scene = { seed = math.random(0, 2 ^ 31), layout = layout, recent = ring, live = { mode = "idle", subagents = 0 }, now = 401, quiet = quiet }
  placement(scene, Studio.plan({}, scene), where .. " two contractors leave together quiet=" .. tostring(quiet))
end

for _ = 1, 400 do
  local scene, case = scenario()
  local before = canonical(scene)
  local plan = Studio.plan({}, scene)
  check(canonical(scene) == before, "planning never mutates its inputs", case)
  check(canonical(Studio.plan({}, scene)) == canonical(plan) and canonical(Studio.plan(nil, scene)) == canonical(plan),
    "the same inputs give the same plan", case)

  local layout = scene.layout
  local cap, resolve = staffing(layout.tier)
  local truth = oracle(scene)
  if scene.live.mode == "end" then
    check(#plan.actors == 0 and #plan.marks == 0, "a closed studio is empty", case)
  else
    local staff, contractors = 0, 0
    for _, actor in ipairs(plan.actors) do
      if actor.role == "contractor" then contractors = contractors + 1 else staff = staff + 1 end
    end
    check(staff == STAFF[layout.tier], "every staffer is planned every frame", case)
    check(contractors <= 3, "contractors are capped at three", case)
    check(#marks_of(plan, "bubble") <= 4 and #marks_of(plan, "bug") <= 1, "bubbles and bugs stay capped", case)

    local worked = {}
    for _, actor in ipairs(by_class(plan, "work")) do
      local event
      for _, e in ipairs(scene.recent) do if e.seq == actor.beat and e.kind == "tool" then event = e end end
      check(event ~= nil, "every work pose names a tool event in the ring", case)
      check(resolve(ROLE[event.payload.kind] or "developer") == actor.role, "the worker's role matches the tool kind", case)
      worked[actor.beat] = true
    end
    local expected = {}
    local pools = {}
    for _, beat in ipairs(truth.visible) do
      local role = resolve(ROLE[beat.kind])
      pools[role] = pools[role] or {}
      table.insert(pools[role], beat)
    end
    for role, pool in pairs(pools) do
      table.sort(pool, function(a, b) return a.open < b.open or (a.open == b.open and a.seq < b.seq) end)
      for i = 1, math.min(cap[role], #pool) do expected[pool[i].seq] = true end
    end
    for seq in pairs(worked) do check(expected[seq], "no work pose without a live beat", case) end
    for seq in pairs(expected) do check(worked[seq], "the oldest live beats of each role are worked", case) end

    local idle = #by_class(plan, "idle") > 0
    for class, active in pairs({ errand = truth.errand, chase = truth.chase, carry = truth.carry, think = truth.think }) do
      if active and idle then check(#by_class(plan, class) == 1, "no staffer idles while an incident waits: " .. class, case) end
      if not active then check(#by_class(plan, class) == 0, "incidents follow real events: " .. class, case) end
    end
    check((#marks_of(plan, "bug") == 1) == (truth.chase ~= nil), "a bug scurries exactly while a failure is fresh", case)
    if tonumber(scene.live.subagents) then
      check(#by_class(plan, "contract") == math.min(3, scene.live.subagents), "contractors match the live subagents", case)
    end
    for _, actor in ipairs(by_class(plan, "contract")) do
      if actor.beat then
        local found
        for _, e in ipairs(scene.recent) do if e.seq == actor.beat and e.kind == "subagent_start" then found = true end end
        check(found, "a contractor names the subagent start that brought it", case)
      end
    end

    local fresh = {}
    for i = #truth.successes, 1, -1 do
      local s = truth.successes[i]
      if s.tick <= math.floor(scene.now) and math.floor(scene.now) < s.tick + 8 and #fresh < 4 then fresh[#fresh + 1] = s end
    end
    local bubbles = marks_of(plan, "bubble")
    check(#bubbles == #fresh, "each fresh success pops one bubble", case)
    for i, bubble in ipairs(bubbles) do
      check(bubble.seq == fresh[i].seq and bubble.glyph == Studio.PROP[fresh[i].kind], "bubbles show the kind of work shipped", case)
      local floor = layout.floors[bubble.floor]
      check(bubble.y == floor.r2 or (not scene.quiet and bubble.y == floor.r1), "bubbles rise from the station row", case)
    end

    placement(scene, plan, case)
  end
end

for _ = 1, 150 do
  local scene, case = scenario()
  local tier = scene.layout.tier
  local plan = Studio.plan({}, scene)
  local moved = Studio.plan({}, with(scene, { layout = tower(tier) }))
  local function intent(p)
    local out = {}
    for _, actor in ipairs(p.actors) do
      if actor.role ~= "contractor" then out[actor.id] = table.concat({ actor.class, tostring(actor.beat), tostring(actor.since) }, ":") end
    end
    out.contract = #by_class(p, "contract")
    return out
  end
  check(canonical(intent(plan)) == canonical(intent(moved)), "resizing never changes who works on what", case)
end

for _ = 1, 150 do
  local scene, case = scenario()
  local tier = scene.layout.tier
  local h = math.random(16, 70)
  local w1, w2 = math.random(174, 240), math.random(174, 240)
  scene.layout = tower(tier, w1, h, 3)
  local shifted = with(scene, { layout = Studioview.layout(w2, h, tier, { glyphs = scene.layout.glyphs, density = 3 }) })
  local a, b = Studio.plan({}, scene), Studio.plan({}, shifted)
  local function moved(p, dx)
    local out = copy(p)
    for _, list in ipairs({ out.actors, out.marks }) do
      for _, item in ipairs(list) do
        if item.x then item.x = item.x + dx end
        item.station = item.station and "station"
      end
    end
    return out
  end
  check(canonical(moved(a, w2 - w1)) == canonical(moved(b, 0)), "widening a clamped tower only shifts the crew", case .. " w2=" .. w2)
end

for _ = 1, 120 do
  local scene, case = scenario()
  local target = scene.now
  for _, step in ipairs({ 1, 7, 64 }) do
    local cache = {}
    local t = math.max(0, target - math.random(0, 400))
    local plan
    while t < target do
      plan = Studio.plan(cache, with(scene, { now = t }))
      t = t + step
    end
    plan = Studio.plan(cache, scene)
    check(canonical(plan) == canonical(Studio.plan({}, scene)), "stepping in batches of " .. step .. " reaches the same frame", case)
  end
end

for _ = 1, 150 do
  local scene, case = scenario()
  local cache = {}
  local prefix = copy(scene.recent)
  for _ = 1, math.random(1, 3) do
    if #prefix > 0 then table.remove(prefix) end
  end
  if math.random(2) == 1 then prefix[#prefix + 1] = { seq = 1, kind = "tool", tick = 0, payload = { kind = "edit" } } end
  Studio.plan(cache, with(scene, { recent = prefix, now = scene.now - math.random(0, 50) }))
  if math.random(2) == 1 then Studio.plan(cache, with(scene, { layout = tower(scene.layout.tier) })) end
  check(canonical(Studio.plan(cache, scene)) == canonical(Studio.plan({}, scene)), "a restarted planner draws the same frame", case)
end

for _ = 1, 150 do
  local scene, case = scenario()
  local settled = last_tick(scene.recent) + 2000 + math.random(0, 400)
  local still = with(scene, { quiet = true, now = settled, live = { mode = "idle", subagents = scene.live.subagents } })
  local later = with(still, { now = settled + math.random(1, 50) * Studio.SLOT + math.random(0, Studio.SLOT - 1) })
  check(canonical(Studio.plan({}, still)) == canonical(Studio.plan({}, later)), "reduced motion never reshuffles idle staff", case)
end

local busy = tower(5, 200, 60, 1)
local ring = {}
for i = 1, 64 do
  ring[i] = { seq = i, kind = ({ "tool", "success", "tool", "subagent_start" })[i % 4 + 1], tick = i * 3,
    payload = { kind = KINDS[i % 7 + 1], count = i % 3 + 1 } }
end
local function busy_scene(now) return { seed = 7, layout = busy, recent = ring, live = { mode = "tool", subagents = 3 }, now = now } end
local started = os.clock()
for i = 1, 100 do Studio.plan({}, busy_scene(192 + i)) end
local per_build = (os.clock() - started) / 100 * 1000
local cache = {}
Studio.plan(cache, busy_scene(192))
started = os.clock()
for i = 1, 2000 do Studio.plan(cache, busy_scene(192 + i)) end
local per_tick = (os.clock() - started) / 2000 * 1000
check(per_build < 5 and per_tick < 0.5, string.format("planning stays cheap (build %.3f ms, tick %.3f ms)", per_build, per_tick), "200x60")

print(string.format("studio ok (%d checks, build %.3f ms, tick %.3f ms, STUDIO_SEED=%d)", tests, per_build, per_tick, SEED))
