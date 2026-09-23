#!/usr/bin/env python3
"""Exercise Fortress through the real JSON protocol, busy occupancy and checkpoint I/O."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('state_smoke',ROOT/'scripts/state-smoke.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as tmp:
    script=Path(tmp,'fortress.lua');shutil.copyfile(ROOT/'plugins/fx/fortress.lua',script)
    env={**os.environ,'SBG_STATE':tmp,'SBG_SCRIPT':str(script),'SBG_FPS':'12','SBG_SEED':'1'}
    proc=subprocess.Popen([str(ROOT/'plugins/target/release/sbg-fx')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env)
    try:
        def resize(w,h,occupied=None,expect_visible=True):
            if occupied is None:
                occupied=[(x,y) for y in range(3,h-5,4) for x in range(5,w-5)]
            cells=[{'coordinates':[x,y],'character':'X','fg':[1,1,1,1],'bg':None} for x,y in occupied]
            proc.stdin.write(json.dumps({'pty_update':{'size':[w,h],'cells':cells,'cursor':[5,3]}})+'\n'); proc.stdin.flush()
            frames=module.frames(proc,1.2)
            assert len(frames)>=5,f'no Fortress frames at {w}x{h}'
            if expect_visible:
                assert any(frames[-5:]),f'no visible scenery at {w}x{h}'
            else:
                assert not any(frames[-5:]),'scenery painted over a fully occupied foreground'
            strip=int(w*.18)
            for frame in frames[-5:]:
                assert len(frame)<=w*h*.25
                for cell in frame:
                    x,y=cell['coordinates']
                    assert 0<=x<w and 0<=y<h,'out-of-bounds cell'
                    assert all(abs(x-ox)>1 or abs(y-oy)>1 for ox,oy in occupied),'foreground/halo collision'
                    if x>=strip and x<w-strip:
                        assert 1<=y<h-1,'central scenery covers HUD edge'
            return frames
        saved_path=Path(tmp,'fortress.json')
        def wait_for_flush():
            stamp=saved_path.stat().st_mtime_ns if saved_path.exists() else None
            deadline=time.monotonic()+4
            while (saved_path.stat().st_mtime_ns if saved_path.exists() else None)==stamp and time.monotonic()<deadline:
                module.frames(proc,.15)
            assert (saved_path.stat().st_mtime_ns if saved_path.exists() else None)!=stamp,'checkpoint did not flush'
            return json.loads(saved_path.read_text())
        # Default studio: a common top-heavy TUI must leave actual movement in
        # the lower floors, not just advancing checkpoints or identical frames.
        for w,h in [(80,24),(120,35),(200,60)]:
            studio_frames=resize(w,h,[(x,y) for y in range(h//2) for x in range(w)])
            shapes={tuple(sorted((tuple(c['coordinates']),c['character']) for c in frame
                                 if h//2+1<=c['coordinates'][1]<h-3)) for frame in studio_frames}
            assert len(shapes)>=2,f'studio looks frozen under top-heavy foreground at {w}x{h}'
        default=wait_for_flush()
        assert default['status']['scene']=='studio','default scene is not the studio'
        assert 'office' not in default,'checkpoint carries an office record'
        result=subprocess.run(['python3',str(ROOT/'bin/sbg'),'set','scene=settlement'],env=env,text=True,capture_output=True)
        assert result.returncode==0,result.stderr
        empty=resize(88,52,[])
        assert any(15<=c['coordinates'][0]<73 for c in empty[-1]),'default landscape centre is empty'
        assert empty[-1]!=empty[-5],'idle landscape is not alive'
        resize(80,24,[(x,y) for y in range(24) for x in range(80)],False)
        resize(120,35)
        for hint,payload in [('start',{'session_id':'smoke'}),('thinking',{'hook_event_name':'UserPromptSubmit','prompt':'Build parser river password neverpersistthis'}),('tool',{'tool_name':'Edit','tool_input':{'file_path':'/repo/main.rs'}}),('waiting',{'hook_event_name':'PermissionRequest'}),('error',{'hook_event_name':'PostToolUseFailure','error':'permission denied'})]:
            subprocess.run(['python3','-S',str(ROOT/'plugin/scripts/sbg_state.py'),hint],input=json.dumps(payload),env=env,text=True,check=True)
        module.frames(proc,1.2)
        data=json.loads(Path(tmp,'fortress.json').read_text())
        assert data['world_state']['counts']['errors']==0,'denial treated as failure'
        assert 'neverpersistthis' not in Path(tmp,'legends.json').read_text(),'private prompt persisted'
        Path(tmp,'override.json').write_text(json.dumps({'mode':'waiting','params':{'paused':True}}))
        paused=module.frames(proc,.8)
        assert paused[-1]==paused[-2],'paused world moves'
        # Checkpoints flush at most once a second. Wait for an observed write
        # after the stable paused frames; an .8s delay can still read pre-pause
        # time and falsely report that a later presentation change reset life.
        saved=wait_for_flush()
        before=saved['world_state']
        life_before=saved['life']
        session_path=Path(tmp,'session.json')
        session=json.loads(session_path.read_text())
        session['session_name']='Renamed workshop'
        session_path.write_text(json.dumps(session))
        renamed=module.frames(proc,1.2)
        row={c['coordinates'][0]:c['character'] for c in renamed[-1] if c['coordinates'][1]==0}
        assert ''.join(row.get(x,' ') for x in range(16))=='Renamed workshop','live title missing'
        assert json.loads(Path(tmp,'fortress.json').read_text())['world_state']==before,'rename changed world history'
        for w,h in [(37,9),(53,17),(77,23),(103,13),(181,19),(333,47),(419,87),(120,35)]:
            resized=resize(w,h)
            assert resized[-1]==resized[-2],'paused world moves after resize'
            assert json.loads(Path(tmp,'fortress.json').read_text())['world_state']==before,'resize changed world history'
        # The paused override.json write above replaced the whole file, dropping
        # the earlier scene=settlement pin; sbg set merges, so re-pin it here.
        result=subprocess.run(['python3',str(ROOT/'bin/sbg'),'set','scene=settlement'],env=env,text=True,capture_output=True)
        assert result.returncode==0,result.stderr
        module.frames(proc,.5)
        for presentation,quiet in [('compact',True),('auto',True),('auto',False)]:
            result=subprocess.run(['python3',str(ROOT/'bin/sbg'),'set',f'presentation={presentation}',
                f'reduced_motion={str(quiet).lower()}'],env=env,text=True,capture_output=True)
            assert result.returncode==0,result.stderr
            presented=module.frames(proc,.7)
            if presentation=='compact':
                assert all(c['coordinates'][0]<21 or c['coordinates'][0]>=99 for c in presented[-1]),'compact spills into centre'
            assert json.loads(Path(tmp,'fortress.json').read_text())['world_state']==before,'presentation changed history'
            assert json.loads(Path(tmp,'fortress.json').read_text())['life']==life_before,'presentation reset ecology'
        with script.open('a') as handle: handle.write('\n-- smoke hot reload\n')
        module.frames(proc,1.5)
        reloaded=json.loads(Path(tmp,'fortress.json').read_text())
        assert reloaded['life']==life_before,'reload reset paused ecology'
        assert reloaded['world_state']==before,'reload changed earned history'
        legends=Path(tmp,'legends.json').read_text()
        Path(tmp,'override.json').write_text(json.dumps({'mode':'waiting','params':{'paused':False,'reduced_motion':True,'scene':'settlement'}}))
        module.frames(proc,.5)
        resumed=json.loads(Path(tmp,'fortress.json').read_text())['world_state']
        for key in ['counts','rooms']:
            assert resumed[key]==before[key],f'resume changed {key}'
        assert Path(tmp,'legends.json').read_text()==legends,'resume repeated a reward'
        module.frames(proc,1.2)
        assert json.loads(Path(tmp,'fortress.json').read_text())['life']['seconds']>life_before['seconds'],'ecology did not resume'
        before_switch=json.loads(Path(tmp,'fortress.json').read_text())
        result=subprocess.run(['python3',str(ROOT/'bin/sbg'),'set','scene=studio'],env=env,text=True,capture_output=True)
        assert result.returncode==0,result.stderr
        studio=module.frames(proc,.8)
        after_studio=wait_for_flush()
        assert after_studio['world_state']['counts']==before_switch['world_state']['counts'],'scene switch changed world history'
        assert after_studio['status']['scene']=='studio','scene switch did not reach the studio'
        row={c['coordinates'][0]:c['character'] for c in studio[-1] if c['coordinates'][1]==0}
        assert ''.join(row.get(x,' ') for x in range(16))=='Renamed workshop','studio title missing'
        result=subprocess.run(['python3',str(ROOT/'bin/sbg'),'set','scene=office'],env=env,text=True,capture_output=True)
        assert result.returncode==2 and 'scene=studio' in result.stderr,'removed office scene accepted'
        Path(tmp,'override.json').write_text(json.dumps({'mode':'waiting','params':{'paused':True,'scene':'studio'}}))
        stable=module.frames(proc,.8)
        assert stable[-1]==stable[-2],'paused studio moves'
        paused_clock=wait_for_flush()['status']['studio']['now']
        module.frames(proc,1.2)
        assert wait_for_flush()['status']['studio']['now']==paused_clock,'pause did not freeze the studio clock'
        Path(tmp,'override.json').write_text(json.dumps({'mode':'waiting','params':{'paused':False,'scene':'studio'}}))
        module.frames(proc,1.2)
        assert wait_for_flush()['status']['studio']['now']>paused_clock,'studio clock did not resume'
        result=subprocess.run(['python3',str(ROOT/'bin/sbg'),'set','presentation=compact'],env=env,text=True,capture_output=True)
        assert result.returncode==0,result.stderr
        compact=module.frames(proc,.7)
        assert any(compact[-1]),'compact studio is empty'
        assert all(c['coordinates'][0]<21 or c['coordinates'][0]>=99 for c in compact[-1]),'compact studio spills into centre'
        proc.stdin.close(); proc.wait(timeout=3)
        pre_restart=json.loads(Path(tmp,'fortress.json').read_text())
        legacy=dict(pre_restart); legacy['office']={'elapsed':99.0,'actors':{},'facts':{'legacy':True}}
        Path(tmp,'fortress.json').write_text(json.dumps(legacy))
        proc=subprocess.Popen([str(ROOT/'plugins/target/release/sbg-fx')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env)
        after_restart=resize(120,35,[])
        assert any(after_restart[-3:]),'effect stopped rendering after a legacy office record'
        recovered=wait_for_flush()
        assert recovered['world_state']['counts']==pre_restart['world_state']['counts'],'legacy office record damaged world history'
        assert recovered['legends']==pre_restart['legends'],'legacy office record changed legends'
        assert 'office' not in recovered,'legacy office record survived restore'
        assert not Path(tmp,'error.json').exists(),'script error'
        log=Path(tmp,'fx.log')
        assert not log.exists() or 'runtime error' not in log.read_text(),'intermittent script failure'
        print('PASS Fortress real-protocol smoke: default studio liveness, arbitrary 37x9–419x87 grids, foreground + halo, centre, compact/reduced-motion controls, pause/resume, studio clock, live rename, ecology hot reload, checkpoint and legacy office restore, private-input filtering')
    finally:
        proc.stdin.close()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
