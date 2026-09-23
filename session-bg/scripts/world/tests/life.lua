local Life=dofile('plugins/fx/fortress/life.lua')
local Sim=dofile('plugins/fx/fortress/sim.lua')
local View=dofile('plugins/fx/fortress/render.lua')
View.landscape=dofile('plugins/fx/fortress/landscape.lua')
local H=dofile('scripts/world/harness.lua')
local tests=0
local function check(ok,message) assert(ok,message); tests=tests+1 end
local function grid(w,h,points)
  local cells={}; for i=1,w*h do cells[i]=false end
  for _,p in ipairs(points) do cells[p[2]*w+p[1]+1]=true end
  return cells
end
local block=grid(6,6,{{2,2},{3,2},{2,3},{3,3}})
check(Sim.canonical(Life.grow(block,6,6))==Sim.canonical(block),'still life is stable')
local horizontal=grid(6,6,{{1,2},{2,2},{3,2}})
local vertical=grid(6,6,{{2,1},{2,2},{2,3}})
check(Sim.canonical(Life.grow(horizontal,6,6))==Sim.canonical(vertical),'blinker rotates')
check(Sim.canonical(Life.grow(vertical,6,6))==Sim.canonical(horizontal),'blinker returns')
local glider=grid(8,8,{{2,1},{3,2},{1,3},{2,3},{3,3}})
for _=1,4 do glider=Life.grow(glider,8,8) end
check(Sim.canonical(glider)==Sim.canonical(grid(8,8,{{3,2},{4,3},{2,4},{3,4},{4,4}})),'glider moves diagonally after four generations')
check(not Life.grow(grid(4,4,{{0,0}}),4,4)[1],'isolated cell dies')
local a,b=Life.new(19),Life.new(19)
for _=1,1440 do a:advance(1/12) end
for _=1,7200 do b:advance(1/60) end
check(a.generation==120 and b.generation==120,'frame cadence does not change generation')
check(Sim.canonical(a.cells)==Sim.canonical(b.cells),'frame cadence does not change ecology')
local restored=Life.new(19,a:snapshot())
check(Sim.canonical(restored.cells)==Sim.canonical(a.cells),'restore regenerates exact ecology')
check(restored.day==2 and restored.phase=='Dawn','day cycle is explicit')
local corrupted=Life.new(19,{version=1,seed=19,seconds=0/0})
check(corrupted.seconds==0,'bad life checkpoint resets only ecology')
check(Life.new(20,a:snapshot()).seconds==0,'other identity cannot inherit life')
local t=os.clock(); a:seek(10800)
check(os.clock()-t<.05 and #a.cells==72,'long gap remains bounded')
local world=Sim.new(9,'living')
world:population(4,true)
local before=world:hash_state();local labels,locations={},{}
for second=0,240 do
  a:seek(second)
  local layout=View.layout(world,120,35)
  local actor=View.resident(world,layout,world.dwarves[1],1,a)
  labels[actor.stage]=true; locations[actor.x..':'..actor.y]=true
  check(actor.x<layout.strip,'resident stays in its district')
  for _,room in ipairs(layout.rooms) do
    local wall=(actor.x==room.x or actor.x==room.x+room.w-1) and actor.y>=room.y and actor.y<room.y+room.h
      or (actor.y==room.y or actor.y==room.y+room.h-1) and actor.x>=room.x and actor.x<room.x+room.w
    check(not wall or (actor.x==room.x+room.w-1 and actor.y==room.y+2),'resident uses doors, not walls')
  end
end
local n=0;for _ in pairs(locations) do n=n+1 end
check(n>15 and labels.resting and labels.gardening and labels.reading and labels.gathering,'residents move and vary their routines')
check(world:hash_state()==before,'autonomous life never earns work or arrivals')
local observed=Life.new(world.seed);observed:seek(32)
for _,size in ipairs({{80,24},{120,35},{200,60}}) do
  local layout=View.layout(world,size[1],size[2])
  check(#layout.gardens>0,'garden visible at '..size[1])
  for _,g in ipairs(layout.gardens) do for _,r in ipairs(layout.rooms) do
    check(g.x+g.w<=r.x or r.x+r.w<=g.x or g.y+g.h<=r.y or r.y+r.h<=g.y,'garden does not cover buildings')
  end end
  local fx=H.mkfx(size[1],size[2]);local snapshot=Sim.canonical(observed:snapshot())
  View.render(fx,world,layout,{mode='idle',params={}},0,observed)
  check(fx:unique()<=size[1]*size[2]*.25,'life respects density cap')
  for key in pairs(fx.cells) do
    local x,y=key%size[1],key//size[1]
    check(x<layout.strip or x>=size[1]-layout.strip or (y>=layout.top and y<layout.bottom),'life respects HUD bands')
  end
  check(Sim.canonical(observed:snapshot())==snapshot,'render and resize never advance life')
end
-- Real bundled lifecycle: pause, reload and speed changes preserve local time.
local function instance(w,h,saved)
  local env=H.sandbox();assert(loadfile('plugins/fx/fortress.lua','t',env))()
  env.init({w=w,h=h,seed=1});if saved then env.restore(saved) end
  return env
end
local state=H.mkstate('idle',H.journey(30,{}),{})
state.mod.speed=1
local env=instance(120,35)
for _=1,120 do env.step(.1,state) end
local saved=env.checkpoint()
state.params.paused=true;env.step(2,state)
check(Sim.canonical(env.checkpoint().life)==Sim.canonical(saved.life),'pause freezes life')
local next_env=instance(80,24,saved);next_env.step(.1,state)
check(Sim.canonical(next_env.checkpoint().life)==Sim.canonical(saved.life),'reload and resize preserve life')
state.params.paused=false;state.mod.speed=2;next_env.step(.2,state)
check(math.abs(next_env.checkpoint().life.seconds-saved.life.seconds-.1)<1e-6,'speed only scales presentation, not life time')
print('PASS '..tests..' living-world assertions: Conway rules, cadence, reload, pause, routes, density, bounded recovery')
