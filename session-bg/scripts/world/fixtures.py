#!/usr/bin/env python3
"""Generate small, synthetic, secret-free event recordings; explicit --write only."""
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[2]
KINDS=('exec','edit','read','web','task','mcp','other')
def lua(v):
    if isinstance(v,dict): return '{'+','.join('['+json.dumps(k)+']='+lua(x) for k,x in sorted(v.items()))+'}'
    if isinstance(v,list): return '{'+','.join(lua(x) for x in v)+'}'
    if isinstance(v,str): return json.dumps(v)
    return str(v).lower()
def fixture(minutes):
    events=[]
    def add(seconds,kind,payload=None): events.append({'kind':kind,'tick':seconds*4,'payload':payload or {}})
    add(0,'embark'); add(5,'prompt',{'words':['parser','cedar']})
    for sec in range(10,minutes*60,10):
        kind=KINDS[(sec//10)%4]
        add(sec,'tool',{'kind':kind,'ext':'rs'})
        if sec%60==0 and not (minutes>=30 and 600<=sec<=615): add(sec+1,'success',{'kind':kind})
    add(120,'wait_open'); add(125,'wait_resolved',{'outcome':'declined'})
    if minutes>=30:
        add(300,'subagent_start',{'count':1}); add(310,'subagent_start',{'count':2})
        for sec in (600,605,610): add(sec,'tool_failed',{'class':'tool'})
        add(615,'success',{'kind':'exec'})
        add(900,'subagent_stop',{'count':1}); add(1000,'subagent_stop',{'count':0})
    if minutes==180:
        add(3600,'compact'); add(7200,'compact')
        add(7205,'prompt',{'words':['archive','river']})
    add(minutes*60,'idle')
    events.sort(key=lambda e:e['tick'])
    counters={k:0 for k in ('prompts','tools','errors','compactions','waits','subagents','subagents_peak')}
    counters['tool_kinds']={k:0 for k in KINDS}
    for seq,e in enumerate(events,1):
        e['seq']=seq
        if e['kind']=='tool': counters['tools']+=1; counters['tool_kinds'][e['payload']['kind']]+=1
        key={'prompt':'prompts','tool_failed':'errors','compact':'compactions','wait_open':'waits'}.get(e['kind'])
        if key: counters[key]+=1
        if e['kind'] in ('subagent_start','subagent_stop'):
            counters['subagents']=e['payload']['count']; counters['subagents_peak']=max(counters['subagents_peak'],counters['subagents'])
    digest=':'.join(str(counters[k]) for k in ('prompts','tools','errors','compactions','waits','subagents','subagents_peak'))+':'+':'.join(str(counters['tool_kinds'][k]) for k in KINDS)
    return {'schema_version':2,'seed':1337,'identity':'synthetic-'+str(minutes),'final_tick':minutes*60*4,'events':events,'counters':counters,'counter_digest':digest}
def main():
    write='--write' in sys.argv
    for name,minutes in (('short',5),('half-hour',30),('three-hour',180)):
        f=fixture(minutes)
        for ext,text in (('json',json.dumps(f,indent=2)+'\n'),('lua','-- Generated synthetic replay fixture; see scripts/world/fixtures.py.\nreturn '+lua(f)+'\n')):
            path=ROOT/'tests/fixtures/fortress'/f'{name}.{ext}'
            if write: path.write_text(text)
            elif not path.is_file() or path.read_text()!=text: raise SystemExit(f'{path.name} stale; run fixtures.py --write')
    print('fortress fixtures current')
if __name__=='__main__': main()
