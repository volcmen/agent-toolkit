"""Observe the real hook/CLI boundary, including concurrent writers and private inputs."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from test_state_hook import run_hook, read_journey, read_session, ROOT

KINDS = ('exec','edit','read','web','task','mcp','other')
class FortressEvents(unittest.TestCase):
    def test_secret_tokens_are_rejected_whole_not_split(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt='Build parser cedar river sk-secretabcdefghijklmnop alice@example.com /private/customer/path https://internal.example/api API_TOKEN=superprivate password hiddenword bearer veryhiddenvalue'
            run_hook('thinking', {'hook_event_name':'UserPromptSubmit','prompt':prompt},tmp)
            j=read_journey(tmp)
            self.assertIn('parser',j['words'])
            all_text=''.join(p.read_text() for p in Path(tmp).glob('*.json'))
            for word in ('secretabcdefghijklmnop','alice','example','customer','internal','superprivate','hiddenword','veryhiddenvalue'):
                self.assertNotIn(word,all_text)
            self.assertIsNone(j['last_prompt'])
            self.assertIsNone(read_session(tmp)['prompt'])

    def test_parallel_subagent_hooks_keep_every_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook('start',{'session_id':'same'},tmp)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results=list(pool.map(lambda _:run_hook('subagent-start',{'hook_event_name':'SubagentStart','session_id':'same'},tmp),range(24)))
            self.assertTrue(all(r.returncode==0 for r in results))
            j=read_journey(tmp)
            self.assertEqual(j['subagents'],24)
            self.assertEqual(j['seq'],25)
            self.assertEqual([e['seq'] for e in j['recent']],list(range(1,26)))

    def test_resume_compact_keep_sequence_and_clear_changes_epoch(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook('start',{'session_id':'a'},tmp)
            first=read_journey(tmp)
            run_hook('compacting',{'hook_event_name':'PreCompact','session_id':'a'},tmp)
            run_hook('start',{'session_id':'a','source':'resume'},tmp)
            latest=read_journey(tmp)
            self.assertEqual(latest['seq'],first['seq']+2)
            self.assertEqual(latest['epoch'],first['epoch'])
            run_hook('start',{'session_id':'a','source':'clear'},tmp)
            self.assertNotEqual(read_journey(tmp)['epoch'],first['epoch'])
            self.assertEqual(read_journey(tmp)['seq'],1)

    def test_denied_permission_is_neutral_and_success_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook('waiting',{'hook_event_name':'PermissionRequest'},tmp)
            run_hook('error',{'hook_event_name':'PostToolUseFailure','error':'Permission denied'},tmp)
            j=read_journey(tmp)
            self.assertEqual(j['errors'],0)
            self.assertEqual(j['recent'][-1]['payload']['outcome'],'declined')
            self.assertEqual(read_session(tmp)['mode'],'thinking')
            run_hook('thinking',{'hook_event_name':'PostToolUse','tool_name':'functions.exec_command'},tmp)
            self.assertEqual(read_journey(tmp)['recent'][-1]['kind'],'success')

    def test_counter_digest_and_ring_are_consistent(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(72):
                run_hook('tool',{'tool_name':'apply_patch','tool_input':{'path':'/private/a.secretlongextension'}},tmp)
            j=read_journey(tmp)
            self.assertEqual(len(j['recent']),64)
            self.assertEqual(j['recent'][0]['seq'],10)
            self.assertEqual(j['files'],{'other':72})
            fields=('prompts','tools','errors','compactions','waits','subagents','subagents_peak')
            expected=':'.join(str(j[k]) for k in fields)+':'+':'.join(str(j['tool_kinds'][k]) for k in KINDS)
            self.assertEqual(j['counter_digest'],expected)
            self.assertEqual(j['recent'][-1]['payload']['kind'],'edit')

    def test_idle_notification_does_not_invent_mandate(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook('waiting',{'hook_event_name':'Notification','notification_type':'idle_prompt'},tmp)
            self.assertEqual(read_journey(tmp)['waits'],0)
            run_hook('waiting',{'hook_event_name':'PermissionRequest'},tmp)
            self.assertEqual(read_journey(tmp)['waits'],1)
            run_hook('waiting',{'hook_event_name':'PermissionRequest'},tmp)
            self.assertEqual(read_journey(tmp)['waits'],1)

class FortressCLI(unittest.TestCase):
    def run_cli(self,args,tmp):
        return subprocess.run([sys.executable,str(ROOT/'bin/sbg'),*args],env={**os.environ,'SBG_STATE':tmp},text=True,capture_output=True)
    def test_controls_and_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=self.run_cli(['set','fortress=Amber Hall','paused=true','difficulty=calm'],tmp)
            self.assertEqual(r.returncode,0,r.stderr)
            p=json.loads((Path(tmp)/'override.json').read_text())['params']
            self.assertEqual(p,{'fortress':'Amber Hall','paused':True,'difficulty':'calm'})
            before=(Path(tmp)/'override.json').read_bytes()
            for value in ('difficulty=hard','paused=yes','fortress=bad\x1bname','fortress='+('x'*25)):
                self.assertEqual(self.run_cli(['set',value],tmp).returncode,2)
                self.assertEqual((Path(tmp)/'override.json').read_bytes(),before)
    def test_legends_empty_limit_and_safe_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=self.run_cli(['legends'],tmp)
            self.assertEqual(r.returncode,0); self.assertIn('No fortress legends',r.stdout)
            (Path(tmp)/'legends.json').write_text(json.dumps({'legends':[{'text':'one','tick':1},{'text':'two\x1b[2J','tick':2}]}))
            r=self.run_cli(['legends','1'],tmp)
            self.assertEqual(r.returncode,0); self.assertNotIn('one',r.stdout); self.assertNotIn('\x1b',r.stdout)
            for n in ('0','129','bad'):
                self.assertEqual(self.run_cli(['legends',n],tmp).returncode,2)
