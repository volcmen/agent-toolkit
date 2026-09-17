-- Stateless layout/renderer. Simulation tables are read only here.
local View = {}
View.colours = {neutral={0.38,0.49,0.56}, amber={0.60,0.43,0.20}, red={0.57,0.28,0.28},
  violet={0.52,0.38,0.64}, wall={0.25,0.32,0.38}, floor={0.16,0.22,0.23}, green={0.30,0.43,0.33}}
function View.season(pct)
  return ({"spring","summer","autumn","winter"})[1+math.min(3,math.floor(math.max(0,tonumber(pct) or 0)/25))]
end
function View.layout(world,w,h)
  local strip=math.max(1,math.min(40,math.floor(w*0.18)))
  local cols=w>=160 and 2 or 1
  local room_w=math.max(4,math.floor(strip/cols)-1)
  local room_h=h>=45 and 8 or 6
  local rows=math.max(0,math.floor((h-7)/(room_h+1)))
  local out={w=w,h=h,strip=strip,rooms={},centre={x=strip,y=0,w=math.max(0,w-2*strip),h=h}}
  if w<60 or h<16 then out.decoration={}; return out end
  local slots=rows*cols
  for i,r in ipairs(world.rooms) do
    local side=(i-1)//math.max(1,slots)
    if side>1 or (side==1 and w<120 and i>slots+1) then break end
    local slot=(i-1)%math.max(1,slots)
    local col=slot%cols; local row=slot//cols
    local x=side==0 and (1+col*(room_w+1)) or (w-strip+col*(room_w+1))
    if x+room_w<=w and room_w>=4 then
      out.rooms[#out.rooms+1]={id=r.id,index=i,x=x,y=3+row*(room_h+1),w=room_w,h=room_h}
    end
  end
  out.decoration=View.decorate(world,out)
  return out
end
local function glyph(kind)
  return ({plan="?",exec="=",edit="=",read="?",trade="*",craft="=",rest="~",archive=":"})[kind] or "="
end
function View.decorate(world,layout)
  local w,h,strip,rooms=layout.w,layout.h,layout.strip,layout.rooms
  local layers,seen={{},{},{},{},{},{}},{}
  local function put(x,y,ch,colour,priority)
    if x<0 or y<0 or x>=w or y>=h or (x>=strip and x<w-strip) or ch==" " then return end
    local key=y*w+x
    if seen[key] then return end
    seen[key]=true
    local list=layers[(priority or 3)+1]
    list[#list+1]={x=x,y=y,ch=ch,c=View.colours[colour] or View.colours.neutral,floor=colour=="floor"}
  end
  local function text(x,y,s,max,colour,priority)
    for i=1,math.min(#s,max) do put(x+i-1,y,s:sub(i,i),colour,priority) end
  end
  for _,r in ipairs(rooms) do
    local source=world.rooms[r.index]
    local label=source.kind:sub(1,math.max(0,r.w-4))
    text(r.x+2,r.y,label,r.w-3,"neutral",2)
    put(r.x+r.w-1,r.y+2,"+","amber",2)
    put(r.x+1,r.y+1,glyph(source.kind),"neutral",2)
    if source.engraving~="" then put(r.x+1,r.y+r.h-2,"'","violet",3) end
    for x=r.x,r.x+r.w-1 do put(x,r.y,"#","wall",3); put(x,r.y+r.h-1,"#","wall",3) end
    for y=r.y+1,r.y+r.h-2 do put(r.x,y,"#","wall",3); put(r.x+r.w-1,y,"#","wall",3) end
    for y=r.y+1,r.y+r.h-2 do for x=r.x+1,r.x+r.w-2 do
      if (x+y)%3==0 then put(x,y,".","floor",4) end
    end end
    if source.level>1 then put(r.x+r.w-2,r.y+1,tostring(source.level),"amber",2) end
  end
  -- Seeded rock/veins provide a visible embark without inventing earned rooms.
  for y=3,h-3 do for _,left in ipairs({0,w-strip}) do for x=left,left+strip-1 do
    local n=(x*17+y*31+world.seed)%13
    if n<2 then put(x,y,n==0 and ":" or ".","floor",5) end
  end end end
  if world.z>0 then text(0,h-3,"< sealed gallery",strip,"wall",4) end
  return layers
end
function View.render(fx,world,layout,state,phase)
  local w,h,strip=layout.w,layout.h,layout.strip
  if w<1 or h<1 then return end
  local occupied={}
  local density=math.max(0.1,math.min(3,tonumber((state.params or {}).density) or 1))
  local budget=math.floor(w*h*math.min(0.25,0.15*density))
  local drawn=fx:count()
  local function put(x,y,ch,colour,priority)
    if x<0 or y<0 or x>=w or y>=h or (x>=strip and x<w-strip) or ch==" " then return end
    local key=y*w+x
    local cap=priority==0 and math.floor(w*h*0.25) or budget
    if occupied[key] or drawn>=cap then return end
    occupied[key]=true
    local c=type(colour)=="table" and colour or (View.colours[colour] or View.colours.neutral)
    fx:put(x,y,ch,c[1],c[2],c[3]); drawn=drawn+1
  end
  local function text(x,y,s,max,colour,priority)
    for i=1,math.min(#s,max) do put(x+i-1,y,s:sub(i,i),colour,priority) end
  end
  local season=View.season(state.context_pct)
  text(0,0,world.name,strip,"neutral",0)
  text(0,1,string.format("Y%d %s",world.year,season),strip,"green",0)
  text(w-strip,0,string.format("%dd +%dc",#world.dwarves,world.crew),strip,"neutral",0)
  text(w-strip,1,string.format("z%d $%d",world.z,world.wealth),strip,"neutral",0)
  -- Fixed edge segments; no scrolling banner through foreground text.
  local latest=world.announcement
  if latest and h>3 then
    local labels={embark="Gate raised",chapter="New chapter",migrant="Specialist in",departure="Departure",
      inspiration="Strange mood",artifact="Masterwork",caravan_open="Caravan arrives",caravan_close="Caravan leaves",
      mandate_open="Decision waits",mandate_close="Decision noted",ambush_open="Watch gathers",escalation="Gate reinforced",
      ambush_close="Work resumes",cave_in="Gallery sealed",year_end="Year closes",chronicle_gap="History gap",renamed="New name"}
    local left=labels[latest.kind] or "Chronicle"
    local right=world.subject
    if latest.kind=="migrant" or latest.kind=="departure" or latest.kind=="inspiration" or latest.kind=="artifact" then right=latest.text:match("^(%w+)") or right end
    if latest.kind=="chronicle_gap" then right="Totals kept" end
    local function clip(s) return #s>strip and (s:sub(1,math.max(0,strip-3)).."...") or s end
    text(0,h-2,clip(left),strip,"neutral",0)
    text(w-strip,h-2,clip(right),strip,"neutral",0)
  end
  local rooms=layout.rooms
  local jobs={}
  for _,j in ipairs(world.jobs) do jobs[j.id]=j end
  for i,d in ipairs(world.dwarves) do
    local job=jobs[d.job]
    local room=#rooms>0 and rooms[((job and job.target or i)-1)%#rooms+1] or nil
    local x,y=0,math.min(h-1,3+i)
    if room then x=room.x+2+((i-1)%math.max(1,room.w-4)); y=room.y+2+((i-1)//math.max(1,room.w-4))%(room.h-3) end
    local col=d.mood=="inspired" and "violet" or (d.mood=="strained" and "amber" or "neutral")
    put(x,y,d.role=="founder" and "@" or "d",col,0)
    local mark=job and glyph(job.kind) or "~"
    if state.mode=="thinking" and d.role=="founder" then mark="?" end
    if state.mode=="idle" and (tonumber(state.age) or 0)>60 then mark="z" end
    if state.mode=="tool" and math.floor(phase*3+i)%2==0 then mark="*" end
    put(x+1,y,mark,col,0)
  end
  if world.crew>0 then text(w-strip,h-4,"dd crew",strip,"neutral",0) end
  for i,e in ipairs(world.incidents) do
    local x=w-strip+math.min(strip-1,2+i*2)
    local y=math.min(h-3,3+i)
    local ch,col="!","red"
    if e.kind=="caravan" then ch,col="*","green"; x=w-strip+1+math.floor(phase*2)%math.max(1,strip-2)
    elseif e.kind=="mandate" then ch,col="?","amber" end
    put(x,y,ch,col,0)
    if world.profile=="chaos" and e.kind=="ambush" then put(x+1,y,"!",col,0) end
  end
  for i,a in ipairs(world.artifacts) do
    if #rooms>0 then local r=rooms[(a.room-1)%#rooms+1]; put(r.x+1+(i%math.max(1,r.w-2)),r.y+r.h-2,"*","violet",1) end
  end
  if #rooms>0 then
    put(rooms[1].x+1,rooms[1].y+2,world.z>0 and ">" or "+","amber",1)
    for i,item in ipairs(world.items) do
      local r=rooms[(item.room-1)%#rooms+1]
      put(r.x+1+i%math.max(1,r.w-2),r.y+r.h-2,":","wall",4)
    end
  end
  if world.z>0 then text(0,h-3,"< sealed gallery",strip,"wall",4) end
  if world.cave_until>world.clock or state.mode=="compacting" then
    for x=0,strip-1 do put(x,math.min(h-1,2+(x+math.floor(phase*4))%math.max(1,h-4)),"'","amber",1) end
  end
  if state.mode=="error" and (tonumber(state.age) or 0)<3 then put(w-2,2,"!","red",0) end
  local floor_colour=({spring={0.16,0.23,0.19},summer={0.22,0.23,0.16},autumn={0.25,0.19,0.15},winter={0.17,0.21,0.27}})[season]
  local layers=layout.decoration or View.decorate(world,layout)
  for _,layer in ipairs(layers) do for _,v in ipairs(layer) do
    if drawn>=budget then return end
    put(v.x,v.y,v.ch,v.floor and floor_colour or v.c)
  end end
end
return View
