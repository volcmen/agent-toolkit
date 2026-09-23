local HERE = (arg[0]:match("(.*/)") or "./")
local Hn = dofile(HERE .. "../harness.lua")
local Glyphs = assert(loadfile(HERE .. "../../../plugins/fx/fortress/glyphs.lua", "t", Hn.sandbox()))()
local SEED = tonumber(os.getenv("GLYPHS_SEED")) or (os.time() ~ math.floor(os.clock() * 1e9))
math.randomseed(SEED)
local tests = 0
local function check(ok, message, input)
  if not ok then
    error(string.format("%s (GLYPHS_SEED=%d input=%q)", message, SEED, tostring(input)), 2)
  end
  tests = tests + 1
end
local function codepoint()
  local band = math.random(4)
  if band == 1 then return math.random(0x80, 0x7ff) end
  if band == 2 then
    local c = math.random(0x800, 0xfffd)
    return (c >= 0xd800 and c <= 0xdfff) and 0x2500 or c
  end
  if band == 3 then return math.random(0x10000, 0x10ffff) end
  return ({ 0x2302, 0x2387, 0x25b0, 0x25c9, 0x263b, 0x2659, 0x28ff, 0xa4 })[math.random(8)]
end
local PIECES = {
  function() return string.char(math.random(32, 126)) end,
  function() return string.char(math.random(0, 31)) end,
  function() return "\127" end,
  function() return utf8.char(codepoint()) end,
  function() return string.char(math.random(128, 255)) end,
  function() return utf8.char(codepoint()):sub(1, -2) end,
  function() return string.char(237, math.random(160, 191), math.random(128, 191)) end,
  function() return string.char(224, math.random(128, 159), math.random(128, 191)) end,
  function() return string.char(math.random(192, 193), math.random(128, 191)) end,
  function() return string.char(244, math.random(144, 191), math.random(128, 191), math.random(128, 191)) end,
  function() return string.char(240, math.random(128, 143), math.random(128, 191), math.random(128, 191)) end,
}
local function arbitrary()
  local out = {}
  for _ = 1, math.random(0, 24) do out[#out + 1] = PIECES[math.random(#PIECES)]() end
  return table.concat(out)
end
local function wellformed()
  local out = {}
  for _ = 1, math.random(0, 24) do out[#out + 1] = PIECES[({ 1, 2, 3, 4 })[math.random(4)]]() end
  return table.concat(out)
end
local function printable(s)
  for c in s:gmatch(".") do if c:byte() < 32 or c:byte() == 127 then return false end end
  return true
end

for _ = 1, 3000 do
  local s = arbitrary()
  local cells = Glyphs.chars(s)
  for _, c in ipairs(cells) do check(utf8.len(c) == 1, "every cell is one valid code point", s) end
  check(utf8.len(table.concat(cells)) ~= nil, "decoded text is valid UTF-8", s)
  check(Glyphs.len(s) == #cells, "len counts decoded cells", s)
end

for _ = 1, 3000 do
  local s = arbitrary()
  local cells = Glyphs.chars(s)
  local count, text = #cells, table.concat(cells)
  cells[1], cells[count + 1] = "!", "!"
  check(Glyphs.len(s) == count and table.concat(Glyphs.chars(s)) == text, "chars returns an independent copy", s)
end

for _ = 1, 3000 do
  local s = wellformed()
  check(table.concat(Glyphs.chars(s)) == s, "well-formed text round-trips", s)
  check(Glyphs.len(s) == utf8.len(s), "len matches the UTF-8 oracle", s)
end

local function ascii(cells)
  local out = {}
  for _, c in ipairs(cells) do if #c == 1 and c ~= "?" then out[#out + 1] = c end end
  return table.concat(out)
end
for _ = 1, 3000 do
  local s = arbitrary()
  check(ascii(Glyphs.chars(s)) == s:gsub("[^\0-\127]", ""):gsub("%?", ""), "invalid bytes never swallow ASCII", s)
end

for _ = 1, 3000 do
  local s = arbitrary()
  local clean = Glyphs.clean(s)
  check(printable(clean), "clean drops control characters", s)
  check(utf8.len(clean) ~= nil, "clean text is valid UTF-8", s)
  check(Glyphs.clean(clean) == clean, "clean is idempotent", s)
  local kept = {}
  for _, c in ipairs(Glyphs.chars(s)) do if printable(c) then kept[#kept + 1] = c end end
  check(clean == table.concat(kept), "clean keeps every printable cell in order", s)
end

for _ = 1, 3000 do
  local s, n = arbitrary(), math.random(0, 30)
  local ellipsis = ({ "...", Glyphs.unicode.ellipsis, Glyphs.ascii.ellipsis })[math.random(3)]
  local clean = Glyphs.chars(Glyphs.clean(s))
  local clipped = Glyphs.chars(Glyphs.clip(s, n, ellipsis))
  local tail = Glyphs.chars(ellipsis)
  check(#clipped == math.min(n, #clean), "clip fills exactly the smaller of width and text", s)
  local keep = #clean <= n and #clean or (n >= #tail + 1 and n - #tail or n)
  for i = 1, keep do check(clipped[i] == clean[i], "clip keeps a prefix of the clean text", s) end
  if #clean > n and n >= #tail + 1 then
    check(table.concat(clipped, "", keep + 1) == ellipsis, "overflow ends with the ellipsis", s)
  end
end

local function shape(value) return type(value) == "table" and #value or 1 end
for key, value in pairs(Glyphs.unicode) do
  check(Glyphs.ascii[key] ~= nil, "ascii vocabulary covers " .. key, key)
  check(shape(Glyphs.ascii[key]) == shape(value), "ascii vocabulary matches the shape of " .. key, key)
end
for key in pairs(Glyphs.ascii) do check(Glyphs.unicode[key] ~= nil, "unicode vocabulary covers " .. key, key) end
local function each(vocabulary, visit)
  for key, value in pairs(vocabulary) do
    for _, glyph in ipairs(type(value) == "table" and value or { value }) do visit(key, glyph) end
  end
end
each(Glyphs.unicode, function(key, glyph)
  check(utf8.len(glyph) == 1, "unicode glyph is one code point: " .. key, glyph)
end)
each(Glyphs.ascii, function(key, glyph)
  check(glyph:match("^[!-~]+$") ~= nil, "ascii glyph is printable ASCII: " .. key, glyph)
  check(key == "ellipsis" or #glyph == 1, "ascii glyph is one cell: " .. key, glyph)
  check(glyph ~= "?", "ascii glyphs leave ? to the host substitution: " .. key, glyph)
end)
check(Glyphs.vocabulary("ascii") == Glyphs.ascii, "ascii mode selects the ascii vocabulary", "ascii")
check(Glyphs.vocabulary("unicode") == Glyphs.unicode, "unicode mode selects the unicode vocabulary", "unicode")
check(Glyphs.vocabulary(arbitrary()) == Glyphs.unicode, "unknown modes select the unicode vocabulary", "mode")

print("glyphs ok (" .. tests .. " checks, GLYPHS_SEED=" .. SEED .. ")")
