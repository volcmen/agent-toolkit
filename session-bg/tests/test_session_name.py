"""Names follow exact session metadata without touching simulation events."""
import json
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from test_state_hook import ROOT, run_hook, read_journey, read_session

sys.path.insert(0, str(ROOT / 'plugin/scripts'))
from sbg_name import Names, NameWatcher, clean_name, refresh


class SessionNames(unittest.TestCase):
    def setup_pane(self, root, agent='codex', sid='one', **extra):
        pane = root / 'pane'
        pane.mkdir()
        (pane / 'session.json').write_text(json.dumps({'session_id': sid, 'agent': agent, 'cwd': '/repo/Project', 'ts': 50, **extra}))
        (pane / 'journey.json').write_text(json.dumps({'seq': 19, 'tick': 30, 'epoch': 'fixed', 'tools': 7}))
        return pane

    def test_codex_live_rename_clear_and_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'CODEX_HOME': tmp}):
            root = Path(tmp)
            conn = sqlite3.connect(root / 'state_5.sqlite')
            conn.execute('CREATE TABLE threads(id TEXT, name TEXT, title TEXT)')
            conn.execute('INSERT INTO threads VALUES(?,?,?)', ('one', 'Parser workshop', 'private raw prompt'))
            conn.commit()
            pane = self.setup_pane(root)
            def wait_name(title):
                until = time.monotonic() + 3
                while time.monotonic() < until:
                    if read_session(pane).get('session_name') == title:
                        return
                    time.sleep(.03)
                self.fail('name did not update: ' + title)
            with NameWatcher(pane) as watcher:
                wait_name('Parser workshop')
                conn.execute('UPDATE threads SET name=?', ('New session name',)); conn.commit()
                wait_name('New session name')
                conn.execute('UPDATE threads SET name=NULL'); conn.commit()
                wait_name('Project')
            conn.close()
            self.assertFalse(watcher.thread.is_alive())
            self.assertEqual(read_session(pane)['ts'], 50)
            self.assertEqual(read_journey(pane), {'seq': 19, 'tick': 30, 'epoch': 'fixed', 'tools': 7, 'session_name': 'Project'})
            self.assertNotIn('private raw prompt', (pane / 'session.json').read_text())

    def test_claude_rename_partial_append_and_session_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); transcript = root / 'session.jsonl'
            transcript.write_text(json.dumps({'type': 'custom-title', 'sessionId': 'one', 'customTitle': 'Amber tools'}) + '\n')
            pane = self.setup_pane(root, 'claude', transcript_path=str(transcript))
            names = Names(); refresh(pane, names)
            self.assertEqual(read_session(pane)['session_name'], 'Amber tools')
            with transcript.open('a') as handle:
                handle.write(json.dumps({'type': 'custom-title', 'sessionId': 'other', 'customTitle': 'Other private session'}) + '\n')
                handle.write('{partial')
            refresh(pane, names)
            self.assertEqual(read_session(pane)['session_name'], 'Amber tools')
            with transcript.open('a') as handle:
                handle.write('\n' + json.dumps({'type': 'custom-title', 'sessionId': 'one', 'customTitle': 'Renamed workshop'}) + '\n')
            refresh(pane, names)
            self.assertEqual(read_session(pane)['session_name'], 'Renamed workshop')
            r = run_hook('start', {'session_id': 'two', 'cwd': '/repo/New', 'transcript_path': str(root / 'new.jsonl')}, pane)
            self.assertEqual(r.stderr, '')
            self.assertEqual(read_session(pane)['session_name'], 'New')

    def test_manual_override_and_automatic_release(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'CODEX_HOME': tmp}):
            root = Path(tmp)
            (root / 'session_index.jsonl').write_text(json.dumps({'id': 'one', 'thread_name': 'Automatic'}) + '\n')
            pane = self.setup_pane(root); names = Names()
            (pane / 'override.json').write_text(json.dumps({'session_name': 'Pinned'}))
            refresh(pane, names)
            self.assertEqual(read_session(pane)['session_name'], 'Pinned')
            (pane / 'override.json').write_text(json.dumps({'session_name': ''}))
            refresh(pane, names)
            self.assertEqual(read_session(pane)['session_name'], 'Automatic')

    def test_hook_keeps_name_and_events_on_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_hook('start', {'session_id': 'one', 'session_name': 'First'}, tmp)
            before = read_journey(tmp)
            run_hook('tool', {'session_id': 'one', 'tool_name': 'Edit', 'session_name': 'Second'}, tmp)
            after = read_journey(tmp)
            self.assertEqual(read_session(tmp)['session_name'], 'Second')
            self.assertEqual(after['epoch'], before['epoch'])
            self.assertEqual(after['tools'], 1)
            self.assertEqual(after['seq'], before['seq'] + 1)

    def test_watcher_and_concurrent_hooks_preserve_every_event(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'CODEX_HOME': tmp}):
            root = Path(tmp); pane = root / 'pane'; pane.mkdir()
            index = root / 'session_index.jsonl'
            index.write_text(json.dumps({'id': 'one', 'thread_name': 'Concurrent workshop'}) + '\n')
            extra = {'CODEX_THREAD_ID': 'one', 'CODEX_HOME': tmp}
            run_hook('start', {'session_id': 'one'}, pane, extra)
            before = read_journey(pane)
            with NameWatcher(pane), ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda _: run_hook('tool', {'session_id': 'one', 'tool_name': 'Edit'}, pane, extra), range(24)))
            self.assertTrue(all(r.returncode == 0 and not r.stderr for r in results))
            after = read_journey(pane)
            self.assertEqual(after['epoch'], before['epoch'])
            self.assertEqual(after['tools'], 24)
            self.assertEqual(after['seq'], before['seq'] + 24)
            self.assertEqual(read_session(pane)['session_name'], 'Concurrent workshop')
            self.assertEqual(after['session_name'], 'Concurrent workshop')

    def test_controls_and_large_title_are_safe(self):
        self.assertEqual(clean_name('A\x1b[2J\x1b]0;bad\x07\nB\u202e'), 'A B')
        self.assertEqual(len(clean_name('x' * 1000)), 160)
        self.assertEqual(clean_name({'wrong': 1}), '')

    def test_corrupt_metadata_retains_last_name_and_never_reads_prompt(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'CODEX_HOME': tmp}):
            root = Path(tmp); index = root / 'session_index.jsonl'
            index.write_text(json.dumps({'id': 'one', 'thread_name': 'Known'}) + '\n')
            pane = self.setup_pane(root); names = Names(); refresh(pane, names)
            index.write_text('{bad json')
            refresh(pane, names)
            self.assertEqual(read_session(pane)['session_name'], 'Known')
