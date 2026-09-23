-- Presentation must adapt to arbitrary grids without becoming simulation input.
local H=dofile('scripts/world/harness.lua')
local Sim=dofile('plugins/fx/fortress/sim.lua')
local View=dofile('plugins/fx/fortress/render.lua')
View.landscape=dofile('plugins/fx/fortress/landscape.lua')
local Life=dofile('plugins/fx/fortress/life.lua')
local Plaque=dofile('plugins/fx/fortress/plaque.lua')
local tests=0
local function check(ok,message) assert(ok,message); tests=tests+1 end
local world=Sim.new(91,'responsive')
world:population(4,true)
for i=1,310 do world:push({seq=i,tick=i*4,kind='tool',payload={kind='edit'}}) end
local life=Life.new(world.seed)
local before=world:hash_state()
local function frame(w,h,params,seconds)
  local layout=View.layout(world,w,h,params)
  local fx=H.mkfx(w,h)
  local put=fx.put
  function fx:put(x,y,ch,r,g,b)
    check(x>=0 and y>=0 and x<w and y<h,'renderer emits only in-bounds cells')
    check(x<layout.strip or x>=w-layout.strip or (not layout.edge_only and y>=layout.top and y<layout.bottom),'centre scenery only in auto body')
    put(self,x,y,ch,r,g,b)
  end
  life:seek(seconds)
  local state={session_name='Adaptive workshop',mode='tool',context_pct=100,tool='Edit',params=params,
    journey={tools=310},lines_added=15640,lines_removed=222}
  local plaque=Plaque.new(); plaque:step(seconds,state)
  View.render(fx,world,layout,state,seconds,life,plaque)
  check(fx:unique()<=math.floor(w*h*.25),'density ceiling on arbitrary grid')
  for _,room in ipairs(layout.rooms) do
    check(room.w>=6 and room.w<=18,'rooms keep readable proportions')
    check(room.y>=layout.top and room.y+room.h<=layout.bottom,'room fits between HUD bands')
  end
  return Sim.canonical(fx.cells),layout,fx
end
for i=1,320 do
  local w,h=(i*73)%419+1,(i*19)%87+1
  for _,mode in ipairs({'auto','compact'}) do frame(w,h,{presentation=mode},i) end
end
for _,size in ipairs({{0,0},{1,1},{12,3},{31,9},{53,17},{77,23},{103,29},{181,19},{333,47},{419,87}}) do
  frame(size[1],size[2],{},10)
end
local _,wide=frame(419,47,{},10)
check(wide.strip>40 and #wide.rooms>2,'wide panes use available space without a fixed strip ceiling')
check(#View.layout(world,53,17).rooms>0,'narrow panes retain miniature rooms when content fits')
check(#View.layout(world,103,13).rooms>0,'short panes retain miniature rooms when content fits')
local still=frame(103,29,{reduced_motion=true},0)
for _,second in ipairs({.5,2,32,80,121}) do
  check(still==frame(103,29,{reduced_motion=true},second),'reduced motion removes all autonomous movement and brightness pulses')
end
check(frame(103,29,{},2)~=frame(103,29,{},32),'normal view remains alive')
check(world:hash_state()==before,'render and presentation do not change earned history')

-- Header and meter fit by content, retaining complete numeric values.
local p=Plaque.new()
local state={mode='waiting',context_pct=100,journey={tools=150000},lines_added=56000,lines_removed=22222}
p:step(1,state); p:toast('* reward'); p:step(.1,state)
for width=1,70 do
  local hud=p:hud(state,width,true)
  check(not hud.meter or #hud.meter<=width,'context meter fits including 100 percent')
  check(#hud.progress<=width,'progress uses complete abbreviated values')
  check(hud.label=='waiting ?','toasts never hide an important waiting state')
end

-- A pair of real bundles sees identical events and time. One changes presentation
-- and dimensions on every frame, including while paused, then both continue.
local function instance()
  local e=H.sandbox(); assert(loadfile('plugins/fx/fortress.lua','t',e))()
  e.init({w=103,h=29,seed=1}); return e
end
local a,b=instance(),instance()
local plain=H.mkstate('tool',H.journey(30,{}),{})
local moving=H.mkstate('tool',H.journey(30,{}),{})
for i=1,180 do
  plain.params.paused=i>=60 and i<=90
  moving.params={scene=plain.params.scene,paused=plain.params.paused,presentation=i%2==0 and 'compact' or 'auto',reduced_motion=i%3==0}
  a.step(.1,plain)
  local w,h=(i*17)%279+24,(i*13)%59+7
  b.resize({w=w,h=h,seed=1}); b.step(.1,moving)
  b.render(H.mkfx(w,h),moving)
  check(Sim.canonical(a.checkpoint())==Sim.canonical(b.checkpoint()),'resize and controls preserve checkpoint, ecology and legends')
end
local old=b.checkpoint().world_state.counts.tools
plain.journey=H.journey(70,{}); moving.journey=H.journey(70,{})
for _,s in ipairs({plain,moving}) do
  s.journey.schema_version=2; s.journey.seq=70; s.journey.recent={}; s.journey.tick=100
  s.journey.counter_digest=Sim.digest(s.journey)
end
moving.params.reduced_motion=true
a.step(.1,plain); b.step(.1,moving)
check(b.checkpoint().world_state.counts.tools>old,'new earned progress continues in reduced motion')
check(Sim.canonical(a.checkpoint())==Sim.canonical(b.checkpoint()),'quiet progress matches the animated view')
print('PASS '..tests..' adaptive presentation assertions: arbitrary grids, compact HUD, quiet frames, resize/checkpoint parity')
