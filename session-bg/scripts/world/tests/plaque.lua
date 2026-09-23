-- The Fortress HUD follows the live session: rename, mode, context meter, progress and milestones.
local HERE = (arg[0]:match("(.*/)") or "./")
local Hn = dofile(HERE .. "../harness.lua")
local WORLD = HERE .. "../../../plugins/fx/world.lua"
local tests = 0
local function check(ok, message) assert(ok, message); tests = tests + 1 end
local function scenario(mutate, opts)
  opts = opts or {}
  local o = { context_pct = opts.context_pct or 42, mode = opts.mode or "tool", lines_added = 120, lines_removed = 40 }
  return { name = "plaque", j = Hn.journey(30, o), opts = o, mode = function() return o.mode end, mutate = mutate }
end
local function rows(scen, frames, w, h)
  local _, _, text = Hn.run(WORLD, scen, w or 120, h or 35, frames, true)
  local out = {}
  for line in (text .. "\n"):gmatch("(.-)\n") do out[#out + 1] = line end
  return out
end
local function has(s, needle) return s:find(needle, 1, true) ~= nil end

local renamed = scenario(function(st, f)
  st.session_name = f < 31 and "Amber tools" or "Renamed workshop"
  st.journey.tools = 30
end)
local before = rows(renamed, 30)
check(has(before[1], "Amber tools"), "initial title shown")
local after = rows(renamed, 31)
check(has(after[1], "Renamed workshop") and not has(after[1], "Amber tools"), "rename replaces the title on the next frame")
local later = rows(renamed, 40)
check(has(later[4], "*") and has(later[4], "renamed"), "rename announces a toast on the HUD row")

local live = scenario(function(st) st.session_name = "Live"; st.journey.tools = 30 end)
local shown = rows(live, 5)
check(has(shown[4], "Bash"), "tool mode names the running tool")
check(has(shown[4], "ctx [") and has(shown[4], "] 42%"), "context meter shows the percentage")
check(has(shown[#shown - 3], "30 tools +120/-40"), "progress line lists tools and lines")
check(has(rows(scenario(function(st) st.journey.tools = 30 end, { mode = "thinking" }), 5)[4], "thinking"), "thinking mode is labelled")
check(has(rows(scenario(function(st) st.journey.tools = 30 end, { mode = "waiting" }), 4)[4], "waiting"), "waiting mode is labelled")
local narrow = rows(live, 5, 80, 24)
check(has(narrow[#narrow - 3], "30t +120/-40"), "narrow strips use the compact progress form")

local milestone = scenario(function(st, f) st.session_name = "Miles"; st.journey.tools = f < 31 and 30 or 50 end)
check(not has(rows(milestone, 30)[4], "50 tools"), "no toast before the boundary")
check(has(rows(milestone, 45)[4], "* 50 tools"), "crossing 50 tools shows a toast")
check(not has(rows(milestone, 31 + 30 * 4 + 20)[4], "50 tools"), "toast clears after its slot")
local pct = scenario(function(st, f) st.session_name = "Ctx"; st.journey.tools = 30; st.context_pct = f < 31 and 40 or 52 end)
local quart = rows(pct, 40)
check(has(quart[4], "* context 50%"), "crossing a context quartile shows a toast")
check(has(quart[4], "] 52%"), "meter follows the new percentage")

for _, size in ipairs({ { 1, 1 }, { 12, 3 }, { 30, 6 }, { 60, 10 }, { 59, 15 } }) do
  local ok, err = pcall(Hn.run, WORLD, live, size[1], size[2], 20)
  check(ok, "pane " .. size[1] .. "x" .. size[2] .. ": " .. tostring(err))
end

local env = Hn.sandbox()
local Plaque = assert(loadfile(HERE .. "../../../plugins/fx/fortress/plaque.lua", "t", env))()
local p = Plaque.new()
local function st(mode, extra)
  local s = Hn.mkstate(mode, live.j, live.opts)
  for k, v in pairs(extra or {}) do s[k] = v end
  return s
end
p:step(0.1, st("idle", { context_pct = 0, age = 3 }))
local hud = p:hud(st("idle", { context_pct = 0, age = 3 }), 21)
check(hud.meter == nil and hud.label == "idle", "no meter without context data; idle is plain")
check(p:hud(st("idle", { age = 90 }), 21).label:match("^idle z+$"), "long idle shows sleep marks")
check(p:hud(st("error", { age = 1 }), 21).colour == "red", "fresh error is red")
check(p:hud(st("compacting"), 21).label:match("^compacting ~+$"), "compaction is labelled")
p:step(0.1, st("tool", { journey = Hn.journey(30, live.opts), lines_added = 600 }))
check(p.toasts[1] and p.toasts[1].text == "* +500 lines", "line milestone toast")
p:step(0.1, st("tool", { journey = Hn.journey(30, { subagents = 2 }), lines_added = 600 }))
check(p.toasts[#p.toasts].text == "* helper joins", "subagent arrival toast")
local bad = Plaque.new()
bad:step(0 / 0, { mode = "tool" })
check(bad.t == bad.t, "non-finite dt does not poison the clock") 
print("plaque ok (" .. tests .. " checks)")
