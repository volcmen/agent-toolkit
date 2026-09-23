local HERE = (arg[0]:match("(.*/)") or "./")
local Hn = dofile(HERE .. "harness.lua")

local DIR = HERE .. "../../plugins/fx/"
local scripts = { ... }
if #scripts == 0 then scripts = { "fortress", "world" } end

local MODES = { "start", "idle", "thinking", "tool", "waiting", "error", "compacting", "end" }

local function scen(name, tools, opts)
  local j = (opts and opts.scene == "studio" and Hn.story or Hn.journey)(tools, opts)
  return {
    name = name,
    j = j,
    opts = opts,
    mode = function(f)
      if opts and opts.mode then return opts.mode end
      return MODES[((f // 9) % #MODES) + 1]
    end,
  }
end

local scenarios = {
  scen("empty(0 tools)", 0, { context_pct = 3 }),
  scen("short(30)", 30, { context_pct = 20, subagents = 0 }),
  scen("long(300)", 300, { context_pct = 88 }),
  scen("errors(90)", 90, { errors = 7, context_pct = 55, mode = "error" }),
  scen("subagents(150,x4)", 150, { subagents = 4, context_pct = 66 }),
  scen("mood-palette(120)", 120, { context_pct = 45,
    mood = { palette = { "#2e4057", "#8ea8c3", "#c1cfda", "#4f6d7a", "#e8dab2" },
      tempo = 1.2, title = "Kelp Forest Ltd", mood = "calm" } }),
  scen("waiting(60)", 60, { context_pct = 30, mode = "waiting" }),
  scen("compacting(200)", 200, { context_pct = 95, mode = "compacting" }),
  scen("studio empty(0)", 0, { context_pct = 3, scene = "studio" }),
  scen("studio long(300)", 300, { context_pct = 88, subagents = 2, scene = "studio", tail = { { kind = "tool", payload = { kind = "edit" } } } }),
  scen("studio errors(90)", 90, { errors = 7, context_pct = 55, mode = "error", scene = "studio", tail = { { kind = "tool_failed" } } }),
  scen("studio waiting(60)", 60, { context_pct = 30, mode = "waiting", scene = "studio", tail = { { kind = "wait_open" } } }),
  scen("studio compacting(200)", 200, { context_pct = 95, mode = "compacting", scene = "studio", tail = { { kind = "compact" } } }),
  scen("studio subagents(700,x4)", 700, { subagents = 4, context_pct = 66, scene = "studio" }),
}
local baselines = { scenarios[1], scenarios[9] }

local fail = 0
for _, s in ipairs(scripts) do
  local path = DIR .. s .. ".lua"
  local limit = 0.25
  local worst = 0
  local lines = {}
  for _, sc in ipairs(scenarios) do
    local ok, cov, raw = pcall(Hn.run, path, sc, 200, 60, 120)
    if not ok then
      lines[#lines + 1] = string.format("    %-20s ERROR %s", sc.name, tostring(cov))
      fail = fail + 1
    else
      worst = math.max(worst, cov)
      local flag = cov > limit and "  <== OVER" or ""
      if cov > limit then fail = fail + 1 end
      lines[#lines + 1] = string.format("    %-20s cov %5.1f%%  (puts %5.1f%%)%s", sc.name, cov * 100, raw * 100, flag)
    end
  end
  -- also a small pane
  do
    for _, base in ipairs(baselines) do for _, size in ipairs({ { 180, 45 }, { 80, 24 } }) do
      local okb, covb = pcall(Hn.run, path, base, size[1], size[2], 30)
      if not okb then
        lines[#lines + 1] = string.format("    baseline %s %dx%d ERROR %s", base.name, size[1], size[2], tostring(covb))
        fail = fail + 1
      elseif covb < 0.02 then
        lines[#lines + 1] = string.format("    baseline %s %dx%d cov %5.1f%%  <== TOO FAINT (min 2%%)", base.name, size[1], size[2], covb * 100)
        fail = fail + 1
      else
        lines[#lines + 1] = string.format("    baseline %s %dx%d cov %5.1f%%", base.name, size[1], size[2], covb * 100)
      end
    end end
  end
  local ok2, cov2 = pcall(Hn.run, path, scenarios[3], 80, 24, 60)
  print(string.format("%s  worst %5.1f%% (limit %.0f%%)  80x24 long: %s", s, worst * 100, limit * 100,
    ok2 and string.format("%5.1f%%", cov2 * 100) or ("ERROR " .. tostring(cov2))))
  if not ok2 then fail = fail + 1 elseif cov2 > limit then fail = fail + 1; print("    80x24 OVER") end
  for _, l in ipairs(lines) do print(l) end
end
print(fail == 0 and "ALL OK" or ("FAILURES: " .. fail))
os.exit(fail == 0 and 0 or 1)
