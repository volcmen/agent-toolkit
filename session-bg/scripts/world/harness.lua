-- Mock sbg/fx harness: drives init/step/render of a session-bg script with
-- synthetic journeys and reports coverage. Mirrors plugins/src/api.rs plus the
-- journey/mood/text additions.

local FPS = 30

-- ---------- rng (xorshift-ish, deterministic) ----------
local function mkrng(seed)
  local s = (math.floor(seed or 0) % 4294967296)
  if s == 0 then s = 88172645 end
  local o = {}
  local function nextu()
    s = (s * 1103515245 + 12345) % 4294967296
    return s
  end
  function o:f() return nextu() / 4294967296 end
  function o:range(a, b) return a + (b - a) * o:f() end
  function o:below(n) if n <= 0 then return 0 end return math.floor(o:f() * n) % n end
  function o:chance(p) return o:f() < p end
  return o
end

-- ---------- noise ----------
local function hash2(x, y)
  local n = x * 374761393 + y * 668265263
  n = (n ~ (n >> 13)) * 1274126177
  return ((n ~ (n >> 16)) % 65536) / 65536.0
end
local function lerp(a, b, t) return a + (b - a) * t end
local function smooth(t) return t * t * (3 - 2 * t) end
local function noise2(x, y)
  local xi, yi = math.floor(x), math.floor(y)
  local xf, yf = x - xi, y - yi
  local u, v = smooth(xf), smooth(yf)
  local a = hash2(xi, yi)
  local b = hash2(xi + 1, yi)
  local c = hash2(xi, yi + 1)
  local d = hash2(xi + 1, yi + 1)
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1
end
local function noise3(x, y, z) return noise2(x + z * 31.7, y - z * 17.3) end
local function fbm(x, y, oct)
  oct = math.max(1, math.min(8, math.floor(oct or 4)))
  local sum, amp, f, norm = 0, 0.5, 1.0, 0
  for _ = 1, oct do
    sum = sum + noise2(x * f, y * f) * amp
    norm = norm + amp
    amp = amp * 0.5
    f = f * 2
  end
  return sum / norm
end

-- ---------- colour ----------
local function clamp(v, lo, hi) if v < lo then return lo elseif v > hi then return hi else return v end end
local RAMPS = {
  matrix = { { 0.05, 0.15, 0.07 }, { 0.61, 0.90, 0.42 }, { 0.84, 1.0, 0.88 } },
  ember  = { { 0.15, 0.03, 0.0 }, { 0.85, 0.35, 0.05 }, { 1.0, 0.90, 0.55 } },
  ice    = { { 0.02, 0.06, 0.15 }, { 0.25, 0.55, 0.85 }, { 0.85, 0.95, 1.0 } },
  tokyonight = { { 0.10, 0.11, 0.18 }, { 0.48, 0.55, 0.92 }, { 0.73, 0.80, 0.99 } },
  mono   = { { 0.08, 0.08, 0.08 }, { 0.45, 0.45, 0.45 }, { 0.95, 0.95, 0.95 } },
  warn   = { { 0.18, 0.05, 0.0 }, { 0.90, 0.55, 0.10 }, { 1.0, 0.95, 0.70 } },
}
local function ramp(name, t)
  local r = RAMPS[name] or RAMPS.mono
  t = clamp(t, 0, 1) * 2
  local i = math.min(1, math.floor(t))
  local f = t - i
  local a, b = r[i + 1], r[i + 2]
  return lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f)
end
local function hex(v)
  v = math.floor(clamp(v, 0, 0xffffff))
  return ((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255
end
local function hsl(h, s, l)
  h = h - math.floor(h)
  s, l = clamp(s, 0, 1), clamp(l, 0, 1)
  local c = (1 - math.abs(2 * l - 1)) * s
  local hp = h * 6
  local x = c * (1 - math.abs(hp % 2 - 1))
  local r, g, b = 0, 0, 0
  if hp < 1 then r, g, b = c, x, 0
  elseif hp < 2 then r, g, b = x, c, 0
  elseif hp < 3 then r, g, b = 0, c, x
  elseif hp < 4 then r, g, b = 0, x, c
  elseif hp < 5 then r, g, b = x, 0, c
  else r, g, b = c, 0, x end
  local m = l - c / 2
  return clamp(r + m, 0, 1), clamp(g + m, 0, 1), clamp(b + m, 0, 1)
end
local function rgb2hsl(r, g, b)
  local mx, mn = math.max(r, g, b), math.min(r, g, b)
  local l = (mx + mn) / 2
  if mx == mn then return 0, 0, l end
  local d = mx - mn
  local s = d / (1 - math.abs(2 * l - 1))
  local h
  if mx == r then h = ((g - b) / d) % 6
  elseif mx == g then h = (b - r) / d + 2
  else h = (r - g) / d + 4 end
  return h / 6, s, l
end

-- ---------- glyph tables ----------
local function chars(s)
  local t = {}
  for _, c in utf8.codes(s) do t[#t + 1] = utf8.char(c) end
  return t
end
local BRAILLE = {}
for i = 0, 255 do BRAILLE[i + 1] = utf8.char(0x2800 + i) end

local sbg = {}
sbg.rng = mkrng
sbg.noise2 = noise2
sbg.noise3 = noise3
sbg.fbm = fbm
sbg.ramp = ramp
sbg.mix = function(r1, g1, b1, r2, g2, b2, t)
  return lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)
end
sbg.scale = function(r, g, b, k) return clamp(r * k, 0, 1), clamp(g * k, 0, 1), clamp(b * k, 0, 1) end
sbg.hex = hex
sbg.hsl = hsl
sbg.shift_hue = function(r, g, b, turns)
  local h, s, l = rgb2hsl(r, g, b)
  return hsl(h + turns, s, l)
end
sbg.braille = function(m) return BRAILLE[(math.floor(m) % 256) + 1] end
sbg.lerp = lerp
sbg.clamp = clamp
sbg.smoothstep = function(e0, e1, x)
  if math.abs(e1 - e0) < 1e-9 then return 0 end
  local t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
end
sbg.wrap = function(v, n) if n == 0 then return 0 end return v - n * math.floor(v / n) end
sbg.glyphs = {
  matrix = chars("ｱｲｳｴｵｶｷｸｹｺ0123456789:.=*+-<>"),
  blocks = chars("▁▂▃▄▅▆▇█"),
  shades = chars("░▒▓█"),
  ascii = chars(".:-=+*#%@"),
  dots = chars("·•∙●"),
  box = chars("─│┌┐└┘├┤┬┴┼"),
  braille = BRAILLE,
  sprites = chars("☺☻♟♙⚙☕✎⌨▣▤▥▦▧▨▩♥★✦✧⚡☁☂☀☾"),
  tree = chars("│┃╱╲╭╮╯╰Yyv^♠♣*°•"),
}
sbg.hash = function(s)
  s = tostring(s)
  local h = 2166136261
  for i = 1, #s do
    h = (h ~ s:byte(i)) * 16777619 % 4294967296
  end
  return math.floor(h)
end
sbg.pick = function(list, key)
  if type(list) ~= "table" or #list == 0 then return nil end
  return list[(sbg.hash(key) % #list) + 1]
end
local CLOCK = 0.0
sbg.time = function() return CLOCK end

-- ---------- fx ----------
local Fx = {}
Fx.__index = Fx
local function mkfx(w, h)
  return setmetatable({ w = w, h = h, cells = {}, n = 0 }, Fx)
end
function Fx:put(x, y, ch, r, g, b)
  if type(x) ~= "number" or type(y) ~= "number" then return end
  x, y = math.floor(x), math.floor(y)
  if x < 0 or y < 0 or x >= self.w or y >= self.h then return end
  if type(ch) ~= "string" then return end
  local ok, len = pcall(utf8.len, ch)
  if not ok or len ~= 1 then
    error("fx:put got a non-single-character glyph: " .. string.format("%q", ch))
  end
  if type(r) ~= "number" or type(g) ~= "number" or type(b) ~= "number" then return end
  self.n = self.n + 1
  self.cells[y * self.w + x] = { ch = ch, r = clamp(r, 0, 1), g = clamp(g, 0, 1), b = clamp(b, 0, 1) }
end
function Fx:clear() self.cells = {}; self.n = 0 end
function Fx:count() return self.n end
function Fx:size() return self.w, self.h end
function Fx:unique()
  local u = 0
  for _ in pairs(self.cells) do u = u + 1 end
  return u
end
sbg.text = function(fx, x, y, str, r, g, b)
  if type(str) ~= "string" then return 0 end
  local n = 0
  local i = 0
  for _, c in utf8.codes(str) do
    local ch = utf8.char(c)
    if ch ~= " " then
      fx:put(x + i, y, ch, r, g, b)
      n = n + 1
    end
    i = i + 1
  end
  return n
end
sbg.text_center = function(fx, y, str, r, g, b)
  local w = select(1, fx:size())
  local len = utf8.len(str) or #str
  return sbg.text(fx, math.floor((w - len) / 2), y, str, r, g, b)
end

-- ---------- sandbox ----------
local function sandbox()
  return {
    math = math, string = string, table = table, select = select,
    ipairs = ipairs, pairs = pairs, next = next, type = type,
    tostring = tostring, tonumber = tonumber, error = error, assert = assert,
    pcall = pcall, setmetatable = setmetatable, unpack = table.unpack, sbg = sbg,
  }
end

-- ---------- scenarios ----------
local function journey(tools, opts)
  opts = opts or {}
  local files = opts.files or { py = math.floor(tools / 4), rs = math.floor(tools / 7), ts = math.floor(tools / 9), md = math.floor(tools / 20) }
  local recent = {}
  local kinds = { "exec", "edit", "read", "web", "task", "mcp", "other" }
  local n = math.min(64, tools)
  for i = 1, n do
    recent[i] = {
      t = CLOCK - (n - i) * 1.5,
      k = (opts.errors and opts.errors > 0 and i % 11 == 0) and "error" or "tool",
      tool = "Tool" .. i,
      ext = ({ "py", "rs", "ts", "md" })[(i % 4) + 1],
    }
  end
  if opts.errors and opts.errors > 0 and n > 0 then
    recent[n] = { t = CLOCK - 0.5, k = "error", tool = "Bash", ext = "py" }
  end
  return {
    started_at = CLOCK - tools * 12,
    repo = opts.repo or "session-bg",
    prompts = math.floor(tools / 8) + (tools > 0 and 1 or 0),
    tools = tools,
    tool_kinds = { exec = math.floor(tools * 0.3), edit = math.floor(tools * 0.25),
      read = math.floor(tools * 0.2), web = math.floor(tools * 0.05),
      task = math.floor(tools * 0.05), mcp = math.floor(tools * 0.05),
      other = math.floor(tools * 0.1) },
    files = files,
    errors = opts.errors or 0,
    compactions = math.floor(tools / 120),
    waits = math.floor(tools / 15),
    subagents = opts.subagents or 0,
    subagents_peak = math.max(opts.subagents or 0, math.floor(tools / 100)),
    last_prompt = opts.prompt or "make the forest sway in the wind and grow a skyline",
    words = { forest = 3, skyline = 2, grow = 4 },
    recent = recent,
  }
end

local STORY_KINDS = { "edit", "read", "exec", "web", "mcp", "other", "task" }
local function story(tools, opts)
  opts = opts or {}
  local j = journey(tools, opts)
  local events = { { kind = "embark" } }
  for i = 1, tools do
    local kind = STORY_KINDS[(i - 1) % #STORY_KINDS + 1]
    events[#events + 1] = { kind = "tool", payload = { kind = kind, ext = "lua" } }
    events[#events + 1] = { kind = "success", payload = { kind = kind } }
  end
  for _, e in ipairs(opts.tail or {}) do events[#events + 1] = e end
  local recent = {}
  for seq = math.max(1, #events - 63), #events do
    recent[#recent + 1] = { seq = seq, kind = events[seq].kind, tick = seq * 3, payload = events[seq].payload or {} }
  end
  j.schema_version, j.seq, j.tick, j.recent = 2, #events, #events * 3, recent
  return j
end

local function mkstate(mode, j, opts)
  opts = opts or {}
  return {
    mode = mode,
    tool = opts.tool or "Bash",
    tool_kind = opts.tool_kind or "exec",
    agent = "claude",
    context_pct = opts.context_pct or 42,
    cost = 1.5,
    model = "opus",
    prompt = j.last_prompt,
    age = opts.age or 3.0,
    changed = false,
    duration = 1800,
    lines_added = opts.lines_added or (j.tools * 7),
    lines_removed = opts.lines_removed or (j.tools * 3),
    journey = j,
    mood = opts.mood,
    mod = { speed = 1.0, density = 1.0, hue = 0.0, bright = 1.0, burst = opts.burst or 0.0 },
    params = { density = 1.0, scene = opts.scene or "settlement" },
  }
end

-- ---------- runner ----------
local function run(path, scen, W, H, frames, capture)
  CLOCK = 1000.0
  local env = sandbox()
  local chunk = assert(loadfile(path, "t", env))
  chunk()
  local ctx = { w = W, h = H, seed = 1337, density = 1.0, fps = FPS }
  assert(env.init, "no init in " .. path)(ctx)
  local fx = mkfx(W, H)
  local dt = 1.0 / FPS
  local maxcov, maxraw = 0, 0
  for f = 1, frames do
    CLOCK = CLOCK + dt
    local st = mkstate(scen.mode(f), scen.j, scen.opts)
    st.changed = (f == 1) or (f % 17 == 0)
    if scen.mutate then scen.mutate(st, f) end
    if env.step then env.step(dt, st) end
    fx:clear()
    if env.render then env.render(fx, st) end
    local u = fx:unique()
    maxcov = math.max(maxcov, u / (W * H))
    maxraw = math.max(maxraw, fx:count() / (W * H))
  end
  if capture then
    local out = {}
    for y = 0, H - 1 do
      local row = {}
      for x = 0, W - 1 do
        local c = fx.cells[y * W + x]
        row[#row + 1] = c and c.ch or " "
      end
      out[#out + 1] = (table.concat(row):gsub("%s+$", ""))
    end
    return maxcov, maxraw, table.concat(out, "\n")
  end
  return maxcov, maxraw
end

return { mkfx = mkfx, sandbox = sandbox, run = run, journey = journey, story = story, mkstate = mkstate, sbg = sbg }
