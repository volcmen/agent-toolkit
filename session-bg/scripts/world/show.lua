local HERE = (arg[0]:match("(.*/)") or "./")
local Hn = dofile(HERE .. "harness.lua")
local DIR = HERE .. "../../plugins/fx/"
local name = arg[1] or "fortress"
local tools = tonumber(arg[2]) or 120
local mode = arg[3] or "thinking"
local W, H = tonumber(arg[4]) or 120, tonumber(arg[5]) or 36
local opts = { context_pct = tonumber(arg[6]) or 45, mode = mode, subagents = 2, errors = (mode == "error") and 3 or 0 }
local scen = { name = name, j = Hn.journey(tools, opts), opts = opts, mode = function() return mode end }
local cov, raw, frame = Hn.run(DIR .. name .. ".lua", scen, W, H, 90, true)
print(frame)
print(string.format("-- %s tools=%d mode=%s %dx%d coverage %.1f%%", name, tools, mode, W, H, cov * 100))
