-- The surrounding landscape is scenery, never earned rooms or extra agents.
-- Build once per layout; animation reads the existing local-life clock.
local Landscape={}
local function hash(seed,n)
  local x=(seed*48271+n*69621+17)%2147483647
  return ((x~(x>>13))*1274126177)%2147483647
end
local sprites={
  {kind='oak',rows={'  .o.  ',' (oOo) ','(oOOOo)','  /|\\ ','   |   '},colour='leaf'},
  {kind='pine',rows={'   ^   ','  /|\\  ',' /|||\\ ','/|||||\\','   |   '},colour='green'},
  {kind='flowers',rows={' *   * ','\\|/ \\|/',' | * | ','  \\|/  '},colour='bloom'},
  {kind='rocks',rows={'  .--. ',' /    \\','(_____)',' ,  ,  '},colour='stone'},
  {kind='wheat',rows={' \\|/ \\|','  || ||',' \\|/ ||','  || ||'},colour='harvest'},
  {kind='mushrooms',rows={' _   _ ','(_) (_)',' | _ | ','  (_)  ','   |   '},colour='violet'},
}

function Landscape.build(layout,seed)
  local w,h=layout.w,layout.h
  local scene={cells={},water={},bridges={},wildlife={},fires={},patches={},sprigs={},w=w,h=h}
  if layout.edge_only or w<20 or layout.bottom-layout.top<5 then return scene end
  local top,bottom=layout.top,layout.bottom
  local blocked,near_patch={},{}
  local function block(x1,y1,x2,y2)
    for y=math.max(top,y1),math.min(bottom-1,y2) do
      for x=math.max(1,x1),math.min(w-2,x2) do blocked[y*w+x]=true end
    end
  end
  for _,r in ipairs(layout.rooms) do block(r.x-1,r.y-1,r.x+r.w+1,r.y+r.h) end
  for _,g in ipairs(layout.gardens) do block(g.x-1,g.y-1,g.x+g.w+2,g.y+g.h) end
  local function reserved(x,y)
    return x<1 or x>=w-1 or y<top or y>=bottom or blocked[y*w+x]
  end
  local river={}
  local amplitude=math.min(6,math.floor(w*.045))
  for y=top,bottom-1 do
    local x=math.floor(w*.54+math.sin((y-top)/6+seed%11)*amplitude)
    river[y]=x
    for dx=-1,1 do if not reserved(x+dx,y) then scene.water[#scene.water+1]={x=x+dx,y=y} end end
    for _,dx in ipairs({-2,2}) do
      if not reserved(x+dx,y) then scene.cells[#scene.cells+1]={x=x+dx,y=y,ch=',',colour='grass'} end
    end
  end
  -- A small pool widens the stream, without stretching any sprite on resize.
  local pool=math.floor(top+(bottom-top)*.68)
  for dy=-2,2 do
    local y=pool+dy;local cx=river[y]
    if cx then for dx=-math.max(1,5-math.abs(dy)),math.max(1,5-math.abs(dy)) do
      if not reserved(cx+dx,y) then scene.water[#scene.water+1]={x=cx+dx,y=y} end
    end end
  end
  for n=1,math.max(1,math.floor((bottom-top)/22)) do
    local y=math.floor(top+(bottom-top)*n/(math.max(1,math.floor((bottom-top)/22))+1))
    local cx=river[y]
    if cx then
      local clear=true
      for x=cx-3,cx+3 do if reserved(x,y) then clear=false end end
      if clear then scene.bridges[#scene.bridges+1]={x=cx-3,y=y} end
      for x=1,w-2 do
        if math.abs(x-cx)>3 and not reserved(x,y) and x%2==0 then
          scene.cells[#scene.cells+1]={x=x,y=y,ch='.',colour='path'}
        end
      end
    end
  end
  -- Patches are spread throughout the available body, including tall empty wings.
  -- Reject an entire patch near a building, garden or stream. Footpaths may
  -- disappear behind foliage; a crossing must not empty a whole horizontal band.
  local cols=math.max(1,math.floor((w-2)/12))
  local rows=math.max(1,math.floor((bottom-top)/8))
  local stride_x=(w-2)/cols;local stride_y=(bottom-top)/rows
  local function clear_patch(x,y)
    for yy=y,y+5 do for xx=x,x+7 do
      if reserved(xx,yy) or math.abs(xx-(river[yy] or -100))<4
        or (math.abs(yy-pool)<=2 and math.abs(xx-(river[yy] or -100))<7) then return false end
    end end
    return true
  end
  for row=0,rows-1 do for col=0,cols-1 do
    local n=row*cols+col
    local base_x=math.floor(1+col*stride_x+(stride_x-8)/2)
    local base_y=math.floor(top+row*stride_y+(stride_y-6)/2)
    local x=base_x+hash(seed,n+1009)%3-1
    local y=base_y+hash(seed,n+2017)%3-1
    local clear=clear_patch(x,y)
    if not clear then x,y=base_x,base_y;clear=clear_patch(x,y) end
    if clear then
      local choice=hash(seed,n)%#sprites+1
      local sprite=sprites[choice]
      local patch={x=x,y=y,kind=sprite.kind,cells={},order=hash(seed,n+3019)}
      scene.patches[#scene.patches+1]=patch
      for yy=y-1,y+6 do for xx=x-1,x+8 do near_patch[yy*w+xx]=true end end
      for dy,line in ipairs(sprite.rows) do for dx=1,#line do
        local ch=line:sub(dx,dx)
        if ch~=' ' then
          local colour=dy==#sprite.rows and (choice<=2 and 'wood' or sprite.colour) or sprite.colour
          patch.cells[#patch.cells+1]={x=x+dx-1,y=y+dy-1,ch=ch,colour=colour,leaf=ch=='o' or ch=='O'}
        end
      end end
      if #scene.patches%4==1 then
        scene.wildlife[#scene.wildlife+1]={x=x,y=y+4,span=3,kind=n%2==0 and 'rabbit' or 'butterfly'}
      elseif #scene.patches%5==0 then scene.fires[#scene.fires+1]={x=x+5,y=y+4} end
    end
  end end
  -- Distribute the limited detail budget across the landscape, so the top rows
  -- do not consume every tree while the bottom of a tall pane is left bare.
  table.sort(scene.patches,function(a,b) return a.order<b.order end)
  -- Small flowers occupy gaps where a full tree cannot fit, especially in split
  -- panes. They avoid the complete bounds of moving animals and large plants.
  for y=top+1,bottom-3,4 do for x=2,w-4,6 do
    local xx=x+hash(seed,x+y*w)%3
    local clear=true
    for dy=0,1 do for dx=-1,1 do
      local px,py=xx+dx,y+dy
      if reserved(px,py) or near_patch[py*w+px] or math.abs(px-(river[py] or -100))<4
        or (math.abs(py-pool)<=2 and math.abs(px-(river[py] or -100))<7) then clear=false end
    end end
    if clear then
      local sprig={x=xx,y=y,cells={{x=xx,y=y,ch='*',colour='bloom'}}}
      scene.sprigs[#scene.sprigs+1]=sprig
      for dx,ch in ipairs({'\\','|','/'}) do
        sprig.cells[#sprig.cells+1]={x=xx+dx-2,y=y+1,ch=ch,colour='grass'}
      end
    end
  end end
  return scene
end

function Landscape.render(scene,seconds,night,put,remaining)
  local beat=math.floor(seconds*2)
  local function text(x,y,s,colour)
    for i=1,#s do local ch=s:sub(i,i);if ch~=' ' then put(x+i-1,y,ch,colour) end end
  end
  -- Animated actors and coherent silhouettes get priority over ground texture.
  for i,a in ipairs(scene.wildlife) do
    local travel=math.floor(seconds*.65+i*3)%(a.span*2)
    local x=a.x+math.min(travel,a.span*2-travel)
    if a.kind=='rabbit' then
      text(x,a.y,'(\\_/)', 'animal');text(x,a.y+1,beat%5==0 and '(-.-)' or '(o.o)','animal')
    else text(x,a.y,beat%2==0 and '>o<' or '-o-','bloom') end
  end
  for i,f in ipairs(scene.fires) do
    put(f.x,f.y,beat%2==0 and '^' or '*','amber')
    text(f.x-1,f.y+1,'/|\\','wood')
    put(f.x+(math.floor(seconds+i)%2),f.y-1,"'",night and 'amber' or 'stone')
  end
  for _,b in ipairs(scene.bridges) do text(b.x,b.y,'|=====|','wood') end
  for _,p in ipairs(scene.water) do
    put(p.x,p.y,(p.y+p.x+beat)%4==0 and '=' or '~','water')
  end
  local function cells(list)
    for _,v in ipairs(list) do
      local ch=v.ch
      if v.leaf and (beat+v.x+v.y)%11==0 then ch='*' end
      put(v.x,v.y,ch,v.colour)
    end
  end
  -- A silhouette is all-or-nothing at the density limit. Foreground masking
  -- still takes precedence later in the host compositor.
  for _,p in ipairs(scene.patches) do if not remaining or remaining()>=#p.cells then cells(p.cells) end end
  for _,p in ipairs(scene.sprigs) do if not remaining or remaining()>=#p.cells then cells(p.cells) end end
  cells(scene.cells)
end
return Landscape
