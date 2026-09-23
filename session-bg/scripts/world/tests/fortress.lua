local Sim=dofile('plugins/fx/fortress/sim.lua')
local View=dofile('plugins/fx/fortress/render.lua')
View.landscape=dofile('plugins/fx/fortress/landscape.lua')
local Harness=dofile('scripts/world/harness.lua')
local tests=0
local function check(ok,msg) assert(ok,msg); tests=tests+1 end
local function event(seq,kind,payload,tick) return {seq=seq,kind=kind,payload=payload or {},tick=tick or seq*4} end
local function synthetic(i)
  if i==1 then return event(i,'embark') end
  if i%400==0 then return event(i,'compact') end
  if i%233==0 then return event(i,'subagent_start',{count=30}) end
  if i%239==0 then return event(i,'subagent_stop',{count=0}) end
  if i%31==0 then return event(i,'tool_failed') end
  if i%37==0 then return event(i,'success') end
  if i%53==0 then return event(i,'wait_open') end
  if i%59==0 then return event(i,'wait_resolved',{outcome='declined'}) end
  if i%17==0 then return event(i,'prompt',{words={'parser'}}) end
  return event(i,'tool',{kind=({'edit','exec','read','web','mcp'})[i%5+1],ext='rs'})
end
local function replay(n,batch)
  local s=Sim.new(123,'test')
  for start=1,n,batch or 1 do for i=start,math.min(n,start+(batch or 1)-1) do s:push(synthetic(i)) end end
  return s
end
local a=replay(10000)
for _,batch in ipairs({1,7,64}) do check(a:hash_state()==replay(10000,batch):hash_state(),'batch replay') end
for _=1,100 do check(a:hash_state()==replay(10000,64):hash_state(),'100 deterministic replays') end
local first=replay(512); local restored=assert(Sim.restore(first:snapshot(),'test'))
for i=513,10000 do first:push(synthetic(i)); restored:push(synthetic(i)) end
check(first:hash_state()==restored:hash_state(),'checkpoint continuation')
check(not Sim.restore(first:snapshot(),'wrong'),'identity mismatch rejected')
local before=first:hash_state(); for i=1,100 do Sim.roll(first.seed,i,'cosmetic',99) end
check(first:hash_state()==before,'cosmetic RNG isolated')
local s=Sim.new(42,'arcs')
s:push(event(1,'wait_open')); s:push(event(2,'wait_resolved',{outcome='declined'}))
check(s.counts.errors==0 and #s.incidents==0,'denial is neutral')
for i=3,5 do s:push(event(i,'tool_failed')) end
check(s.incidents[1].severity==2,'3 failures become raid')
s:push(event(6,'success')); check(#s.incidents==0,'success resolves')
s:push(event(7,'tool_failed')); check(#s.incidents==0,'recovery cooldown')
s:tick(240); check(s.stress==0,'stress baseline in 60 seconds')
s:push(event(8,'wait_open',{},s.clock)); s:tick(241); check(#s.incidents==0,'missing resolution expires')
for _,x in ipairs({{24.9,'spring'},{25,'summer'},{50,'autumn'},{75,'winter'},{100,'winter'}}) do check(View.season(x[1])==x[2],'season boundary') end
s:push(event(9,'subagent_start',{count=99},s.clock)); check(#s.dwarves==12 and s.crew==88,'migrant cap + crew')
s:push(event(10,'subagent_stop',{count=0},s.clock)); check(#s.dwarves==1 and s.crew==0,'resident retirement')
local labour=Sim.new(19,'labour')
local building=Sim.new(18,'building')
check(building:construction(4)==0 and building:progression().rooms==3,'starter rooms and planned site')
for i=1,7 do building:push(event(i,'tool',{kind='edit'})) end
check(building:construction(4)==7/15 and building:progression().work==7,'construction earned by labors')
building:tick(10000)
check(building:construction(4)==7/15,'idle time does not build')
for i=8,45 do building:push(event(i,'tool',{kind='read'},building.clock+i)) end
check(building:progression().rank==2 and building:progression().name=='Outpost','rank at six complete rooms')
check(building:progression().rooms==6 and building:construction(7)==0,'new site starts after completion')
local completed=0
for _,e in ipairs(building.legends) do if e.kind=='room_built' then completed=completed+1 end end
check(completed==3,'one announcement per completed room')
local continued=assert(Sim.restore(building:snapshot(),'building'))
local checkpoint_hash=continued:hash_state()
local compact=View.layout(continued,80,24)
check(compact.rooms[#compact.rooms].index==#continued.rooms,'active site survives small viewport')
local f1,f2=Harness.mkfx(80,24),Harness.mkfx(80,24)
View.render(f1,continued,compact,{session_name='First session',mode='idle',params={paused=true}},0)
View.render(f2,continued,compact,{session_name='New session',mode='idle',params={paused=true}},0)
check(Sim.canonical(f1.cells)~=Sim.canonical(f2.cells),'paused title updates')
check(continued:hash_state()==checkpoint_hash,'rename does not rewrite history')
local moving,paused=Harness.mkfx(80,24),Harness.mkfx(80,24)
View.render(moving,continued,compact,{mode='tool',params={}},1.5)
View.render(paused,continued,compact,{mode='tool',params={paused=true}},1.5)
check(Sim.canonical(moving.cells)==Sim.canonical(paused.cells),'pause freezes builders without snapping to origin')
local title=''; for x=0,13 do title=title..(f2.cells[x] and f2.cells[x].ch or ' ') end
check(title:match('New session')~=nil,'session title rendered')
for i=46,675 do continued:push(event(i,'tool',{kind='edit'},continued.clock+4)) end
check(continued:progression().capped and continued:progression().rooms==48 and continued:progression().rank==5,'final rank and building cap')
check(#continued.rooms==48,'no invisible extra buildings at cap')
for i,kind in ipairs({'edit','read','exec'}) do
  labour:push(event(i,'tool',{kind=kind}))
  check(labour.jobs[#labour.jobs].kind==kind,'job kind '..kind)
  check(labour.dwarves[1].skills[kind]==1,'practice XP '..kind)
  check(labour.dwarves[1].mood=='focused','focused during work')
end
labour:tick(25); check(#labour.jobs==0 and labour.dwarves[1].job==0,'jobs cannot stick')
labour:push(event(4,'prompt',{words={'parser'}},labour.clock)); check(labour.jobs[1].kind=='plan','prompt plans')
local history=Sim.canonical(labour.legends)
labour:configure({difficulty='calm'}); check(history==Sim.canonical(labour.legends),'profile keeps past legends')
labour:push(event(5,'tool_failed',{},labour.clock)); check(labour.stress==4,'calm halves error stress')
labour:push(event(6,'idle',{},labour.clock)); check(#labour.jobs==0,'idle rests')
local corrupt=labour:snapshot(); corrupt.dwarves={}
check(not Sim.restore(corrupt,'labour'),'corrupt checkpoint rejected')
local timed=Sim.new(99,'timing'); local tick_times={}
for i=1,2000 do local t=os.clock(); timed:push(synthetic(i)); tick_times[#tick_times+1]=(os.clock()-t)*1000 end
table.sort(tick_times)
print(string.format('simulation push p95 %.4fms',tick_times[1900]))
check(tick_times[1900]<0.5,'simulation event budget')
local ticker=Sim.new(7,'ticker')
ticker:legend('routine','First routine.',0,1)
ticker:legend('routine','Throttled routine.',0,1)
check(#ticker.announcements==0,'routine announcements throttled')
ticker:legend('incident','Urgent watch.',0,5)
check(ticker.announcement.text=='Urgent watch.','priority preempts routine')
for i=1,30 do ticker:legend('visit','Visitor '..i,0,3) end
check(#ticker.announcements==16,'announcement queue bounded')
ticker:tick(16); check(ticker.announcement.text=='Visitor 1','queued slot advances')
local ids={}
for _,collection in ipairs({a.dwarves,a.rooms,a.items,a.jobs,a.incidents,a.artifacts,a.legends}) do
  for _,entity in ipairs(collection) do check(not ids[entity.id],'no reused entity id'); ids[entity.id]=true end
end
local soak=Sim.new(123,'soak'); local memory={}; local started=os.clock()
for i=1,100000 do
  soak:push(synthetic(i))
  for k,cap in pairs(Sim.CAPS) do assert(#soak[k]<=cap,k..' overflow') end
  if i==20000 or i==100000 then collectgarbage('collect'); memory[#memory+1]=collectgarbage('count') end
end
check(memory[2]-memory[1]<100,'memory stays flat after warmup')
check(#soak.artifacts>0,'artifacts reachable')
for i=2,#soak.artifacts do check(soak.artifacts[i].tick-soak.artifacts[i-1].tick>=6000,'artifact cooldown') end
check(soak.evicted>0,'bounded legends summary used')
local count=0; for _,n in pairs(soak.summary) do count=count+n end
check(count==soak.evicted,'summary counts exact')
local simhash=soak:hash_state()
local function intersects(a,b) return a.x<b.x+b.w and b.x<a.x+a.w and a.y<b.y+b.h and b.y<a.y+a.h end
local layouttime=os.clock()
for i=1,500 do
  local w=60+(i*47)%181; local h=16+(i*13)%55
  local layout=View.layout(soak,w,h)
  for n,r in ipairs(layout.rooms) do
    check(not intersects(r,layout.centre),'room outside protected centre')
    for m=1,n-1 do check(not intersects(r,layout.rooms[m]),'no overlapping rooms') end
  end
  local fx=Harness.mkfx(w,h)
  View.render(fx,soak,layout,{mode='tool',params={density=3}},3.25)
  check(fx:unique()/(w*h)<=0.25,'coverage cap')
  for key in pairs(fx.cells) do
    local x,y=key%w,key//w
    check(x<layout.strip or x>=w-layout.strip or (y>=layout.top and y<layout.bottom),'landscape stays out of central HUD bands')
  end
end
local original=Sim.canonical(View.layout(soak,200,60)); View.layout(soak,120,35)
check(original==Sim.canonical(View.layout(soak,200,60)),'resize layout restores')
local layout=View.layout(soak,200,60)
local times={}
for i=1,1000 do
  local fx=Harness.mkfx(200,60); local t=os.clock()
  View.render(fx,soak,layout,{mode='tool',params={density=1}},i/12)
  times[#times+1]=(os.clock()-t)*1000
end
table.sort(times)
check(soak:hash_state()==simhash,'1000 renders never mutate sim')
for _,size in ipairs({{80,24},{120,35},{200,60}}) do
  local fresh=Sim.new(123,'baseline'); local fx=Harness.mkfx(size[1],size[2])
  View.render(fx,fresh,View.layout(fresh,size[1],size[2]),{params={}},0)
  check(fx:unique()/(size[1]*size[2])>=0.04,'embark visible at '..size[1])
end
print(string.format('PASS %d assertions; 100k events %.2fs; memory delta %.1f KiB; render p95 %.3fms; layout/property pass %.2fs',tests,os.clock()-started,memory[2]-memory[1],times[950],os.clock()-layouttime))
