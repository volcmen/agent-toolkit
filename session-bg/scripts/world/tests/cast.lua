local H = dofile("scripts/world/harness.lua")
local SEED = tonumber(os.getenv("CAST_SEED")) or (os.time() ~ math.floor(os.clock() * 1e9))
math.randomseed(SEED)
Glyphs = dofile("plugins/fx/fortress/glyphs.lua")
local env = H.sandbox()
env.Glyphs = Glyphs
env.Sim = dofile("plugins/fx/fortress/sim.lua")
local Studioview = assert(loadfile("plugins/fx/fortress/studioview.lua", "t", env))()
env.Studioview = Studioview
local Studio = assert(loadfile("plugins/fx/fortress/studio.lua", "t", env))()
local View = dofile("plugins/fx/fortress/render.lua")
View.studioview = Studioview
local tests = 0
local function check(ok, message, case)
  if not ok then error(string.format("%s (CAST_SEED=%d case=%s)", message, SEED, tostring(case)), 2) end
  tests = tests + 1
end

local KINDS = { "edit", "read", "exec", "web", "mcp", "task", "other" }
local EVENTS = { "tool", "tool", "tool", "success", "success", "tool_failed", "compact", "wait_open", "wait_resolved", "subagent_start",
  "subagent_stop", "prompt", "idle" }
local MODES = { "tool", "thinking", "waiting", "error", "compacting", "idle", "start", "end" }
local function ring()
  local out, tick, crew = {}, math.random(0, 5000), 0
  for i = 1, math.random(0, 48) do
    local kind = EVENTS[math.random(#EVENTS)]
    tick = tick + math.random(0, 16)
    local payload = {}
    if kind == "tool" or kind == "success" then payload.kind = KINDS[math.random(#KINDS)] end
    if kind == "subagent_start" then crew = crew + 1; payload.count = crew end
    if kind == "subagent_stop" then crew = math.max(0, crew - 1); payload.count = crew end
    out[i] = { seq = i, kind = kind, tick = tick, payload = payload }
  end
  return out, tick
end
local function viewport(form)
  while true do
    local tier = math.random(#Studioview.TIERS)
    local w, h = math.random(40, 240), math.random(10, 70)
    local params = { glyphs = math.random(2) == 1 and "ascii" or "unicode", density = ({ 0.4, 1, 1.7, 3 })[math.random(4)],
      presentation = math.random(4) == 1 and "compact" or "auto" }
    local layout = Studioview.layout(w, h, tier, params)
    if not form or layout.form == form then
      return layout, params, string.format("%dx%d tier=%d %s %s density=%s", w, h, tier, params.glyphs, params.presentation, params.density)
    end
  end
end
local function scene(form)
  local layout, params, where = viewport(form)
  local recent, last = ring()
  local s = { seed = math.random(0, 2 ^ 31), layout = layout, params = params, recent = recent,
    live = { mode = MODES[math.random(#MODES)], subagents = math.random(0, 4) }, now = last + math.random(0, 60), quiet = math.random(4) == 1 }
  return s, string.format("%s mode=%s events=%d now=%d quiet=%s", where, s.live.mode, #recent, s.now, tostring(s.quiet))
end
local function clock_of(s, now) return { now = now or s.now, quiet = s.quiet, ending = s.live.mode == "end" } end
local function snapshot(items)
  local out = {}
  for i, item in ipairs(items) do
    out[i] = table.concat({ item.part, item.x, item.y, item.ch, item.colour[1], item.colour[2], item.colour[3], item.bright }, ":")
  end
  return table.concat(out, "|")
end
local function shade(colour, bright)
  return { math.min(1, colour[1] * bright), math.min(1, colour[2] * bright), math.min(1, colour[3] * bright) }
end
local function same(cell, colour)
  return math.abs(cell.r - colour[1]) < 1e-9 and math.abs(cell.g - colour[2]) < 1e-9 and math.abs(cell.b - colour[3]) < 1e-9
end
local function static_cells(layout)
  local cells = {}
  for _, c in ipairs(layout.static) do cells[c.y * 65536 + c.x] = c end
  return cells
end

for _ = 1, 500 do
  local s, case = scene()
  local layout = s.layout
  local frame = Studio.plan({}, s)
  local items = Studioview.cast(frame, layout, clock_of(s))
  if layout.form ~= "tower" or s.live.mode == "end" then
    check(#items == 0, "a closed or towerless studio casts nothing", case)
  else
    local vocabulary, static = layout.vocabulary, static_cells(layout)
    for _, item in ipairs(items) do
      check(item.x > layout.x0 and item.x < layout.x1 and item.y > layout.roof and item.y < layout.ground, "cast items stay inside the tower: " .. item.part, case)
      check(type(item.ch) == "string" and Glyphs.len(item.ch) == 1, "every cast glyph is one code point: " .. item.part, case)
      check(layout.glyphs ~= "ascii" or item.ch:match("^[!-~]$"), "ascii mode casts printable ascii only: " .. item.part, case)
      check(type(item.colour) == "table" and type(item.bright) == "number", "every cast item has a palette colour: " .. item.part, case)
    end
    local at = {}
    for _, item in ipairs(items) do
      local k = item.y * 65536 + item.x
      at[k] = at[k] or {}
      table.insert(at[k], item)
    end
    local lit_by, idle = {}, Studioview.colours[Studioview.CLASS_COLOURS.idle]
    for _, actor in ipairs(frame.actors) do
      if actor.x and actor.class ~= "idle" then
        local front = (at[actor.y * 65536 + actor.x] or {})[1]
        check(not front or front.part ~= "actor" or front.colour ~= idle, "busy crew draw in front of idle crew", case)
      end
      if actor.x then
        local found = false
        for _, item in ipairs(at[actor.y * 65536 + actor.x] or {}) do
          if item.part == "actor" and item.ch == vocabulary[actor.glyph] then found = true end
        end
        check(found, "every placed actor is cast at its cell with its glyph", case)
        local lit = actor.station and layout.lit[actor.station]
        if lit then
          local colour = Studioview.colours[Studioview.PROP_COLOURS[actor.prop] or Studioview.CLASS_COLOURS[actor.class]]
          local shown = false
          for _, item in ipairs(at[lit.y * 65536 + lit.x] or {}) do
            if item.part == "lit" and item.ch == vocabulary[lit.key] and item.colour == colour then shown = true end
          end
          check(shown, "a crewed station lights its screen in the job's colour", case)
          lit_by[lit.y * 65536 + lit.x] = true
        end
      end
    end
    for _, item in ipairs(items) do
      if item.part == "lit" then
        check(lit_by[item.y * 65536 + item.x], "no screen lights without an actor bound to its station", case)
      end
    end
    for _, light in ipairs(layout.lights) do
      check(not static[light.y * 65536 + light.x], "ambient lights sit on free cells", case)
      check(light.x > layout.x0 and light.x < layout.x1 and light.y > layout.roof and light.y < layout.ground, "ambient lights stay inside the tower", case)
    end
    if s.quiet then
      local later = s.now + math.random(1, 400)
      check(snapshot(items) == snapshot(Studioview.cast(frame, layout, clock_of(s, later))), "reduced motion casts a still frame", case)
    elseif #layout.lights > 0 or layout.tier >= 2 then
      local moved = false
      for dt = 1, 4 do
        if snapshot(items) ~= snapshot(Studioview.cast(frame, layout, clock_of(s, s.now + dt))) then moved = true end
      end
      check(moved, "the ambient layer changes within four ticks", case)
    end
  end
end

local function hud_state(mode, tools, age)
  local j = H.story(tools, { subagents = math.random(0, 3) })
  local state = H.mkstate(mode, j, { scene = "studio", age = age })
  state.session_name = "studio"
  return state
end
for _ = 1, 400 do
  local s, case = scene("tower")
  local layout = s.layout
  layout.scene = "studio"
  local mode = s.live.mode
  local state = hud_state(mode, math.random(0, 400), math.random() * (math.random(2) == 1 and #layout.floors + 1 or 30))
  for k, v in pairs(s.params) do state.params[k] = v end
  state.params.reduced_motion = s.quiet
  local items = Studioview.cast(Studio.plan({}, s), layout, clock_of(s))
  local fx = H.mkfx(layout.w, layout.h)
  View.render(fx, nil, layout, state, 0, nil, nil, items)
  local static, cast, w = static_cells(layout), {}, layout.w
  for _, item in ipairs(items) do
    local k = item.y * w + item.x
    if not cast[k] then cast[k] = item end
  end
  local chrome = 0
  for key in pairs(fx.cells) do
    if not cast[key] and not static[(key // w) * 65536 + key % w] then chrome = chrome + 1 end
  end
  local cast_count = 0
  for _ in pairs(cast) do cast_count = cast_count + 1 end
  local fits = chrome + cast_count + #layout.static <= layout.budget
  if fits then
    for key in pairs(cast) do check(fx.cells[key], "every cast item reaches the screen within budget", case) end
  end
  for key, item in pairs(cast) do
    local cell = fx.cells[key]
    check(not cell or (cell.ch == item.ch and same(cell, shade(item.colour, item.bright))), "the first cast item wins its cell", case)
  end
  if fits then
    for _, c in ipairs(layout.static) do
      local cell = fx.cells[c.y * w + c.x]
      check(cell and (cell.ch == c.ch or cast[c.y * w + c.x]), "the cast never pushes the tower off the screen within budget", case)
    end
  end
  if mode == "end" then
    local dark = Studioview.dark(layout, state.age, s.quiet)
    check(dark == (s.quiet and #layout.floors or math.min(#layout.floors, math.floor(state.age))),
      "the lights go out one floor per second, all at once under reduced motion", case)
    for index, floor in ipairs(layout.floors) do
      local wall = fx.cells[floor.r2 * w + layout.x0]
      if wall then
        local out = #layout.floors - index < dark
        check(same(wall, shade(Studioview.colours.frame, out and Studioview.CLOSED or 1)), "closing dims the floors from the top down",
          case .. " floor=" .. index)
      end
    end
  end
end

local SIZES = { { 80, 24 }, { 120, 35 }, { 200, 60 } }
local TOOLS = { 0, 60, 150, 330, 700 }
local function bundle(w, h, path)
  local b = H.sandbox()
  assert(loadfile(path or "plugins/fx/fortress.lua", "t", b))()
  b.init({ w = w, h = h, seed = math.random(1, 1 << 30), fps = 30, density = 1 })
  return b
end
local function stage(spec)
  local size = SIZES[math.random(#SIZES)]
  local w, h = size[1], size[2]
  local tools = spec.tools or TOOLS[math.random(#TOOLS)]
  local b = bundle(w, h)
  local j = H.story(tools, { subagents = spec.subagents or 0, tail = spec.tail })
  local state = H.mkstate(spec.mode, j, { scene = "studio", tool_kind = spec.kind, age = spec.age or 3, context_pct = 40 })
  local frames = {}
  for f = 1, spec.frames or 30 do
    b.step(1 / 30, state)
    local fx = H.mkfx(w, h)
    b.render(fx, state)
    frames[f] = fx
  end
  local tier = b.checkpoint().status.studio.tier
  local layout = Studioview.layout(w, h, tier, state.params)
  local case = string.format("%dx%d tools=%d tier=%d mode=%s", w, h, tools, tier, spec.mode)
  for _, fx in ipairs(frames) do
    for key, cell in pairs(fx.cells) do
      local x, y = key % w, key // w
      local tower = x >= layout.x0 and x <= layout.x1 and y >= layout.sign_y and y <= layout.ground
      check(not tower or cell.ch ~= "?", "the bundled tower never draws a substitution glyph", case)
    end
  end
  return frames, layout, case
end
local function tone(name, bright) return shade(Studioview.colours[name], bright) end
local function inside(layout, fx, ch, colour)
  local n = 0
  for key, cell in pairs(fx.cells) do
    local x, y = key % fx.w, key // fx.w
    if x > layout.x0 and x < layout.x1 and y > layout.roof and y < layout.ground and (not ch or cell.ch == ch)
      and (not colour or same(cell, colour)) then
      n = n + 1
    end
  end
  return n
end
local function ever(frames, layout, ch, colour)
  for _, fx in ipairs(frames) do if inside(layout, fx, ch, colour) > 0 then return true end end
  return false
end
local function row_text(fx, y)
  local out = {}
  for x = 0, fx.w - 1 do
    local c = fx.cells[y * fx.w + x]
    out[#out + 1] = c and c.ch or " "
  end
  return table.concat(out)
end
local V = Glyphs.vocabulary("unicode")

local function most(frames, layout, ch, colour)
  local peak = 0
  for _, fx in ipairs(frames) do peak = math.max(peak, inside(layout, fx, ch, colour)) end
  return peak
end
local function status_row(frames) return row_text(frames[#frames], 0) end

local function lower(fx, h)
  local out = {}
  for y = h // 2, h - 4 do out[#out + 1] = row_text(fx, y) end
  return table.concat(out, "\n")
end
local function tower_rows(fx, layout)
  local out = {}
  for y = layout.roof, layout.ground do
    for x = layout.x0, layout.x1 do
      local c = fx.cells[y * fx.w + x]
      out[#out + 1] = c and string.format("%s%.4f%.4f%.4f", c.ch, c.r, c.g, c.b) or "."
    end
  end
  return table.concat(out, "|")
end
for _, size in ipairs(SIZES) do
  for _, tools in ipairs(TOOLS) do
    local w, h = size[1], size[2]
    local case = string.format("%dx%d tools=%d", w, h, tools)
    local b = bundle(w, h, "plugins/fx/world.lua")
    local state = H.mkstate("idle", H.story(tools, { subagents = math.random(0, 3), tail = { { kind = "idle" } } }), { scene = "studio" })
    for _ = 1, math.random(1, 90) do b.step(1 / 30, state) end
    local samples = {}
    for f = 0, 36 do
      b.step(1 / 30, state)
      if f % 9 == 0 then
        local fx = H.mkfx(w, h)
        b.render(fx, state)
        samples[#samples + 1] = lower(fx, h)
      end
    end
    local changed = false
    for i = 2, #samples do if samples[i] ~= samples[1] then changed = true end end
    check(changed, "the lower floors change within 1.2 s", case)

    b = bundle(w, h, "plugins/fx/world.lua")
    state = H.mkstate("idle", H.story(tools, { subagents = math.random(0, 3), tail = { { kind = "idle" } } }), { scene = "studio" })
    state.params.reduced_motion = true
    b.step(1 / 30, state)
    local layout = Studioview.layout(w, h, b.checkpoint().status.studio.tier, state.params)
    local first
    for k = 0, 6 do
      state.age = 3 + k * math.random(5, 40)
      for _ = 1, 9 do b.step(1 / 30, state) end
      local fx = H.mkfx(w, h)
      b.render(fx, state)
      local rows = tower_rows(fx, layout)
      first = first or rows
      check(rows == first, "reduced motion keeps the tower still", case .. " step=" .. k)
    end
  end
end

for _ = 1, 60 do
  local size = SIZES[math.random(#SIZES)]
  local b = bundle(size[1], size[2])
  local tools = math.random(0, 300)
  local state = H.mkstate("tool", H.story(tools, {}), { scene = "studio", age = 0 })
  local j = state.journey
  b.step(1 / 30, state)
  local previous = b.checkpoint().status.studio.now
  local case = string.format("%dx%d tools=%d", size[1], size[2], tools)
  for _ = 1, 80 do
    local r = math.random(6)
    if r == 1 then
      j.tick = j.tick + math.random(0, 20)
      state.age = math.random()
    elseif r == 2 then
      state.age = math.random() * 3
    else
      state.age = state.age + 1 / 30
    end
    local paused = math.random(8) == 1
    state.params.paused = paused or nil
    b.step(1 / 30, state)
    local now = b.checkpoint().status.studio.now
    if paused then
      check(now == previous, "a paused studio freezes its clock", case)
    else
      check(now >= previous, "the studio clock never runs backwards", case)
      check(now >= j.tick + math.floor(state.age * 4), "the studio clock never trails the journey", case)
    end
    previous = now
  end
end

for _ = 1, 3 do
  for _, kind in ipairs(KINDS) do
    local prop = Studio.PROP[kind]
    local frames, layout, case = stage({ mode = "tool", kind = kind, tail = { { kind = "tool", payload = { kind = kind } } } })
    case = case .. " kind=" .. kind
    check(status_row(frames):find(Studioview.VERBS[kind], 1, true), "a tool names its verb on the status lamp", case)
    local lit = false
    for _, key in ipairs({ "monitor", "board", "rack", "shelf", "door" }) do
      lit = lit or ever(frames, layout, V[key], tone(Studioview.PROP_COLOURS[prop], Studioview.LIT))
    end
    check(lit, "a tool lights its station in the job's colour", case)
    check(ever(frames, layout, V.staff, tone("text", 1)), "a tool puts a staffer to work", case)

    frames, layout, case = stage({ mode = "thinking", age = 0, tail = { { kind = "tool", payload = { kind = kind } }, { kind = "success", payload = { kind = kind } } } })
    check(ever(frames, layout, V[prop], tone(Studioview.PROP_COLOURS[prop], Studioview.LIT)), "a success pops its point bubble", case .. " kind=" .. kind)
  end

  local frames, layout, case = stage({ mode = "thinking", tail = {} })
  check(ever(frames, layout, V.thinking, tone("text", Studioview.LIT)), "thinking sends a staffer to the whiteboard with dots", case)

  frames, layout, case = stage({ mode = "waiting", tail = { { kind = "wait_open" } } })
  check(ever(frames, layout, V.lamp, tone("amber", Studioview.LIT)), "a waiting permission sends an errand with a lamp", case)
  check(status_row(frames):find("Approve?", 1, true), "a waiting permission asks for approval", case)
  frames, layout, case = stage({ mode = "waiting", tail = { { kind = "wait_open" }, { kind = "wait_resolved" } } })
  check(not ever(frames, layout, V.lamp), "a resolved permission sends no errand", case)
  check(status_row(frames):find("Your move", 1, true), "plain waiting hands the turn back", case)

  frames, layout, case = stage({ mode = "error", tail = { { kind = "tool", payload = { kind = "exec" } }, { kind = "tool_failed" } } })
  check(ever(frames, layout, V.bug, tone("red", Studioview.LIT)), "an error drops a bug in the tower", case)
  check(ever(frames, layout, V.staff, tone("red", 1)), "a staffer chases the bug", case)

  frames, layout, case = stage({ mode = "compacting", tail = { { kind = "compact" } } })
  check(ever(frames, layout, V.shelf, tone("violet", Studioview.LIT)), "compaction sends the archivist with files", case)

  frames, layout, case = stage({ mode = "idle", tail = { { kind = "idle" } } })
  check(not ever(frames, layout, V.staff) and ever(frames, layout, V.idle), "idle staff take a break", case)

  frames, layout, case = stage({ mode = "start", tools = 0, tail = {} })
  check(status_row(frames):find("Opening", 1, true) and ever(frames, layout, V.idle), "a new session opens the garage", case)

  local n = math.random(1, 5)
  frames, layout, case = stage({ mode = "tool", kind = "task", subagents = n, tail = { { kind = "tool", payload = { kind = "task" } } } })
  check(most(frames, layout, V.contractor) == math.min(3, n), "each live subagent is a contractor up to three", case .. " n=" .. n)

  frames, layout, case = stage({ mode = "end", subagents = 2, tail = {}, age = math.random() * 12 })
  local lit = 0
  for _, key in ipairs({ "staff", "idle", "contractor", "car", "led", "steam" }) do lit = lit + most(frames, layout, V[key]) end
  check(lit == 0, "a closed studio goes dark", case)
  check(status_row(frames):find("Closed", 1, true), "a closed studio says so", case)
end

print(string.format("cast ok (%d checks, CAST_SEED=%d)", tests, SEED))
