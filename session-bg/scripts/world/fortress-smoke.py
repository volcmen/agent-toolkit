#!/usr/bin/env python3
"""Exercise Fortress through the real JSON protocol, busy occupancy and checkpoint I/O."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('state_smoke',ROOT/'scripts/state-smoke.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as tmp:
    env={**os.environ,'SBG_STATE':tmp,'SBG_SCRIPT':str(ROOT/'plugins/fx/fortress.lua'),'SBG_FPS':'12','SBG_SEED':'1'}
    proc=subprocess.Popen([str(ROOT/'plugins/target/release/sbg-fx')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env)
    try:
        occupied=[(x,y) for y in range(3,30,4) for x in range(5,115)]
        cells=[{'coordinates':[x,y],'character':'X','fg':[1,1,1,1],'bg':None} for x,y in occupied]
        proc.stdin.write(json.dumps({'pty_update':{'size':[120,35],'cells':cells,'cursor':[5,3]}})+'\n'); proc.stdin.flush()
        frames=module.frames(proc,1.5)
        assert frames and any(frames),'no Fortress frames'
        for frame in frames[-5:]:
            assert len(frame)<=120*35*.25
            for cell in frame:
                x,y=cell['coordinates']
                assert all(abs(x-ox)>1 or abs(y-oy)>1 for ox,oy in occupied),'foreground/halo collision'
                assert x<21 or x>=99,'protected centre collision'
        for hint,payload in [('start',{'session_id':'smoke'}),('thinking',{'hook_event_name':'UserPromptSubmit','prompt':'Build parser river password neverpersistthis'}),('tool',{'tool_name':'Edit','tool_input':{'file_path':'/repo/main.rs'}}),('waiting',{'hook_event_name':'PermissionRequest'}),('error',{'hook_event_name':'PostToolUseFailure','error':'permission denied'})]:
            subprocess.run(['python3','-S',str(ROOT/'plugin/scripts/sbg_state.py'),hint],input=json.dumps(payload),env=env,text=True,check=True)
        module.frames(proc,1.2)
        data=json.loads(Path(tmp,'fortress.json').read_text())
        assert data['world_state']['counts']['errors']==0,'denial treated as failure'
        assert 'neverpersistthis' not in Path(tmp,'legends.json').read_text(),'private prompt persisted'
        Path(tmp,'override.json').write_text(json.dumps({'params':{'paused':True}}))
        paused=module.frames(proc,.8)
        assert paused[-1]==paused[-2],'paused world moves'
        assert not Path(tmp,'error.json').exists(),'script error'
        print('PASS Fortress real-protocol smoke: foreground + halo, centre, events, pause, checkpoint, private-input filtering')
    finally:
        proc.stdin.close()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
