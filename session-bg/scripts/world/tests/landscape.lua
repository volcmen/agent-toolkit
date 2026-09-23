-- Regression for the nearly empty, faint tall-pane screenshot: a fresh session
-- must already have a visible landscape, without granting any earned progress.
local H=dofile('scripts/world/harness.lua')
local Sim=dofile('plugins/fx/fortress/sim.lua')
local View=dofile('plugins/fx/fortress/render.lua')
local Landscape=dofile('plugins/fx/fortress/landscape.lua')
local Life=dofile('plugins/fx/fortress/life.lua')
View.landscape=Landscape
local tests=0
local function check(ok,msg) assert(ok,msg);tests=tests+1 end
for _,seed in ipairs({9,42,123,65537}) do
  local world=Sim.new(seed,'fresh-landscape')
  local before=world:hash_state()
  for _,size in ipairs({{53,27},{80,24},{88,52},{120,35},{200,60}}) do
    local w,h=table.unpack(size)
    local layout=View.layout(world,w,h)
    local scene=layout.landscape
    local original=Sim.canonical(scene)
    -- Reproduce a crowded HUD leaving only a small scenery allowance: no tree
    -- may be cut in half merely because the density budget runs out.
    local plants={patches=scene.patches,sprigs={},water={},bridges={},wildlife={},fires={},cells={}}
    for _,limit in ipairs({12,32,60}) do
      local drawn,n={},0
      Landscape.render(plants,0,false,function(x,y,ch)
        drawn[y*w+x]=ch;n=n+1
      end,function() return limit-n end)
      check(n<=limit,'plant groups respect the remaining density budget')
      for _,p in ipairs(scene.patches) do
        local visible=0
        for _,v in ipairs(p.cells) do if drawn[v.y*w+v.x] then visible=visible+1 end end
        check(visible==0 or visible==#p.cells,'density limit preserves complete silhouettes')
      end
    end
    local life=Life.new(seed)
    local function frame(seconds,params)
      life:seek(seconds)
      local fx=H.mkfx(w,h)
      View.render(fx,world,layout,{mode='idle',params=params or {}},seconds,life)
      return fx
    end
    local fx=frame(0)
    check(fx:unique()>=w*h*.14,'fresh scene has visible coverage at '..w..'x'..h)
    check(fx:unique()<=math.floor(w*h*.25),'landscape obeys the shared density ceiling')
    check(#scene.water>h and #scene.bridges>0,'connected stream and crossing at every size')
    check(#scene.patches+#scene.sprigs>=3,'plants survive small-pane packing')
    if w>=80 then check(#scene.wildlife>0,'fresh scene has wildlife without tool events') end
    local quarters={0,0,0,0}
    for key,v in pairs(fx.cells) do
      local x,y=key%w,key//w
      check(v.ch:match('^[ -~]$')~=nil,'single-cell ASCII scenery')
      if x>=layout.strip and x<w-layout.strip then
        check(y>=layout.top and y<layout.bottom,'central HUD bands remain clear')
        local q=math.min(4,1+math.floor((y-layout.top)*4/(layout.bottom-layout.top)))
        quarters[q]=quarters[q]+1
      end
    end
    for _,n in ipairs(quarters) do check(n>=5,'scenery fills every vertical quarter') end
    for _,g in ipairs(layout.gardens) do
      local end_y=layout.top-1
      for _,r in ipairs(layout.rooms) do if r.side==g.side then end_y=math.max(end_y,r.y+r.h) end end
      check(g.y-end_y<=2,'gardens stay connected to buildings in tall panes')
    end
    check(Sim.canonical(fx.cells)~=Sim.canonical(frame(2).cells),'idle scenery visibly animates')
    local quiet=Sim.canonical(frame(0,{reduced_motion=true}).cells)
    check(quiet==Sim.canonical(frame(65,{reduced_motion=true}).cells),'quiet mode freezes scenery')
    check(original==Sim.canonical(scene),'animation does not modify the cached landscape')
    View.layout(world,37,9)
    check(original==Sim.canonical(View.layout(world,w,h).landscape),'resize back restores the same landscape')
    local compact=View.layout(world,w,h,{presentation='compact'})
    local compact_fx=H.mkfx(w,h)
    View.render(compact_fx,world,compact,{params={presentation='compact'}},0,life)
    for key in pairs(compact_fx.cells) do
      local x=key%w
      check(x<compact.strip or x>=w-compact.strip,'explicit compact keeps the centre empty')
    end
  end
  check(world:hash_state()==before,'scenery never changes rooms, residents, counters or legends')
end
-- The native text fast path must produce precisely the same cells and colours
-- as individual puts, including density truncation, quiet frames and HUD pulses.
local original_sbg=sbg
for _,size in ipairs({{53,27},{80,24},{88,52},{200,60}}) do
  for _,mode in ipairs({'thinking','tool','waiting','error','compacting','idle'}) do
    for _,quiet in ipairs({false,true}) do
      local world=Sim.new(9,'batch-parity')
      local w,h=table.unpack(size);local layout=View.layout(world,w,h)
      local state={mode=mode,age=1,params={reduced_motion=quiet}}
      local a,b=H.mkfx(w,h),H.mkfx(w,h);local life=Life.new(9);life:seek(71)
      sbg=nil;View.render(a,world,layout,state,71,life)
      sbg=H.sbg;View.render(b,world,layout,state,71,life)
      check(Sim.canonical(a.cells)==Sim.canonical(b.cells),'batched text preserves exact frame output')
    end
  end
end
sbg=original_sbg
-- At default idle brightness (.8) and opacity (.6), silhouettes remain visible
-- against the dark reference background even at the dimmest local-life phase.
for _,key in ipairs({'wall','leaf','stone','water','animal','bloom'}) do
  local c=View.colours[key]
  local luminance=(c[1]*.2126+c[2]*.7152+c[3]*.0722)*.82*.8*.6+.105*.4
  check(luminance>=.28,key..' survives default compositing at night')
end
print('PASS '..tests..' landscape assertions: fresh coverage, vertical distribution, compact fallback, motion, contrast and unchanged history')
