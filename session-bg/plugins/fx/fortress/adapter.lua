-- Included after local Sim and View by bundle.py. Host API is optional in harness.
local M = {}
local world, projected, layout, saved=nil,nil,nil,nil
local W,H,SEED,T,elapsed=0,0,0,0,0,0
local signature=""
function M.init(ctx)
  W,H,SEED=ctx.w,ctx.h,ctx.seed or 0
  world,projected,layout,saved=nil,nil,nil,nil
  T,elapsed,signature=0,0,""
end
function M.resize(ctx)
  if W==0 and H==0 then M.init(ctx); return end
  W,H=ctx.w,ctx.h; layout=nil
end
function M.restore(record) saved=record end
function M.export()
  if not world then return nil end
  return {schema_version=Sim.VERSION,seq=world.seq,counter_digest=Sim.digest(world.counts),world_state=world:snapshot(),
    legends=(projected or world).legends,summary=world.summary,
    status={name=world.name,year=world.year,season=(layout and layout.season) or "spring",population=#world.dwarves,
      crew=world.crew,wealth=world.wealth,stress=(projected or world).stress,z=world.z}}
end
function M.step(dt,state)
  local j=state.journey or {}
  local identity=tostring(j.repo or "fortress")..":"..tostring(j.session_id or SEED)..":"..tostring(j.epoch or "preview")..":2"
  if not world or world.identity~=identity then
    world=Sim.new(Sim.hash(identity),identity)
    if saved and saved.counter_digest and saved.world_state then
      local ok,restored=pcall(function()
        local candidate=Sim.restore(saved.world_state,identity)
        if candidate and Sim.digest(candidate.counts)==saved.counter_digest then candidate:advance(candidate.clock); return candidate end
      end)
      if ok and restored then world=restored end
    end
    saved=nil; elapsed=0; layout=nil
  end
  if (state.params or {}).paused then
    if not projected then projected=Sim.restore(world:snapshot(),identity) end
    if not layout then layout=View.layout(world,W,H) end
    return
  end
  local speed=tonumber((state.mod or {}).speed) or 1
  if speed==0 then return end
  local real_dt=math.max(0,math.min(1,dt/speed))
  T=T+dt; elapsed=elapsed+real_dt
  world:configure(state.params)
  local recent=j.recent or {}
  local last_seq=tonumber(j.seq) or 0
  if j.schema_version==2 and last_seq>world.seq then
    local first=recent[1]
    if not first or (tonumber(first.seq) or 0)>world.seq+1 then
      world:reconcile(j)
    else
      for _,e in ipairs(recent) do
        if (tonumber(e.seq) or 0)>world.seq+1 then world:reconcile(j); break end
        world:push(e)
      end
      if world.seq<last_seq or Sim.digest(world.counts)~=j.counter_digest then world:reconcile(j) end
    end
    elapsed=0
  elseif not j.schema_version and world.seq==0 and (tonumber(j.tools) or 0)>0 then
    -- Old writers have aggregates only; never interpret their unsequenced ring as history.
    local totals={}; for k,v in pairs(j) do totals[k]=v end
    totals.seq=1; totals.tick=0; world:reconcile(totals)
  end
  world:observe(state)
  -- Keep committed history at the event watermark; projection advances between hooks.
  -- A delayed hook can then be applied at its actual tick without rewinding history.
  local tick=world.clock+math.floor(elapsed*4)
  local sig=tostring(world.seq)..":"..tick..":"..W..":"..H..":"..#world.rooms..":"..world.name..":"..world.wealth..":"..world.profile
  if sig~=signature or not projected then
    signature=sig
    projected=Sim.restore(world:snapshot(),identity)
    projected:advance(tick)
  end
  local decor_key=world.wealth..":"..world.subject..":"..world.z
  if not layout or layout.w~=W or layout.h~=H or layout.room_count~=#world.rooms or layout.decor_key~=decor_key then
    layout=View.layout(world,W,H); layout.room_count=#world.rooms; layout.decor_key=decor_key
  end
  layout.season=View.season(state.context_pct)
end
function M.render(fx,state)
  if world and layout then View.render(fx,projected or world,layout,state,T) end
end
return M
