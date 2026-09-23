-- Presentation-only session plaque: mode label, milestone toasts, context meter and progress line.
-- It reads live state and never touches simulation history.
local Plaque = {}
Plaque.__index = Plaque
Plaque.SLOT = 4
local SPIN = { "|", "/", "-", "\\" }
local function jnum(v) return tonumber(v) or 0 end
local function jstr(v) if type(v) == "string" and v ~= "" then return v end return nil end
local function crossed(prev, cur, span) return cur > prev and math.floor(cur / span) > math.floor(prev / span) end
local function snapshot(state)
  local j = state.journey or {}
  return {
    name = jstr(state.session_name) or jstr(j.session_name) or "",
    tools = jnum(j.tools), prompts = jnum(j.prompts), errors = jnum(j.errors),
    compactions = jnum(j.compactions), subagents = jnum(j.subagents),
    lines = jnum(state.lines_added), removed = jnum(state.lines_removed), pct = jnum(state.context_pct),
  }
end
function Plaque.new()
  return setmetatable({ t = 0, seen = false, toasts = {}, flash = {}, renamed_at = -100, pulse_at = -100 }, Plaque)
end
function Plaque:toast(text, colour)
  self.toasts[#self.toasts + 1] = { text = text, colour = colour or "amber" }
  if #self.toasts > 6 then table.remove(self.toasts, 1) end
end
function Plaque:step(dt, state)
  self.t = self.t + math.max(0, dt)
  local now = snapshot(state)
  local head = self.toasts[1]
  if head then
    head.at = head.at or self.t
    if self.t - head.at >= Plaque.SLOT then table.remove(self.toasts, 1) end
  end
  local seen = self.seen
  self.seen = now
  if not seen then return end
  if now.name ~= seen.name and seen.name ~= "" then self.renamed_at = self.t; self:toast("* renamed") end
  if crossed(seen.tools, now.tools, 25) then self:toast(string.format("* %d tools", now.tools // 25 * 25)) end
  if crossed(seen.lines, now.lines, 250) then self:toast(string.format("* +%d lines", now.lines // 250 * 250), "green") end
  for _, mark in ipairs({ 25, 50, 75, 90 }) do
    if seen.pct < mark and now.pct >= mark then
      self.pulse_at = self.t
      self:toast(string.format("* context %d%%", mark), mark >= 75 and "red" or "amber")
    end
  end
  if now.compactions > seen.compactions then self:toast("* compacted", "violet") end
  if now.subagents > seen.subagents then self:toast("* helper joins", "green")
  elseif now.subagents < seen.subagents then self:toast("* helper returns") end
  if now.prompts > seen.prompts then self:toast(string.format("* chapter %d", now.prompts)) end
  if now.errors > seen.errors then self:toast(string.format("! error %d", now.errors), "red") end
  for _, key in ipairs({ "tools", "lines", "removed" }) do
    if now[key] ~= seen[key] then self.flash[key] = self.t end
  end
end
function Plaque:hot(key) local at = self.flash[key]; return at ~= nil and self.t - at < 2 end
-- Texts for the renderer; `width` is the edge strip the HUD may use.
function Plaque:hud(state, width, quiet)
  local now = self.seen or snapshot(state)
  local t = quiet and 0 or self.t
  local tick = math.floor(t * 2)
  local mode, age = jstr(state.mode) or "idle", jnum(state.age)
  local label, colour = mode, "neutral"
  if mode == "thinking" then label = "thinking" .. (quiet and "" or string.rep(".", tick % 4))
  elseif mode == "tool" then
    label, colour = (quiet and "" or SPIN[math.floor(t * 8) % 4 + 1] .. " ") .. (jstr(state.tool) or jstr(state.tool_kind) or "tool"), "amber"
  elseif mode == "waiting" then label, colour = (tick % 2 == 0 and "waiting ?" or "waiting"), "amber"
  elseif mode == "error" then label, colour = "error !", ((quiet or age < 3) and "red" or "wall")
  elseif mode == "compacting" then label, colour = "compacting " .. string.rep("~", tick % 3 + 1), "violet"
  elseif mode == "idle" then label, colour = (age > 60 and ("idle " .. string.rep("z", tick % 3 + 1)) or "idle"), "wall"
  elseif mode == "start" then label = "session start"
  elseif mode == "end" then label = "session end" end
  local head = self.toasts[1]
  if head and head.at and mode~='waiting' and mode~='error' then label, colour = head.text, head.colour end
  local meter, meter_colour, meter_bright = nil, nil, 1
  if now.pct > 0 then
    local pct = math.min(100, now.pct)
    local percent=string.format('%d%%',math.floor(pct))
    local inner=width-7-#percent
    if inner>=2 then
      local fill = math.floor(inner * pct / 100 + 0.5)
      meter = string.format("ctx [%s%s] %s", string.rep("=", fill), string.rep("-", inner - fill), percent)
    else meter=width>=#percent+4 and 'ctx '..percent or (width>=#percent and percent or nil) end
    meter_colour = pct >= 90 and "red" or (pct >= 60 and "amber" or "green")
    if not quiet and t - self.pulse_at < 3 then meter_bright = 1.3 + 0.3 * math.sin(t * 6) end
  end
  local function number(n)
    if n>=1000000 then return string.format('%.1fm',n/1000000) end
    if n>=10000 then return string.format('%.1fk',n/1000) end
    return tostring(math.floor(n))
  end
  local progress=''
  for _,candidate in ipairs({string.format('%d tools +%d/-%d',now.tools,now.lines,now.removed),
      string.format('%st +%s/-%s',number(now.tools),number(now.lines),number(now.removed)),
      number(now.tools)..' tools',number(now.tools)..'t'}) do
    if #candidate<=width then progress=candidate; break end
  end
  return {
    label = label, colour = colour,
    meter = meter, meter_colour = meter_colour, meter_bright = meter_bright,
    progress = progress, progress_bright = not quiet and (self:hot("tools") or self:hot("lines") or self:hot("removed")) and 1.7 or 1,
    title_hot = not quiet and t - self.renamed_at < 3,
  }
end
return Plaque
