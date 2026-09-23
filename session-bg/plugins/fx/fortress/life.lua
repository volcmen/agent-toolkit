-- Autonomous presentation ecology. It never writes earned simulation history.
local Life = {}
Life.__index = Life
Life.W,Life.H,Life.PERIOD=12,6,48
local function hash(seed,n)
  return (seed*48271+n*69621+17)%2147483647
end
local function finite(v) return type(v)=='number' and v==v and v>=0 and v<1e12 end
function Life.grow(cells,w,h)
  -- Conway B3/S23, finite garden with dead boundaries. Read old, write new.
  local next_cells={}
  for y=0,h-1 do for x=0,w-1 do
    local neighbors=0
    for dy=-1,1 do for dx=-1,1 do
      local nx,ny=x+dx,y+dy
      if (dx~=0 or dy~=0) and nx>=0 and ny>=0 and nx<w and ny<h and cells[ny*w+nx+1] then neighbors=neighbors+1 end
    end end
    next_cells[y*w+x+1]=neighbors==3 or (cells[y*w+x+1] and neighbors==2) or false
  end end
  return next_cells
end
function Life.seeded(seed,epoch)
  local cells={}
  for i=1,Life.W*Life.H do cells[i]=false end
  local flip=hash(seed,epoch)%2==0
  -- A glider, a blinker and occasional fertile cells interact locally.
  for _,p in ipairs({{1,0},{2,1},{0,2},{1,2},{2,2},{7,2},{8,2},{9,2}}) do
    local x=flip and Life.W-1-p[1] or p[1]
    cells[(p[2]+1)*Life.W+x+1]=true
  end
  for i=1,3 do cells[1+hash(seed+epoch*31,i)%(Life.W*Life.H)]=true end
  return cells
end
function Life.new(seed,saved)
  local seconds=0
  if type(saved)=='table' and saved.version==1 and saved.seed==seed and finite(saved.seconds) then seconds=saved.seconds end
  local self=setmetatable({seed=seed,seconds=seconds,generation=-1,cells={}},Life)
  self:seek(seconds)
  return self
end
function Life:seek(seconds)
  if not finite(seconds) then return end
  self.seconds=seconds
  local generation=math.floor(seconds+1e-7)
  local epoch=math.floor(generation/Life.PERIOD)
  if generation<self.generation or math.floor(self.generation/Life.PERIOD)~=epoch then
    self.cells=Life.seeded(self.seed,epoch)
    self.generation=epoch*Life.PERIOD
  end
  while self.generation<generation do
    self.cells=Life.grow(self.cells,Life.W,Life.H)
    self.generation=self.generation+1
  end
  self.day=1+math.floor(seconds/120)
  self.phase=({'Dawn','Day','Dusk','Night'})[1+math.floor(seconds/30)%4]
  self.weather=hash(self.seed,math.floor(seconds/40))%4==0 and 'Rain' or 'Clear'
  self.light=({Dawn=.88,Day=1,Dusk=.82,Night=.65})[self.phase]
end
function Life:advance(dt) self:seek(self.seconds+math.max(0,dt)) end
function Life:snapshot()
  return {version=1,seed=self.seed,seconds=math.floor(self.seconds*1000000+.5)/1000000}
end
function Life.routine(seed,id,seconds)
  local offset=hash(seed,id)%13
  local lap=math.floor((seconds+offset)/48)
  local phase=(seconds+offset)%48
  local task=({'reading','crafting','gathering','gardening'})[1+hash(seed+id,lap)%4]
  local mark=({reading='?',crafting='*',gathering=':',gardening='"'})[task]
  return {task=task,mark=mark,phase=phase,lap=lap,
    stage=phase<12 and 'walking' or (phase<26 and task or (phase<38 and 'returning' or 'resting'))}
end
return Life
