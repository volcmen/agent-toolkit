local Glyphs = {}
local function width(a)
  if a < 128 then return 1 end
  if a >= 194 and a <= 223 then return 2 end
  if a >= 224 and a <= 239 then return 3 end
  if a >= 240 and a <= 244 then return 4 end
  return 0
end
local function valid(s, i, n)
  local a, b = s:byte(i, i + 1)
  if n == 1 then return true end
  if n == 0 or i + n - 1 > #s then return false end
  for k = i + 1, i + n - 1 do
    local c = s:byte(k)
    if c < 128 or c > 191 then return false end
  end
  if a == 224 then return b >= 160 end
  if a == 237 then return b < 160 end
  if a == 240 then return b >= 144 end
  if a == 244 then return b < 144 end
  return true
end
local SPLIT_LIMIT = 512
local split_cache, split_count = {}, 0
local function split(s)
  local hit = split_cache[s]
  if hit then return hit end
  local out, i = {}, 1
  while i <= #s do
    local n = width(s:byte(i))
    if valid(s, i, n) then
      out[#out + 1] = s:sub(i, i + n - 1); i = i + n
    else
      out[#out + 1] = "?"; i = i + 1
    end
  end
  if split_count >= SPLIT_LIMIT then split_cache, split_count = {}, 0 end
  split_cache[s], split_count = out, split_count + 1
  return out
end
function Glyphs.chars(s)
  local cells = split(tostring(s or ""))
  return table.move(cells, 1, #cells, 1, {})
end
function Glyphs.len(s)
  return #split(tostring(s or ""))
end
function Glyphs.clean(s)
  local out = {}
  for _, c in ipairs(split(tostring(s or ""))) do
    if c:byte(1) >= 32 and c ~= "\127" then out[#out + 1] = c end
  end
  return table.concat(out)
end
function Glyphs.clip(s, n, ellipsis)
  local cells = split(Glyphs.clean(s))
  n = math.max(0, math.floor(n))
  if #cells <= n then return table.concat(cells) end
  local tail = split(tostring(ellipsis or "..."))
  if n < #tail + 1 then return table.concat(cells, "", 1, n) end
  return table.concat(cells, "", 1, n - #tail) .. table.concat(tail)
end
Glyphs.unicode = {
  wall = "║", roof = "═", slab = "─", corner_tl = "╔", corner_tr = "╗", corner_bl = "╚", corner_br = "╝",
  joint_l = "╟", joint_r = "╢", ladder = "╫", rail = "╎", car = "◘", sign_l = "▐", sign_r = "▌",
  strip_l = "▌", strip_r = "▐", strip_sep = "│", antenna = "┼", mast = "│",
  monitor = "▣", keyboard = "⌨", board = "▤", rack = "▦", shelf = "▥", couch = "▄", coffee = "▙",
  steam = "°", plant = "♣", tree = "♠", umbrella = "☂", window_day = "☼", window_night = "☾",
  door = "▐", led = "∙", staff = "☻", contractor = "♙", idle = "☺",
  edit = "◆", read = "◇", exec = "■", web = "○", bug = "¤", prompt = "✦",
  thinking = "⋯", done = "✓", failed = "✗", lamp = "◉", full = "▰", empty = "▱",
  repo = "⌂", branch = "⎇", ellipsis = "⋯", dot = "·",
  spark = { "⡀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿" },
}
Glyphs.ascii = {
  wall = "|", roof = "=", slab = "-", corner_tl = "+", corner_tr = "+", corner_bl = "+", corner_br = "+",
  joint_l = "+", joint_r = "+", ladder = "H", rail = ":", car = "#", sign_l = "[", sign_r = "]",
  strip_l = "[", strip_r = "]", strip_sep = "|", antenna = "+", mast = "|",
  monitor = "#", keyboard = "=", board = "=", rack = "H", shelf = "%", couch = "_", coffee = "c",
  steam = "'", plant = "*", tree = "^", umbrella = "T", window_day = "o", window_night = "c",
  door = "]", led = ".", staff = "@", contractor = "&", idle = "@",
  edit = "*", read = "r", exec = "$", web = "o", bug = "x", prompt = "+",
  thinking = "~", done = "v", failed = "x", lamp = "*", full = "#", empty = "-",
  repo = "~", branch = "Y", ellipsis = "...", dot = "-",
  spark = { "_", ".", ",", "-", "~", "=", "+", "#" },
}
function Glyphs.vocabulary(mode)
  return mode == "ascii" and Glyphs.ascii or Glyphs.unicode
end
return Glyphs
