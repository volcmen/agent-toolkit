local Sim=dofile('plugins/fx/fortress/sim.lua')
local fixture=assert(arg[1],'usage: lua scripts/world/replay.lua FIXTURE.lua')
local f=dofile(fixture)
local s=Sim.new(f.seed,f.identity)
for _,e in ipairs(f.events) do s:push(e) end
s:advance(f.final_tick)
assert(Sim.digest(s.counts)==f.counter_digest,'event/counter digest mismatch')
for k,cap in pairs(Sim.CAPS) do assert(#s[k]<=cap,k..' overflow') end
local seen={}
for _,e in ipairs(s.legends) do
  if e.ref~=0 then assert(seen[e.ref] or e.ref<=s.evicted_through,'orphan arc close') end
  seen[e.id]=true
end
print(string.format('%s hash=%s seq=%d year=%d artifacts=%d legends=%d summarised=%d',fixture,s:hash_state(),s.seq,s.year,#s.artifacts,#s.legends,s.evicted))
if arg[2]=='--legends' then for _,e in ipairs(s.legends) do print(e.tick..' '..e.text) end end
