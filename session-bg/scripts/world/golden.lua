local H=dofile('scripts/world/harness.lua')
local update=arg[1]=='--write'
for _,size in ipairs({{80,24},{120,35},{200,60}}) do for _,tools in ipairs({0,120,300}) do
  local w,h=size[1],size[2]
  local opts={context_pct=tools==0 and 5 or 65,subagents=tools==0 and 0 or 2,scene='settlement'}
  local scen={j=H.journey(tools,opts),opts=opts,mode=function() return 'thinking' end}
  local cov,_,frame=H.run('plugins/fx/fortress.lua',scen,w,h,90,true)
  assert(cov<=.25 and cov>=.04,'coverage '..w..'x'..h..' '..cov)
  local path=string.format('tests/golden/fortress/%dx%d-%d.txt',w,h,tools)
  frame=frame..'\n'
  if update then local f=assert(io.open(path,'w')); f:write(frame); f:close()
  else local f=assert(io.open(path,'r')); local old=f:read('a'); f:close(); assert(old==frame,'golden mismatch '..path..'; review then --write') end
  print(string.format('%s coverage %.2f%%',path,cov*100))
end end
for _,size in ipairs({{80,24},{120,35},{200,60}}) do for _,tools in ipairs({0,120,300}) do
  local w,h=size[1],size[2]
  local opts={context_pct=tools==0 and 5 or 65,subagents=tools==0 and 0 or 2,scene='studio',tool_kind='edit',
    tail=tools==0 and {} or {{kind='tool',payload={kind='edit'}}}}
  local mode=tools==0 and 'start' or 'tool'
  local scen={j=H.story(tools,opts),opts=opts,mode=function() return mode end}
  local cov,_,frame=H.run('plugins/fx/fortress.lua',scen,w,h,90,true)
  assert(cov<=.25 and cov>=.02,'coverage '..w..'x'..h..' '..cov)
  local path=string.format('tests/golden/studio/%dx%d-%d.txt',w,h,tools)
  frame=frame..'\n'
  if update then local f=assert(io.open(path,'w')); f:write(frame); f:close()
  else local f=assert(io.open(path,'r')); local old=f:read('a'); f:close(); assert(old==frame,'golden mismatch '..path..'; review then --write') end
  print(string.format('%s coverage %.2f%%',path,cov*100))
end end
