-- Pure, bounded event simulation. No renderer, host time, I/O, or shared RNG.
local Sim = {}
Sim.__index = Sim
Sim.VERSION = 2
Sim.CAPS = { dwarves=12, rooms=48, items=96, jobs=32, incidents=8, artifacts=16, legends=128, announcements=16 }
local KINDS = {"exec", "edit", "read", "web", "task", "mcp", "other"}
local SKILLS = {"plan", "exec", "edit", "read", "trade", "craft"}
local COUNTERS = {"prompts", "tools", "errors", "compactions", "waits", "subagents", "subagents_peak"}
local NEEDS = {"rest", "craft", "knowledge", "fellowship"}
local PREFIX = {"Ember", "Moss", "Copper", "Slate", "Quiet", "Silver", "Amber", "River"}
local SUFFIX = {"hold", "deep", "gate", "hall", "reach", "haven"}
local FIRST = {"Ari", "Bera", "Corin", "Dena", "Evan", "Fenn", "Galen", "Hali"}
local LAST = {"Copperhand", "Mosskeeper", "Slatewright", "Riverward", "Ashweaver", "Brightpick"}
local function num(v) return math.max(0, math.floor(tonumber(v) or 0)) end
local function clone(v)
  if type(v) ~= "table" then return v end
  local o = {}; for k,x in pairs(v) do o[k] = clone(x) end; return o
end
function Sim.hash(text)
  local h = 5381
  text = tostring(text)
  for i=1,#text do h = (h * 33 + text:byte(i)) % 2147483647 end
  return h
end
function Sim.roll(seed, seq, tag, n)
  return Sim.hash(tostring(seed)..":"..tostring(seq)..":"..tag) % n + 1
end
function Sim.safe(word, fallback)
  if type(word) ~= "string" or #word < 4 or #word > 16 or not word:match("^[a-z]+$") then return fallback or "craft" end
  for _,bad in ipairs({"secret", "password", "token", "apikey", "bearer", "credential"}) do
    if word:find(bad, 1, true) then return fallback or "craft" end
  end
  return word
end
function Sim.digest(c)
  local parts = {}
  for _,k in ipairs(COUNTERS) do parts[#parts+1] = tostring(num(c[k])) end
  for _,k in ipairs(KINDS) do parts[#parts+1] = tostring(num((c.tool_kinds or {})[k])) end
  return table.concat(parts, ":")
end
function Sim.canonical(v)
  if type(v) ~= "table" then return type(v)..":"..tostring(v) end
  local keys, out = {}, {}
  for k in pairs(v) do keys[#keys+1] = k end
  table.sort(keys, function(a,b) return tostring(a)<tostring(b) end)
  for _,k in ipairs(keys) do out[#out+1] = tostring(k).."="..Sim.canonical(v[k]) end
  return "{"..table.concat(out,";").."}"
end
function Sim:hash_state() return Sim.hash(Sim.canonical(self:snapshot())) end
function Sim:title(xp)
  local title = "Novice"
  for _,v in ipairs({{5,"Adequate"},{20,"Skilled"},{80,"Expert"},{320,"Legendary"}}) do
    if xp >= v[1] then title = v[2] end
  end
  return title
end
function Sim:id() self.next_id=self.next_id+1; return self.next_id end
function Sim:legend(kind, text, ref, priority)
  local e = {id=self:id(), seq=self.seq, tick=self.clock, year=self.year, kind=kind,
    text=text, ref=ref or 0, priority=priority or 1}
  self.legends[#self.legends+1]=e
  if #self.legends > Sim.CAPS.legends then
    local old=table.remove(self.legends,1)
    self.summary[old.kind]=(self.summary[old.kind] or 0)+1
    self.evicted=self.evicted+1
    self.evicted_through=old.id
  end
  if e.priority>1 or self.clock-self.last_announcement>=80 then
    if e.priority<=1 then self.last_announcement=self.clock end
    if not self.announcement or e.priority>self.announcement.priority then
      self.announcement=clone(e); self.announcement_until=self.clock+16
    else
      self.announcements[#self.announcements+1]=clone(e)
      table.sort(self.announcements,function(a,b)
        if a.priority~=b.priority then return a.priority>b.priority end
        return a.id<b.id
      end)
      if #self.announcements>Sim.CAPS.announcements then table.remove(self.announcements) end
    end
  end
  return e.id
end
function Sim:dwarf(role)
  local id=self:id()
  local skills,needs={},{}
  for _,k in ipairs(SKILLS) do skills[k]=0 end
  for _,k in ipairs(NEEDS) do needs[k]=0 end
  local d={id=id, name=FIRST[Sim.roll(self.seed,id,"first",#FIRST)].." "..LAST[Sim.roll(self.seed,id,"last",#LAST)],
    role=role, skills=skills, needs=needs, mood="content", home=1, job=0}
  self.dwarves[#self.dwarves+1]=d
  return d
end
function Sim:room(kind)
  if #self.rooms >= Sim.CAPS.rooms then return self.rooms[#self.rooms] end
  local r={id=self:id(), kind=kind, z=self.z, level=1, theme="stone", engraving=""}
  self.rooms[#self.rooms+1]=r
  return r
end
function Sim.new(seed, identity)
  local s=setmetatable({schema_version=Sim.VERSION, seed=seed, identity=identity or tostring(seed),
    seq=0, clock=0, next_id=0, year=1, z=0, stress=0, wealth=0, quarry=0,
    profile="classic", subject="craft", material="stone", crew=0, store=0,
    dwarves={}, rooms={}, items={}, jobs={}, incidents={}, artifacts={}, legends={}, summary={},
    announcements={}, announcement=false, announcement_until=0, last_announcement=-80,
    evicted=0, evicted_through=0, failures={}, cooldown=0, last_artifact=-6000,
    counts={prompts=0,tools=0,errors=0,compactions=0,waits=0,subagents=0,subagents_peak=0,tool_kinds={}},
    mood_arc=false, cave_until=0, gap_to=0, last_routine=-80},Sim)
  for _,k in ipairs(KINDS) do s.counts.tool_kinds[k]=0 end
  s.name=PREFIX[Sim.roll(seed,0,"fortress-prefix",#PREFIX)]..SUFFIX[Sim.roll(seed,0,"fortress-suffix",#SUFFIX)]
  s:dwarf("founder"); s:room("plan"); s:room("workshop"); s:room("rest")
  return s
end
function Sim:snapshot()
  local o={}; for k,v in pairs(self) do o[k]=clone(v) end; return o
end
function Sim.restore(data, identity)
  if type(data)~="table" or data.schema_version~=Sim.VERSION or data.identity~=identity then return nil end
  local function finite(v) return type(v)=="number" and v==v and v>=0 and v<9007199254740991 end
  for _,k in ipairs({"seed","clock","seq","next_id","year","z","stress","wealth","quarry","crew","store","evicted","evicted_through","cooldown","cave_until","gap_to"}) do
    if not finite(data[k]) then return nil end
  end
  if type(data.name)~="string" or #data.name>24 or not data.name:match("^[A-Za-z][A-Za-z -]+$") then return nil end
  if type(data.counts)~="table" or type(data.counts.tool_kinds)~="table" or type(data.summary)~="table" or type(data.failures)~="table" or #data.failures>6 then return nil end
  for _,k in ipairs(COUNTERS) do if not finite(data.counts[k]) then return nil end end
  for _,k in ipairs(KINDS) do if not finite(data.counts.tool_kinds[k]) then return nil end end
  for k,cap in pairs(Sim.CAPS) do if type(data[k])~="table" or #data[k]>cap then return nil end end
  if #data.dwarves<1 or #data.rooms<1 then return nil end
  if data.announcement~=false and (type(data.announcement)~="table" or not finite(data.announcement.priority) or type(data.announcement.text)~="string" or not finite(data.announcement_until) or data.announcement_until<data.clock) then return nil end
  if type(data.last_announcement)~="number" then return nil end
  for _,d in ipairs(data.dwarves) do
    if type(d)~="table" or not finite(d.id) or type(d.name)~="string" or not finite(d.job) or type(d.skills)~="table" or type(d.needs)~="table" then return nil end
    for _,k in ipairs(SKILLS) do if not finite(d.skills[k]) then return nil end end
    for _,k in ipairs(NEEDS) do if not finite(d.needs[k]) then return nil end end
  end
  for _,r in ipairs(data.rooms) do
    if type(r)~="table" or not finite(r.id) or type(r.kind)~="string" or type(r.engraving)~="string" or not finite(r.level) then return nil end
  end
  for _,e in ipairs(data.incidents) do if type(e)~="table" or not finite(e.expires) or e.expires<data.clock or type(e.kind)~="string" then return nil end end
  for _,j in ipairs(data.jobs) do if type(j)~="table" or not finite(j.id) or not finite(j.expires) or not finite(j.target) or type(j.kind)~="string" then return nil end end
  for _,e in ipairs(data.legends) do if type(e)~="table" or not finite(e.tick) or type(e.text)~="string" or not finite(e.priority) then return nil end end
  if data.mood_arc~=false and (type(data.mood_arc)~="table" or not finite(data.mood_arc.expires) or data.mood_arc.expires<data.clock) then return nil end
  -- Remaining compatibility errors are contained by pcall in the adapter.
  return setmetatable(clone(data),Sim)
end
function Sim:close_incident(index, message)
  local e=table.remove(self.incidents,index)
  if e then self:legend(e.kind.."_close",message,e.open,3) end
end
function Sim:incident(kind, duration, text, severity)
  for _,e in ipairs(self.incidents) do if e.kind==kind then return e end end
  if #self.incidents>=Sim.CAPS.incidents then self:close_incident(1,"The watch stands down.") end
  local e={id=self:id(),kind=kind,severity=severity or 1,expires=self.clock+duration,opened=self.clock}
  e.open=self:legend(kind.."_open",text,0,kind=="ambush" and 5 or 3)
  self.incidents[#self.incidents+1]=e
  return e
end
function Sim:expire(target)
  -- Resolve timed arcs at their own tick, independent of delivery batch size.
  while true do
    local next_tick=target+1
    for _,e in ipairs(self.incidents) do next_tick=math.min(next_tick,e.expires) end
    if self.mood_arc then next_tick=math.min(next_tick,self.mood_arc.expires) end
    if self.announcement then next_tick=math.min(next_tick,self.announcement_until) end
    if next_tick>target then break end
    self.clock=next_tick
    if self.announcement and self.announcement_until<=next_tick then
      self.announcement=table.remove(self.announcements,1) or false
      self.announcement_until=self.announcement and next_tick+16 or 0
    end
    for i=#self.incidents,1,-1 do
      local e=self.incidents[i]
      if e.expires<=next_tick then
        local msg=e.kind=="caravan" and "The caravan departs; its findings join the archive." or
          e.kind=="mandate" and "The mandate lapses without a recorded decision." or "The watch stands down."
        if e.kind=="ambush" then self.cooldown=next_tick+120 end
        self:close_incident(i,msg)
      end
    end
    if self.mood_arc and self.mood_arc.expires<=next_tick then
      local arc=self.mood_arc; self.mood_arc=false
      local a={id=self:id(),name=arc.name,quality=arc.quality,room=arc.room,tick=next_tick,seq=arc.seq,parent=arc.parent}
      self.artifacts[#self.artifacts+1]=a
      self.last_artifact=next_tick
      local line=arc.dwarf.." has completed a masterwork: "..a.name.."."
      if #self.artifacts>1 then line=line.." Its patterns recall "..self.artifacts[#self.artifacts-1].name.."." end
      self:legend("artifact",line,arc.open,6)
    end
  end
end
function Sim:advance(target)
  target=math.max(self.clock,num(target))
  local elapsed=target-self.clock
  self:expire(target)
  self.clock=target
  self.stress=math.max(0,self.stress-elapsed/8)
  for i=#self.jobs,1,-1 do
    if self.jobs[i].expires<=target then
      local id=self.jobs[i].id
      for _,d in ipairs(self.dwarves) do if d.job==id then d.job=0 end end
      table.remove(self.jobs,i)
    else
      self.jobs[i].progress=math.max(0,math.min(1,(target-self.jobs[i].expires+24)/24))
    end
  end
  for _,d in ipairs(self.dwarves) do
    for _,k in ipairs(NEEDS) do d.needs[k]=math.max(0,d.needs[k]-elapsed/16) end
    d.mood=self.stress>12 and "strained" or (d.job~=0 and "focused" or "content")
    if self.mood_arc and d.name==self.mood_arc.dwarf then d.mood="inspired" end
  end
end
function Sim:tick(n) self:advance(self.clock+num(n)) end
function Sim:job(kind)
  local d=self.dwarves[1]
  for _,v in ipairs(self.dwarves) do if v.skills[kind]>d.skills[kind] then d=v end end
  for i=#self.jobs,1,-1 do if self.jobs[i].owner==d.id then table.remove(self.jobs,i) end end
  d.skills[kind]=d.skills[kind]+1
  for _,threshold in ipairs({5,20,80,320}) do
    if d.skills[kind]==threshold then
      local role=({plan="Planner",exec="Mechanic",edit="Mason",read="Archivist",trade="Broker",craft="Engraver"})[kind]
      self:legend("skill",d.name.." becomes a "..self:title(threshold).." "..role..".",0,2)
    end
  end
  local job={id=self:id(),kind=kind,owner=d.id,target=1+(self.counts.tools % #self.rooms),
    source_seq=self.seq,progress=0,expires=self.clock+24}
  self.jobs[#self.jobs+1]=job; d.job=job.id
  d.mood="focused"; d.needs.rest=math.min(100,d.needs.rest+2)
  d.needs.knowledge=math.min(100,d.needs.knowledge+1)
  d.needs.craft=math.min(100,d.needs.craft+1)
  d.needs.fellowship=math.min(100,d.needs.fellowship+1)
  d.needs[kind=="read" and "knowledge" or "craft"]=0
  if #self.jobs>Sim.CAPS.jobs then table.remove(self.jobs,1) end
end
function Sim:population(count, silent)
  count=num(count)
  self.crew=math.max(0,count+1-Sim.CAPS.dwarves)
  while #self.dwarves<math.min(Sim.CAPS.dwarves,count+1) do
    local d=self:dwarf("resident")
    if not silent then self:legend("migrant",d.name.." arrives to work below.",0,4) end
  end
  while #self.dwarves>count+1 do
    local d=table.remove(self.dwarves)
    for i=#self.jobs,1,-1 do if self.jobs[i].owner==d.id then table.remove(self.jobs,i) end end
    if not silent then self:legend("departure",d.name.." departs; the work is remembered.",0,4) end
  end
end
function Sim:inspire()
  if self.mood_arc or #self.artifacts>=Sim.CAPS.artifacts or self.clock-self.last_artifact<6000 then return end
  if self.counts.tools<150 and self.clock<4800 then return end
  local d=self.dwarves[1]; local best=0
  for _,v in ipairs(self.dwarves) do for _,k in ipairs(SKILLS) do if v.skills[k]>best then d,best=v,v.skills[k] end end end
  if best<20 then return end
  self.last_artifact=self.clock
  local name=PREFIX[Sim.roll(self.seed,self.seq,"artifact",#PREFIX)]..self.material.." "..self.subject
  local open=self:legend("inspiration",d.name.." claims a workshop. The work continues.",0,6)
  self.mood_arc={name=name,expires=self.clock+8+Sim.roll(self.seed,self.seq,"inspiration-time",5)-1,
    dwarf=d.name,quality=self:title(best),room=1,seq=self.seq,open=open,parent=#self.artifacts>0 and self.artifacts[#self.artifacts].id or 0}
  d.mood="inspired"
end
function Sim:push(e)
  if type(e)~="table" or num(e.seq)<=self.seq then return false end
  self:advance(e.tick)
  self.seq=num(e.seq)
  local p=type(e.payload)=="table" and e.payload or {}
  local k=e.kind
  if k=="embark" then self:legend("embark","The founders raise the gate of "..self.name..".",0,4)
  elseif k=="prompt" then
    self.counts.prompts=self.counts.prompts+1
    self.subject=Sim.safe(type(p.words)=="table" and p.words[1])
    self:legend("chapter","A new chapter begins: "..self.subject..".",0,1)
    self.rooms[1].engraving=self.subject
    self:job("plan")
  elseif k=="tool" then
    local kind="other"; for _,v in ipairs(KINDS) do if p.kind==v then kind=v end end
    self.counts.tools=self.counts.tools+1; self.counts.tool_kinds[kind]=self.counts.tool_kinds[kind]+1
    local jobkind=({web="trade",mcp="trade",task="plan",other="craft"})[kind] or kind
    self:job(jobkind)
    if kind=="web" or kind=="mcp" then self:incident("caravan",32,"A caravan reaches the gate, bearing "..self.subject..".") end
    if kind=="edit" then
      self.store=self.store+1
      if #self.items<Sim.CAPS.items then self.items[#self.items+1]={id=self:id(),kind="block",room=1,quality="worked"} end
    end
    self.material=({rs="steel",py="slate",ts="copper",lua="amber",go="iron"})[p.ext] or self.material
    local target=math.min(Sim.CAPS.rooms,3+math.floor(self.counts.tools/15))
    while #self.rooms<target do self:room(jobkind) end
    self:inspire()
  elseif k=="success" then
    self.stress=math.max(0,self.stress-6)
    for i=#self.incidents,1,-1 do if self.incidents[i].kind=="ambush" then
      self:close_incident(i,self.profile=="calm" and "The setback clears; work resumes." or "The raid is broken; work resumes."); self.cooldown=self.clock+120; self.failures={}
    end end
    for _,d in ipairs(self.dwarves) do d.job=0 end; self.jobs={}
  elseif k=="tool_failed" then
    self.counts.errors=self.counts.errors+1
    self.stress=math.min(30,self.stress+(self.profile=="calm" and 4 or 8))
    local f={}; for _,t in ipairs(self.failures) do if self.clock-t<=360 then f[#f+1]=t end end
    f[#f+1]=self.clock; while #f>6 do table.remove(f,1) end; self.failures=f
    if self.clock>=self.cooldown then
      local severity=#f>=6 and 3 or (#f>=3 and 2 or 1)
      local text=self.profile=="calm" and "A setback reaches the workshop; the watch gathers." or
        (self.profile=="chaos" and "Drums echo in the tunnels; an ambush reaches the gate." or "An ambush strikes the gate.")
      local incident=self:incident("ambush",240,text,severity)
      if severity>incident.severity then
        incident.severity=severity
        self:legend("escalation",self.profile=="calm" and "The watch reinforces the workshop." or (severity==3 and "A siege gathers at the gate." or "The ambush grows into a raid."),incident.open,5)
      end
    end
  elseif k=="wait_open" then
    self.counts.waits=self.counts.waits+1
    self.stress=math.min(30,self.stress+(self.profile=="calm" and 1 or 2))
    self:incident("mandate",240,"A mandate awaits judgment at the gate.")
  elseif k=="wait_resolved" then
    local outcome=({fulfilled="fulfilled",declined="declined"})[p.outcome] or "resolved"
    for i=#self.incidents,1,-1 do if self.incidents[i].kind=="mandate" then self:close_incident(i,"The mandate is "..outcome..". The work continues.") end end
  elseif k=="subagent_start" or k=="subagent_stop" then
    self.counts.subagents=num(p.count); self.counts.subagents_peak=math.max(self.counts.subagents_peak,self.counts.subagents)
    self:population(self.counts.subagents)
  elseif k=="compact" then
    self.counts.compactions=self.counts.compactions+1
    self:legend("year_end",string.format("Year %d closes with %d labors and %d named works.",self.year,self.counts.tools,#self.artifacts),0,5)
    for i=#self.incidents,1,-1 do self:close_incident(i,"The old gallery is sealed; the watch returns.") end
    self.jobs={}; self.items={}; for _,d in ipairs(self.dwarves) do d.job=0 end
    self.z=self.z+1; self.year=self.year+1; self.cave_until=self.clock+12
    for _,r in ipairs(self.rooms) do r.z=self.z end
    self:legend("cave_in","A deep rumble passes; the old gallery is sealed.",0,5)
  elseif k=="idle" then
    self.jobs={}; for _,d in ipairs(self.dwarves) do d.job=0; d.mood="content" end
    if self.clock-self.last_routine>=80 then
      self.last_routine=self.clock
      if #self.legends>0 then
        local past=self.legends[Sim.roll(self.seed,self.seq,"engraving",#self.legends)]
        self.rooms[1].engraving=past.text
        self.rooms[1].legend_id=past.id
      end
    end
  end
  self:advance(self.clock)
  return true
end
function Sim:reconcile(j)
  if num(j.seq)<self.seq then return end
  self:advance(j.tick)
  self.seq=num(j.seq)
  if self.gap_to~=self.seq then
    self.gap_to=self.seq
    self:legend("chronicle_gap","A passage of the chronicle is missing; totals are reconciled.",0,5)
  end
  for _,k in ipairs(COUNTERS) do self.counts[k]=num(j[k]) end
  for _,k in ipairs(KINDS) do self.counts.tool_kinds[k]=num((j.tool_kinds or {})[k]) end
  self:population(self.counts.subagents, true)
  for i=#self.incidents,1,-1 do self:close_incident(i,"The record is incomplete; the watch stands down.") end
  self.jobs={}; for _,d in ipairs(self.dwarves) do d.job=0 end
  self.z=self.counts.compactions; self.year=self.z+1
  while #self.rooms<math.min(Sim.CAPS.rooms,3+math.floor(self.counts.tools/15)) do self:room("archive") end
end
function Sim:observe(state)
  self.wealth=math.max(self.wealth,num(state.lines_added))
  self.quarry=math.max(self.quarry,num(state.lines_removed))
  for _,r in ipairs(self.rooms) do r.level=math.min(5,1+math.floor(self.wealth/500)) end
end
function Sim:configure(params)
  params=params or {}
  if params.difficulty=="calm" or params.difficulty=="classic" or params.difficulty=="chaos" then self.profile=params.difficulty end
  if type(params.fortress)=="string" and #params.fortress<=24 and params.fortress:match("^[A-Za-z][A-Za-z -]+$") and params.fortress~=self.name then
    self.name=params.fortress
    self:legend("renamed","The fortress is now known as "..self.name..".",0,3)
  end
end
return Sim
