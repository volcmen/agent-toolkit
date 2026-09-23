-- Stateless layout/renderer. Simulation tables are read only here.
local View = {}
local function label(s)
  -- One glyph per cell even with an external Unicode title; no byte slicing.
  return tostring(s or ""):gsub("[%z\1-\31\127]", ""):gsub("[\194-\244][\128-\191]*", "?")
end
local function clip(s,n)
  s=label(s)
  if #s<=n then return s end
  return n>=4 and s:sub(1,n-3).."..." or s:sub(1,n)
end
local function meter(work,goal,width)
  local n=math.max(1,width-2)
  local fill=math.floor(n*math.min(1,work/goal))
  return "["..string.rep("=",fill)..string.rep("-",n-fill).."]"
end
-- These are source colours: the host's idle multiplier and compositor opacity
-- dim them again. Keep silhouettes legible after that default composition.
View.colours = {neutral={0.72,0.83,0.92}, amber={0.98,0.76,0.42}, red={0.93,0.51,0.49},
  violet={0.83,0.66,0.97}, wall={0.60,0.73,0.82}, floor={0.26,0.35,0.36}, green={0.49,0.80,0.58},
  leaf={0.46,0.90,0.61}, grass={0.39,0.60,0.43}, wood={0.79,0.63,0.44}, stone={0.65,0.72,0.78},
  path={0.48,0.55,0.50}, harvest={0.94,0.84,0.49}, animal={0.91,0.83,0.69},
  water={0.48,0.79,0.97}, bloom={0.94,0.86,0.58}}
function View.season(pct)
  return ({"spring","summer","autumn","winter"})[1+math.min(3,math.floor(math.max(0,tonumber(pct) or 0)/25))]
end
function View.layout(world,w,h,params)
  -- Pack content into a fraction of the current grid, never a reference resolution.
  -- Room dimensions are legibility limits; wide panes gain rooms, not stretched walls.
  local strip=math.floor(w*0.18)
  local compact=(params or {}).presentation=='compact' or strip<12 or h<4+4+6+2
  local head=math.min(compact and 3 or 4,math.max(1,math.floor(h/4)))
  local foot=math.min(compact and 2 or 4,math.floor(h/4))
  local top,bottom=head+1,h-foot-1
  local available=math.max(0,bottom-top)
  local cols=math.max(1,math.floor((strip-1)/20+.5))
  local room_w=math.min(18,math.floor((strip-1)/cols)-2)
  local room_h=compact and 4 or math.max(5,math.min(8,math.floor(room_w/2.8+.5)))
  local garden_h=math.min(6,math.floor(available/3))
  local reserve=garden_h>=2 and available>=room_h+garden_h+3 and garden_h+2 or 0
  local rows=room_w>=6 and math.max(0,math.floor((available-reserve+1)/(room_h+1))) or 0
  local out={w=w,h=h,strip=strip,compact=compact,edge_only=(params or {}).presentation=='compact',head=head,foot=foot,top=top,bottom=bottom,
    rooms={},gardens={},roads={},centre={x=strip,y=0,w=math.max(0,w-2*strip),h=h}}
  local visible=math.min(#world.rooms,rows*cols*2)
  for i=1,visible do
    -- Keep the current building site visible when old districts leave the pane.
    local index=(i==visible and #world.rooms>visible) and #world.rooms or i
    local r=world.rooms[index]
    local side=(i-1)%2
    local slot=(i-1)//2
    local col=slot%cols; local row=slot//cols
    local x=(side==0 and 1 or w-strip+1)+col*(room_w+2)
    out.rooms[#out.rooms+1]={id=r.id,index=index,side=side,x=x,y=top+row*(room_h+1),w=room_w,h=room_h}
  end
  for side=0,1 do
    local used=top-1
    for _,r in ipairs(out.rooms) do
      if r.side==side then
        used=math.max(used,r.y+r.h)
        out.roads[#out.roads+1]={x=r.x+r.w,y=r.y+2,side=side}
      end
    end
    local garden_top=used+2
    if strip>=7 and bottom-garden_top>=2 then
      out.gardens[#out.gardens+1]={x=(side==0 and 1 or w-strip+1),y=garden_top,w=math.min(12,strip-4),h=math.min(6,bottom-garden_top),side=side}
      for _,road in ipairs(out.roads) do if road.side==side then road.y=math.max(road.y,garden_top+1) end end
    end
  end
  out.decoration=View.decorate(world,out)
  out.landscape=View.landscape and View.landscape.build(out,world.seed)
  return out
end
local function anchor(r,index) return {x=r.x+2+((index or 1)-1)%math.max(1,r.w-4),y=r.y+2} end
local function corridor(r) return {x=r.x+r.w,y=r.y+2} end
function View.walk(points,fraction)
  local total=0
  for i=2,#points do total=total+math.abs(points[i].x-points[i-1].x)+math.abs(points[i].y-points[i-1].y) end
  local distance=math.max(0,math.min(1,fraction))*total
  for i=2,#points do
    local a,b=points[i-1],points[i]
    local n=math.abs(b.x-a.x)+math.abs(b.y-a.y)
    if distance<=n and n>0 then
      return math.floor(a.x+(b.x-a.x)*distance/n+.5),math.floor(a.y+(b.y-a.y)*distance/n+.5)
    end
    distance=distance-n
  end
  local p=points[#points]; return p.x,p.y
end
function View.resident(world,layout,d,index,life)
  local rooms={}
  local side=index==1 and 0 or (index-1)%2
  for _,r in ipairs(layout.rooms) do if r.side==side then rooms[#rooms+1]=r end end
  if #rooms==0 then return nil end
  local routine=life.routine(world.seed,d.id,life.seconds)
  local home=rooms[1]
  local target=rooms[1+(routine.lap+index)%#rooms]
  local wanted=({reading='plan',crafting='workshop',gathering='rest'})[routine.task]
  for _,r in ipairs(rooms) do if world.rooms[r.index].kind==wanted then target=r; break end end
  local a,b=anchor(home,index),anchor(target,index)
  local ac,bc=corridor(home),corridor(target)
  -- Routes go through doors and the outside corridor, never through a wall.
  local points={a,ac,{x=ac.x,y=layout.top-1},{x=bc.x,y=layout.top-1},bc,b}
  if ac.x==bc.x then points={a,ac,bc,b} end
  if routine.task=='gardening' or routine.task=='gathering' then
    for _,g in ipairs(layout.gardens) do if g.side==side then
      b={x=g.x+math.min(index,g.w-2),y=g.y+1}
      points={a,ac,{x=ac.x,y=b.y},b}
    end end
  end
  local p=routine.phase
  local fraction=p<12 and p/12 or (p<26 and 1 or (p<38 and 1-(p-26)/12 or 0))
  local x,y=View.walk(points,fraction)
  return {x=x,y=y,stage=routine.stage,mark=routine.stage=='resting' and 'z' or routine.mark,
    walking=routine.stage=='walking' or routine.stage=='returning'}
end
local function glyph(kind)
  return ({plan="?",exec="=",edit="=",read="?",trade="*",craft="=",rest="~",archive=":"})[kind] or "="
end
function View.decorate(world,layout)
  local w,h,strip,rooms=layout.w,layout.h,layout.strip,layout.rooms
  local layers,seen={{},{},{},{},{},{}},{}
  local function put(x,y,ch,colour,priority)
    if x<0 or y<layout.head or x>=w or y>=h-layout.foot or (x>=strip and x<w-strip) or ch==" " then return end
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
    local progress=world:construction(r.index)
    local building=progress<1
    local stage=progress==0 and "plan" or (progress<0.34 and "base" or (progress<0.75 and "raise" or "fit"))
    local title=(building and stage or source.kind):sub(1,math.max(0,r.w-4))
    text(r.x+2,r.y,title,r.w-3,building and "amber" or "neutral",2)
    put(r.x+r.w-1,r.y+2,building and ":" or "+","amber",2)
    if not building then put(r.x+1,r.y+1,glyph(source.kind),"neutral",2) end
    if not building and r.w>=9 then
      local furniture=source.kind=='rest' and '[_]' or (source.kind=='plan' and '[::]' or '[=]')
      text(r.x+r.w-#furniture-2,r.y+1,furniture,#furniture,source.kind=='rest' and 'violet' or 'wood',2)
    end
    if source.engraving~="" then put(r.x+1,r.y+r.h-2,"'","violet",3) end
    local edge,total=0,2*r.w+2*r.h-4
    local function wall(x,y,ch)
      edge=edge+1
      local raised=not building or edge<=math.floor(progress*total)
      put(x,y,raised and ch or ".",raised and "wall" or "floor",3)
    end
    for x=r.x,r.x+r.w-1 do wall(x,r.y,(x==r.x or x==r.x+r.w-1) and "+" or "-") end
    for y=r.y+1,r.y+r.h-2 do wall(r.x+r.w-1,y,"|") end
    for x=r.x+r.w-1,r.x,-1 do wall(x,r.y+r.h-1,(x==r.x or x==r.x+r.w-1) and "+" or "-") end
    for y=r.y+r.h-2,r.y+1,-1 do wall(r.x,y,"|") end
    if building then text(r.x+1,r.y+r.h-2,meter(progress,1,r.w-2),r.w-2,"amber",2) end
    for y=r.y+1,r.y+r.h-2 do for x=r.x+1,r.x+r.w-2 do
      if not layout.compact and (x+y)%3==0 then put(x,y,".","floor",4) end
    end end
    if source.level>1 and not building then put(r.x+r.w-2,r.y+1,tostring(source.level),"amber",2) end
  end
  for _,p in ipairs(layout.roads) do for y=layout.top-1,p.y do put(p.x,y,':','floor',4) end end
  -- Seeded rock/veins provide a visible embark without inventing earned rooms.
  for y=layout.top,h-layout.foot-1 do for _,left in ipairs({0,w-strip}) do for x=left,left+strip-1 do
    local n=(x*17+y*31+world.seed)%13
    if n==0 and not layout.compact then put(x,y,":","floor",5) end
  end end end
  if world.z>0 then text(0,h-3,"< sealed gallery",strip,"wall",4) end
  return layers
end
function View.render(fx,world,layout,state,phase,life,plaque,cast)
  local w,h,strip=layout.w,layout.h,layout.strip
  if w<1 or h<1 or strip<1 then return end
  local quiet=(state.params or {}).reduced_motion==true
  if quiet then
    phase=0
    if life then
      if not layout.still_life then layout.still_life=life.new(world.seed); layout.still_life:seek(30) end
      life=layout.still_life
    end
  end
  local occupied={}
  local density=math.max(0.1,math.min(3,tonumber((state.params or {}).density) or 1))
  local budget=math.floor(w*h*math.min(0.25,(layout.edge_only and 0.15 or 0.22)*density))
  local hard_cap=math.floor(w*h*.25)
  local light=life and math.max(.82,life.light) or 1
  local shades={}
  local drawn=fx:count()
  -- The existing host text API paints a run in one Lua/Rust crossing. Preserve
  -- emission order and exact colours; direct Lua renderers can use put alone.
  local span=sbg and sbg.text
  local run_x,run_y,run_text,run_cells,run_r,run_g,run_b
  local function flush()
    if not run_text then return end
    if run_cells>1 then span(fx,run_x,run_y,run_text,run_r,run_g,run_b)
    else fx:put(run_x,run_y,run_text,run_r,run_g,run_b) end
    run_text=nil
  end
  local function emit(x,y,ch,r,g,b)
    if not span then fx:put(x,y,ch,r,g,b);return end
    if run_text and y==run_y and x==run_x+run_cells and r==run_r and g==run_g and b==run_b then
      run_text=run_text..ch;run_cells=run_cells+1
    else
      flush();run_x,run_y,run_text,run_cells,run_r,run_g,run_b=x,y,ch,1,r,g,b
    end
  end
  local function put(x,y,ch,colour,priority,bright,landscape)
    if x<0 or y<0 or x>=w or y>=h or (not landscape and x>=strip and x<w-strip) or ch==" " then return end
    if landscape and (y<layout.top or y>=layout.bottom) then return end
    local key=y*w+x
    local cap=priority==0 and hard_cap or budget
    if occupied[key] or drawn>=cap then return end
    occupied[key]=true
    local c=type(colour)=="table" and colour or (View.colours[colour] or View.colours.neutral)
    if priority~=0 and light~=1 then
      -- Shade each palette entry once per frame, not each landscape glyph.
      local shaded=shades[c]
      if not shaded then shaded={c[1]*light,c[2]*light,c[3]*light};shades[c]=shaded end
      c=shaded
    end
    if bright and bright~=1 then
      emit(x,y,ch,math.min(1,c[1]*bright),math.min(1,c[2]*bright),math.min(1,c[3]*bright))
    else emit(x,y,ch,c[1],c[2],c[3]) end
    drawn=drawn+1
  end
  local function text(x,y,s,max,colour,priority,bright,landscape)
    local i=0
    for ch in s:gmatch("[\0-\127\194-\244][\128-\191]*") do
      if i>=max then return end
      if ch==" " then occupied[y*w+x+i]=true else put(x+i,y,ch,colour,priority,bright,landscape) end
      i=i+1
    end
  end
  if layout.scene=='studio' then
    local S=View.studioview
    local toast=plaque and plaque.toasts[1]
    local hud=plaque and plaque:hud(state,strip,quiet)
    local extras={t=phase,quiet=quiet,title_hot=hud and hud.title_hot,meter_bright=hud and hud.meter_bright,
      toast=toast and toast.at and toast.text,toast_colour=toast and toast.colour}
    for _,item in ipairs(S.hud(state,layout,extras)) do text(item.x,item.y,item.text,item.width,item.colour,0,item.bright) end
    S.render(put,text,layout,{sign=S.sign(state,layout),cast=cast or {},dark=state.mode=='end' and S.dark(layout,state.age,quiet) or 0})
    flush()
    return
  end
  local season=View.season(state.context_pct)
  local title=label((state.session_name and state.session_name~="" and state.session_name) or (state.journey or {}).session_name or (state.journey or {}).repo or "Session")
  local title_rows=layout.head>=3 and 2 or 1
  local head=clip(title,math.max(1,strip*title_rows))
  local split=head:sub(1,strip):match("^.*() ")
  split=(#head>strip and split and split>strip/2) and split or strip
  local hud=plaque and plaque:hud(state,strip,quiet)
  local title_colour=(hud and hud.title_hot) and "amber" or "neutral"
  text(0,0,head:sub(1,split),strip,title_colour,0)
  if title_rows==2 then text(0,1,clip(head:sub(split+1):gsub("^ +",""),strip),strip,title_colour,0) end
  local progress=world:progression()
  local rank="LV"..progress.rank.." "..progress.name
  text(w-strip,0,#rank<=strip and rank or 'LV'..progress.rank,strip,"amber",0)
  if layout.head>=3 or (layout.head==2 and not (hud and hud.meter)) then
    local rooms=string.format('%d/%d rooms',progress.rooms,progress.total)
    if #rooms>strip then rooms=progress.rooms..' rooms' end
    text(w-strip,1,clip(layout.head>=4 and string.format("Y%d %s",world.year,season) or rooms,strip),strip,"green",0)
  end
  if layout.head>=4 then
    text(0,2,clip(world.name,strip),strip,"wall",0)
    text(w-strip,2,clip(string.format("%dd +%dc z%d",#world.dwarves,world.crew,world.z),strip),strip,"neutral",0)
  end
  if hud and layout.head>title_rows then
    text(0,layout.head-1,clip(hud.label,strip),strip,hud.colour,0)
    if hud.meter then text(w-strip,layout.head-1,hud.meter,strip,hud.meter_colour,0,hud.meter_bright) end
  end
  if layout.foot>=4 then
    text(0,h-4,hud and clip(hud.progress,strip) or (progress.capped and "City complete" or "Next room"),strip,"neutral",0,hud and hud.progress_bright or 1)
    text(0,h-3,meter(progress.work,progress.goal,strip),strip,"amber",0)
    text(w-strip,h-4,string.format("%d/%d rooms",progress.rooms,progress.total),strip,"neutral",0)
    text(w-strip,h-3,progress.capped and "Keep crafting" or string.format("%d/%d labors",progress.work,progress.goal),strip,"amber",0)
  elseif layout.foot>0 then
    local work=progress.capped and "Complete" or string.format("%d/%d work",progress.work,progress.goal)
    text(0,h-layout.foot,clip(work,strip),strip,"amber",0)
    if hud then text(w-strip,h-layout.foot,hud.progress,strip,'neutral',0,hud.progress_bright) end
  end
  -- Fixed edge segments; no scrolling banner through foreground text.
  local latest=world.announcement
  if latest and layout.foot>=2 then
    local labels={embark="Gate raised",chapter="New chapter",migrant="Specialist in",departure="Departure",
      inspiration="Strange mood",artifact="Masterwork",caravan_open="Caravan arrives",caravan_close="Caravan leaves",
      mandate_open="Decision waits",mandate_close="Decision noted",ambush_open="Watch gathers",escalation="Gate reinforced",
      ambush_close="Work resumes",cave_in="Gallery sealed",year_end="Year closes",chronicle_gap="History gap",renamed="New name",
      room_built="Room complete",rank_up="Rank up"}
    local left=labels[latest.kind] or "Chronicle"
    local right=world.subject
    if latest.kind=="migrant" or latest.kind=="departure" or latest.kind=="inspiration" or latest.kind=="artifact" then right=latest.text:match("^(%w+)") or right end
    if latest.kind=="chronicle_gap" then right="Totals kept" end
    if layout.foot>=4 then
      text(0,h-2,clip(left,strip),strip,"neutral",0)
      text(w-strip,h-2,clip(right,strip),strip,"neutral",0)
    else
      text(0,h-1,clip(left,strip),strip,"neutral",0)
      text(w-strip,h-1,clip(state.mode=='waiting' and 'Decision waits' or right,strip),strip,state.mode=='waiting' and 'amber' or 'neutral',0)
    end
  end
  local rooms=layout.rooms
  local jobs={}
  for _,j in ipairs(world.jobs) do jobs[j.id]=j end
  local residents={}
  if life then
    if life.phase=='Dusk' or life.phase=='Night' then
      for _,r in ipairs(rooms) do
        if world:construction(r.index)==1 then put(r.x+r.w-3,r.y+1,'*','amber',0) end
      end
    end
    for i,d in ipairs(world.dwarves) do residents[i]=View.resident(world,layout,d,i,life) end
    for i,a in ipairs(residents) do for j=i+1,#residents do
      local b=residents[j]
      if b and not a.walking and not b.walking and a.stage=='gathering' and b.stage=='gathering'
        and math.abs(a.x-b.x)<=4 and math.abs(a.y-b.y)<=1 then
        a.stage,b.stage,a.mark,b.mark='chatting','chatting','"','"'
      end
    end end
  end
  for i,d in ipairs(world.dwarves) do
    local resident=residents[i]
    local job=jobs[d.job]
    local room=#rooms>0 and rooms[((job and job.target or i)-1)%#rooms+1] or nil
    if i==1 and state.mode=="tool" then
      for _,r in ipairs(rooms) do if world:construction(r.index)<1 then room=r end end
    end
    if quiet and room then
      local at=anchor(room,i)
      resident={x=at.x,y=at.y,stage=job and 'working' or 'resting',mark=job and glyph(job.kind) or '~',walking=false}
    end
    if room or resident then
    local x,y=0,math.min(h-1,3+i)
    if room then x=room.x+2+((i-1)%math.max(1,room.w-4)); y=room.y+2+((i-1)//math.max(1,room.w-4))%(room.h-3) end
    if room and state.mode=="tool" and not resident then
      local travel=math.floor(phase*2+i)%math.max(2,(room.w-4)*2)
      x=room.x+2+math.min(travel,math.max(0,(room.w-4)*2-travel-1))
      x=math.min(room.x+room.w-3,x)
    end
    if resident then x,y=resident.x,resident.y end
    local col=d.mood=="inspired" and "violet" or (d.mood=="strained" and "amber" or "neutral")
    put(x,y,d.role=="founder" and "@" or "d",col,0)
    local mark=job and glyph(job.kind) or "~"
    if state.mode=="thinking" and d.role=="founder" then mark="?" end
    if state.mode=="idle" and (tonumber(state.age) or 0)>60 then mark="z" end
    if state.mode=="tool" then mark=math.floor(phase*3+i)%2==0 and "*" or "+" end
    if resident then
      mark=resident.mark
      if job and not resident.walking and resident.stage~='resting' then mark=glyph(job.kind) end
      if life.phase=='Night' and resident.stage=='resting' then col='violet' end
      if i==1 and layout.foot>=4 then text(w-strip,h-1,clip(d.name:match('^(%w+)')..': '..resident.stage,strip),strip,'neutral',0) end
    end
    put(x+1,y,mark,col,0)
    end
  end
  if life then
    if layout.foot>=4 then text(0,h-1,clip(quiet and 'Colony active' or 'D'..life.day..' '..life.phase..' '..life.weather,strip),strip,'green',0) end
    for _,g in ipairs(layout.gardens) do
      text(g.x,g.y-1,g.w>=6 and 'Garden' or 'Plot',g.w,'green',1)
      -- A cat paces the bank. Animals are scenery, never agent arrivals.
      local cat=math.floor(life.seconds/2+world.seed+g.side*5)%math.max(1,2*(g.w-1))
      cat=math.min(cat,2*(g.w-1)-cat)
      put(g.x+cat,g.y+g.h-1,'c','amber',1)
      if life.phase=='Dusk' or life.phase=='Night' then
        put(g.x+g.w-1,g.y+g.h-2,math.floor(life.seconds*3)%2==0 and '^' or '*','amber',0)
        put(g.x+g.w-1,g.y+g.h-3,"'",'wall',3)
      end
      for y=0,g.h-1 do
        for x=0,g.w-1 do
          local cell=g.side==0 and y*life.W+x+1 or (life.H-1-y)*life.W+life.W-x
          local alive=life.cells[cell]
          if alive then put(g.x+x,g.y+y,life.generation%3==0 and '"' or '*','bloom',2) end
        end
        local bend=math.floor((life.seconds+y+g.side)/3)%2
        put(g.x+g.w+1,g.y+y,bend==0 and '~' or '=','water',2)
      end
    end
    -- Sparse weather on the outside edge leaves doors and labels legible.
    if not quiet and not layout.compact and life.weather=='Rain' then
      for side=0,1 do for n=1,3 do
        local y=layout.top+(math.floor(life.seconds*5)+n*7)%math.max(1,layout.bottom-layout.top)
        put(side==0 and 0 or w-1,y,'/','water',3)
      end end
    elseif not quiet and not layout.compact and life.phase=='Night' then
      for side=0,1 do for n=1,2 do
        local x=(side==0 and 0 or w-strip)+(world.seed+n*7)%strip
        put(x,layout.top-1,'.','violet',3)
      end end
    end
  end
  for i,e in ipairs(world.incidents) do
    local x=w-strip+math.min(strip-1,2+i*2)
    local y=math.min(layout.bottom-1,layout.top+i)
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
  if not quiet and not layout.compact and (world.cave_until>world.clock or state.mode=="compacting") then
    for x=0,strip-1 do put(x,layout.top+(x+math.floor(phase*4))%math.max(1,layout.bottom-layout.top),"'","amber",1) end
  end
  if state.mode=="error" and (tonumber(state.age) or 0)<3 then put(w-2,2,"!","red",0) end
  local floor_colour=({spring={0.16,0.23,0.19},summer={0.22,0.23,0.16},autumn={0.25,0.19,0.15},winter={0.17,0.21,0.27}})[season]
  local layers=layout.decoration or View.decorate(world,layout)
  for i,layer in ipairs(layers) do
    if i==5 and layout.landscape then
      View.landscape.render(layout.landscape,quiet and 0 or (life and life.seconds or phase),life and life.phase=='Night',function(x,y,ch,colour)
        put(x,y,ch,colour,3,1,true)
      end,function() return budget-drawn end)
    end
    for _,v in ipairs(layer) do
    if drawn>=budget then flush();return end
    put(v.x,v.y,v.ch,v.floor and floor_colour or v.c)
  end end
  flush()
end
return View
