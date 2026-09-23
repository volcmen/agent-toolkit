-- Included after local Sim and View by bundle.py. Host API is optional in harness.
local M = {}
local world, projected, layout, saved, life, plaque=nil,nil,nil,nil,nil,nil
local W,H,SEED,T,elapsed,clock=0,0,0,0,0,0
local crew={}
local signature=""
function M.init(ctx)
  W,H,SEED=ctx.w,ctx.h,ctx.seed or 0
  world,projected,layout,saved,life=nil,nil,nil,nil,nil
  plaque=Plaque.new()
  T,elapsed,signature,clock,crew=0,0,"",0,{}
end
function M.resize(ctx)
  if W==0 and H==0 then M.init(ctx); return end
  W,H=ctx.w,ctx.h; layout=nil
end
function M.restore(record) saved=record end
function M.export()
  if not world then return nil end
  return {schema_version=Sim.VERSION,seq=world.seq,counter_digest=Sim.digest(world.counts),world_state=world:snapshot(),
    legends=(projected or world).legends,summary=world.summary,life=life and life:snapshot(),
    status={name=world.name,scene=layout and layout.scene,year=world.year,season=(layout and layout.season) or "spring",population=#world.dwarves,
      crew=world.crew,wealth=world.wealth,stress=(projected or world).stress,z=world.z,progression=world:progression(),
      life=life and {day=life.day,phase=life.phase,weather=life.weather,generation=life.generation},
      studio=layout and layout.scene=='studio' and {tier=layout.tier,points=Studioview.points(world.counts),floors=#layout.floors,
        now=math.floor(clock)} or nil}}
end
local function studio_layout(params,presentation)
  local tier=Studioview.tier(Studioview.points(world.counts))
  local key=table.concat({W,H,tier,tostring(params.glyphs),presentation,tostring(params.density)},":")
  if layout and layout.key==key and layout.scene=='studio' then return end
  layout=Studioview.layout(W,H,tier,params); layout.key=key; layout.scene='studio'; layout.presentation=presentation
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
    life=Life.new(world.seed,(saved and saved.world_state and saved.world_state.identity==identity and saved.life) or nil)
    saved=nil; elapsed=0; layout=nil; projected=nil; signature=''; clock=0; crew={}
  end
  local params=state.params or {}
  local presentation=params.presentation or 'auto'
  local scene=params.scene=='settlement' and 'settlement' or 'studio'
  if layout and (layout.presentation~=presentation or layout.scene~=scene) then layout=nil end
  local speed=tonumber((state.mod or {}).speed) or 1
  local real_dt=speed>0 and math.max(0,math.min(1,dt/speed)) or 0
  plaque:step((state.params or {}).paused and 0 or real_dt,state)
  if params.paused then
    if scene=='studio' then studio_layout(params,presentation); return end
    if not projected then projected=Sim.restore(world:snapshot(),identity) end
    if not layout then layout=View.layout(world,W,H,state.params); layout.presentation=presentation; layout.scene=scene end
    layout.season=View.season(state.context_pct)
    return
  end
  if speed==0 then return end
  T=T+dt; elapsed=elapsed+real_dt
  if scene~='studio' then life:advance(real_dt) end
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
  if scene=='studio' then
    studio_layout(params,presentation)
    local target=j.schema_version==2 and (tonumber(j.tick) or 0)+math.floor(math.max(0,tonumber(state.age) or 0)*4)
      or world.clock+math.floor(elapsed*4)
    clock=math.max(clock+real_dt*4,target)
    return
  end
  -- Keep committed history at the event watermark; projection advances between hooks.
  -- A delayed hook can then be applied at its actual tick without rewinding history.
  local tick=world.clock+math.floor(elapsed*4)
  local sig=tostring(world.seq)..":"..tick..":"..W..":"..H..":"..#world.rooms..":"..world.name..":"..world.wealth..":"..world.profile
  if sig~=signature or not projected then
    signature=sig
    projected=Sim.restore(world:snapshot(),identity)
    projected:advance(tick)
  end
  local decor_key=world.wealth..":"..world.subject..":"..world.z..":"..world.counts.tools
  if not layout or layout.w~=W or layout.h~=H or layout.room_count~=#world.rooms or layout.decor_key~=decor_key then
    layout=View.layout(world,W,H,state.params); layout.room_count=#world.rooms; layout.decor_key=decor_key
    layout.presentation=presentation; layout.scene=scene
  end
  layout.season=View.season(state.context_pct)
end
function M.render(fx,state)
  if not (world and layout) then return end
  if layout.scene=='studio' then
    local j=state.journey or {}
    local quiet=(state.params or {}).reduced_motion==true
    local now=math.floor(clock)
    local frame=Studio.plan(crew,{seed=world.seed,layout=layout,recent=j.schema_version==2 and j.recent or nil,
      live={mode=state.mode,subagents=j.subagents},now=now,quiet=quiet})
    View.render(fx,world,layout,state,T,nil,plaque,Studioview.cast(frame,layout,{now=now,quiet=quiet,ending=state.mode=='end'}))
    return
  end
  View.render(fx,projected or world,layout,state,T,life,plaque)
end
return M
