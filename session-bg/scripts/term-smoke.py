#!/usr/bin/env python3
"""Real nested-PTY regressions for sbg-term; no accounts or model calls."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("SBG_TERM", ROOT / "plugins/target/release/sbg-term"))


class Terminal:
    def __init__(self, code: str, *, background=False, args=None, env=None, width=100, height=30):
        self.scratch = tempfile.TemporaryDirectory(prefix="sbg-term-test-")
        self.path = Path(self.scratch.name)
        (self.path / "state").mkdir()
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        child_env = dict(os.environ, TERM="xterm-kitty", COLORTERM="truecolor", SBG_STATE=str(self.path / "state"),
                         SBG_EFFECT="stars", SBG_FPS="12", SBG_SEED="1", SBG_BACKEND="own")
        child_env.pop("SBG_SCRIPT", None)
        child_env.pop("NO_COLOR", None)
        child_env.pop("FORCE_COLOR", None)
        child_env.update(env or {})
        self.metrics = self.path / "metrics.json"
        command = args or [sys.executable, "-u", "-c", code]
        argv = [str(BINARY), *( [] if background else ["--no-background"]), "--metrics", str(self.metrics), "--", *command]
        self.process = subprocess.Popen(argv, stdin=self.slave, stdout=self.slave, stderr=self.slave,
                                        env=child_env, start_new_session=True)
        os.set_blocking(self.master, False)
        self.output = bytearray()
        self.probed = not background

    def pump(self, seconds=0.05):
        if select.select([self.master], [], [], seconds)[0]:
            try:
                self.output.extend(os.read(self.master, 65536))
            except (BlockingIOError, OSError):
                pass
        if not self.probed and b"\x1b[6n" in self.output:
            self.send(b"\x1b[1;1R")
            self.probed = True

    def send(self, data):
        deadline = time.monotonic() + 15
        while data:
            if time.monotonic() > deadline:
                raise AssertionError("input backpressure never cleared")
            try:
                count = os.write(self.master, data)
                data = data[count:]
            except BlockingIOError:
                self.pump(0.01)

    def until(self, marker, timeout=15):
        deadline = time.monotonic() + timeout
        while marker not in self.output and time.monotonic() < deadline:
            self.pump()
        if marker not in self.output:
            raise AssertionError(f"missing {marker!r}; tail={bytes(self.output[-500:])!r}")

    def finish(self, timeout=20):
        deadline = time.monotonic() + timeout
        while self.process.poll() is None and time.monotonic() < deadline:
            self.pump()
        if self.process.poll() is None:
            raise AssertionError("backend did not exit")
        while select.select([self.master], [], [], 0.1)[0]:
            before = len(self.output)
            self.pump(0)
            if len(self.output) == before:
                break
        if self.attributes() != self.original:
            raise AssertionError("outer termios was not restored")
        return self.process.returncode, bytes(self.output)

    def attributes(self):
        current = termios.tcgetattr(self.slave)
        # macOS sets this transient kernel bookkeeping bit when canonical
        # input is restored; it is not a changed application terminal mode.
        current[3] &= ~getattr(termios, "PENDIN", 0)
        return current

    def resize(self, width, height):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        # This private outer PTY is not the wrapper's controlling terminal.
        os.kill(self.process.pid, signal.SIGWINCH)

    def health(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        latest = None
        while time.monotonic() < deadline:
            try:
                latest = json.loads((self.path / "state/backend.json").read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            if latest is not None and predicate(latest):
                return latest
            self.pump()
        raise AssertionError(f"backend health never matched: {latest}")

    def stopped(self, timeout=10, *, restored=True):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.process.pid, os.WNOHANG | os.WUNTRACED)
            if pid and os.WIFSTOPPED(status):
                if restored and self.attributes() != self.original:
                    raise AssertionError("outer termios was not restored while stopped")
                return
            self.pump()
        raise AssertionError("wrapper failed to suspend with child")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.finish(5)
            except (AssertionError, OSError):
                self.process.kill()
                self.process.wait(timeout=5)
        os.close(self.master)
        os.close(self.slave)
        self.scratch.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


RAW = "import os, tty, termios; tty.setraw(0, termios.TCSANOW); "


class PtyTests(unittest.TestCase):
    def test_output_is_byte_exact_including_native_protocols(self):
        data = (b"hi\x00\xff\r\n\x1b[48;2;30;40;50m   \x1b[0m" + "界🌍".encode()
                + b"\x1b]10;?\x07\x1b]11;?\x1b\\\x1b[6n\x1b[>1u\x1b[<u"
                + b"\x1b_Gi=1;AAAA\x1b\\\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\")
        with Terminal(RAW + f"os.write(1, {data!r})") as t:
            code, output = t.finish()
            self.assertEqual((code, output), (0, data))

    def test_input_is_exact_for_binary_unicode_keys_and_large_paste(self):
        data = b"hi\r\x00\xff\x1b\x1b[13;2u\x1b[200~" + ("paste 界 🌍\n".encode() * 5000) + b"\x1b[201~\x1bt"
        code = RAW + f"""
import hashlib
os.write(1, b'READY')
data = bytearray()
while len(data) < {len(data)}:
    data.extend(os.read(0, min(65536, {len(data)} - len(data))))
os.write(1, hashlib.sha256(data).hexdigest().encode())
"""
        with Terminal(code) as t:
            t.until(b"READY")
            for part in [data[:8], data[8:31], data[31:128], data[128:]]:
                t.send(part)
            status, output = t.finish()
            self.assertEqual((status, output), (0, b"READY" + hashlib.sha256(data).hexdigest().encode()))

    def test_output_backpressure_is_lossless(self):
        data = (b"0123456789abcdefghijklmnopqrstuvwxyz\r\n" * 80000)
        code = RAW + "\n" + "data = b'0123456789abcdefghijklmnopqrstuvwxyz\\r\\n' * 80000\nwhile data:\n    data = data[os.write(1, data):]\n"
        with Terminal(code) as t:
            time.sleep(0.3)  # Let both PTYs and the bounded relay queue fill.
            status, output = t.finish(40)
            self.assertEqual(status, 0)
            self.assertEqual(hashlib.sha256(output).digest(), hashlib.sha256(data).digest())

    def test_queries_reach_outer_terminal_and_replies_reach_child_once(self):
        query = b"\x1b]10;?\x07\x1b]11;?\x07\x1b[6n"
        reply = b"\x1b]10;rgb:aaaa/bbbb/cccc\x07\x1b]11;rgb:1111/2222/3333\x07\x1b[12;34R"
        code = RAW + f"""
import hashlib
os.write(1, {query!r})
data = bytearray()
while len(data) < {len(reply)}:
    data.extend(os.read(0, {len(reply)} - len(data)))
os.write(1, hashlib.sha256(data).hexdigest().encode())
"""
        with Terminal(code) as t:
            t.until(query)
            t.send(reply)
            status, output = t.finish()
            self.assertEqual((status, output), (0, query + hashlib.sha256(reply).hexdigest().encode()))

    def test_resize_reaches_child(self):
        code = RAW + """
import signal, time
def resize(*_):
    size = os.get_terminal_size(0)
    os.write(1, f'SIZE={size.columns}x{size.lines}'.encode())
    raise SystemExit(0)
signal.signal(signal.SIGWINCH, resize)
os.write(1, b'READY')
time.sleep(20)
"""
        with Terminal(code) as t:
            t.until(b"READY")
            t.resize(132, 42)
            t.until(b"SIZE=132x42")
            self.assertEqual(t.finish()[0], 0)

    def test_unchanged_size_notifications_do_not_freeze_a_quiet_animation(self):
        with Terminal(RAW + "os.write(1, b'\x1b[2J\x1b[H\x1b[0mREADY'); os.read(0, 1)", background=True) as t:
            t.until(b"READY")
            before = t.health(lambda h: h["frames"] > 0 and h["painting_safe"])
            started = time.monotonic()
            for index in range(50):
                os.kill(t.process.pid, signal.SIGWINCH)
                until = started + (index + 1) * 0.04
                while time.monotonic() < until:
                    t.pump(min(0.02, max(0, until - time.monotonic())))
            t.health(lambda h: h["frames"] > before["frames"] + 8 and h["painting_safe"])
            t.send(b"q")
            self.assertEqual(t.finish()[0], 0)

    def test_resize_storm_redraws_without_losing_native_bytes(self):
        code = RAW + """
import signal
def redraw(*_):
    size = os.get_terminal_size(0)
    frame = (f'\x1b[?2026h\x1b[0m\x1b[2J\x1b[HVIEW={size.columns}x{size.lines}'
             '\x1b[2;1H\x1b[48;2;30;40;50m   \x1b[0m'
             '\x1b[3;1H界🌍\x1b[?2026l').encode()
    os.write(1, frame)
signal.signal(signal.SIGWINCH, redraw)
redraw()
os.read(0, 1)
"""
        with Terminal(code, background=True) as t:
            t.until(b"VIEW=100x30")
            native_bytes = 0
            started = time.monotonic()
            sizes = [(81 + index, 24 + index % 7) for index in range(50)]
            for index, (width, height) in enumerate(sizes):
                t.resize(width, height)
                t.until(f"VIEW={width}x{height}".encode())
                until = started + (index + 1) * 0.04
                while time.monotonic() < until:
                    t.pump(min(0.02, max(0, until - time.monotonic())))
            # The child stays quiet after the final redraw: recovery cannot
            # depend on another update happening to arrive later.
            after = t.health(lambda h: h["painting_safe"])
            t.health(lambda h: h["painting_safe"] and h["frames"] > after["frames"] + 2)
            t.send(b"q")
            status, output = t.finish()
            self.assertEqual(status, 0)
            for width, height in [(100, 30), *sizes]:
                frame = (f'\x1b[?2026h\x1b[0m\x1b[2J\x1b[HVIEW={width}x{height}'
                         '\x1b[2;1H\x1b[48;2;30;40;50m   \x1b[0m'
                         '\x1b[3;1H界🌍\x1b[?2026l').encode()
                self.assertEqual(output.count(frame), 1)
                native_bytes += len(frame)
            self.assertEqual(json.loads(t.metrics.read_text())["native_bytes"], native_bytes)

    def test_exit_codes_and_missing_executable(self):
        for status in (0, 1, 7, 130):
            with self.subTest(status=status), Terminal(f"raise SystemExit({status})") as t:
                self.assertEqual(t.finish()[0], status)
        with Terminal(RAW + "import signal; os.kill(os.getpid(), signal.SIGKILL)") as t:
            self.assertEqual(t.finish()[0], 128 + signal.SIGKILL)
        with Terminal("", args=["/definitely/missing/sbg-term-fixture"]) as t:
            self.assertEqual(t.finish()[0], 127)

    def test_signal_restores_modes_and_termios(self):
        modes = b"\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h\x1b[>1u\x1b[>4;2m\x1b[?2031h\x1b]8;;https://example.invalid\x1b\\"
        code = RAW + f"import signal, time; signal.signal(signal.SIGINT, signal.SIG_DFL); os.write(1, {modes!r} + b'READY'); time.sleep(20)"
        for sent in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sent), Terminal(code) as t:
                t.until(b"READY")
                os.kill(t.process.pid, sent)
                status, output = t.finish()
                self.assertEqual(status, 128 + sent)
                for sequence in [b"\x1b[?1049l", b"\x1b[?25h", b"\x1b[?2004l", b"\x1b[?1004l", b"\x1b[?1003l", b"\x1b[?1006l", b"\x1b[<1u", b"\x1b[>4;0m", b"\x1b[?2031l", b"\x1b]8;;\x1b\\"]:
                    self.assertIn(sequence, output)

    def test_termination_of_an_unresponsive_child_is_bounded(self):
        code = RAW + "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); os.write(1, b'READY'); time.sleep(30)"
        with Terminal(code) as t:
            t.until(b"READY")
            t.process.terminate()
            self.assertEqual(t.finish(timeout=8)[0], 128 + signal.SIGKILL)

    def test_partial_sgr_clients_can_render_without_emitting_a_full_reset(self):
        code = RAW + "import time; os.write(1, b'\x1b[2J\x1b[H\x1b[1mREADY\x1b[22m\x1b[39m'); time.sleep(1)"
        with Terminal(code, background=True) as t:
            self.assertEqual(t.finish()[0], 0)
            self.assertGreater(json.loads(t.metrics.read_text())["frames"], 0)

    def test_child_stop_restores_tty_and_continues(self):
        with Terminal(RAW + "import signal; os.write(1, b'BEFORE'); os.kill(os.getpid(), signal.SIGSTOP); os.write(1, b'AFTER')") as t:
            t.until(b"BEFORE")
            t.stopped()
            os.kill(t.process.pid, signal.SIGCONT)
            status, output = t.finish()
            self.assertEqual((status, output), (0, b"BEFOREAFTER"))

    def test_resume_requests_a_fresh_redraw_and_recovers_animation(self):
        code = RAW + """
import signal
def redraw(*_):
    size = os.get_terminal_size(0)
    os.write(1, f'\x1b[2J\x1b[H\x1b[0mREDRAW={size.columns}x{size.lines};'.encode())
signal.signal(signal.SIGWINCH, redraw)
redraw()
os.read(0, 1)
os.write(1, b'STOPPING')
os.kill(os.getpid(), signal.SIGSTOP)
while os.read(0, 1) != b'q':
    pass
"""
        for changed_size in (False, True):
            with self.subTest(changed_size=changed_size), Terminal(code, background=True) as t:
                before = t.health(lambda h: h["frames"] > 0 and h["painting_safe"])
                t.send(b"s")
                t.until(b"STOPPING")
                t.stopped()
                if changed_size:
                    t.resize(132, 42)
                os.kill(t.process.pid, signal.SIGCONT)
                size = "132x42" if changed_size else "100x30"
                marker = f"REDRAW={size};".encode()
                t.health(lambda h: h["frames"] > before["frames"] + 2 and h["painting_safe"])
                self.assertGreaterEqual(t.output.count(marker), 1 if changed_size else 2)
                t.send(b"q")
                self.assertEqual(t.finish()[0], 0)

    def test_external_stop_does_not_trust_the_display_on_continue(self):
        code = RAW + """
import signal
def redraw(*_):
    os.write(1, b'\x1b[2J\x1b[H\x1b[0mREDRAW;')
signal.signal(signal.SIGWINCH, redraw)
redraw()
os.read(0, 1)
"""
        with Terminal(code, background=True) as t:
            before = t.health(lambda h: h["painting_safe"] and h["frames"] > 0)
            os.kill(t.process.pid, signal.SIGSTOP)
            try:
                # SIGSTOP cannot run the wrapper's managed suspension cleanup.
                t.stopped(restored=False)
                # Simulate a shell restoring its own input settings and another
                # job changing this private outer display while we are stopped.
                termios.tcsetattr(t.slave, termios.TCSANOW, t.original)
                other_job = b'\x1b[10;10HOTHER JOB'
                deadline = time.monotonic() + 5
                while other_job:
                    self.assertLess(time.monotonic(), deadline, "outer PTY stayed blocked")
                    try:
                        other_job = other_job[os.write(t.slave, other_job):]
                    except BlockingIOError:
                        t.pump()
            finally:
                os.kill(t.process.pid, signal.SIGCONT)
            t.health(lambda h: h["painting_safe"] and h["frames"] > before["frames"] + 2)
            self.assertGreaterEqual(t.output.count(b"REDRAW;"), 2)
            self.assertEqual(t.attributes()[3] & (termios.ICANON | termios.ECHO), 0)
            t.send(b"q")
            self.assertEqual(t.finish()[0], 0)

    def test_background_does_not_split_escape_sequences_or_utf8(self):
        code = RAW + """
import time
os.write(1, b'\x1b[2J\x1b[H\x1b[0mREADY')
time.sleep(0.4)
os.write(1, b'\x1b]0;BEGIN')
time.sleep(0.25)
os.write(1, b'END\x07')
os.write(1, bytes([0xf0, 0x9f]))
time.sleep(0.25)
os.write(1, bytes([0x8c, 0x8d]))
time.sleep(0.4)
"""
        with Terminal(code, background=True) as t:
            status, output = t.finish()
            self.assertEqual(status, 0)
            self.assertIn(b"\x1b]0;BEGINEND\x07", output)
            self.assertIn("🌍".encode(), output)
            metrics = json.loads(t.metrics.read_text())
            self.assertGreater(metrics["frames"], 1)
            self.assertGreater(metrics["background_bytes"], 100)

    def test_default_studio_runs_in_process_and_reports_health(self):
        with Terminal(RAW + "import time; os.write(1, b'\x1b[2J\x1b[H\x1b[0mREADY'); time.sleep(2)", background=True,
                      env={"SBG_SCRIPT": str(ROOT / "plugins/fx/world.lua")}) as t:
            status, _ = t.finish()
            self.assertEqual(status, 0)
            runtime = json.loads((t.path / "state/runtime.json").read_text())
            self.assertEqual(runtime["backend"], "own")
            self.assertEqual(runtime["status"], "running")
            self.assertEqual(runtime["active"]["kind"], "script")
            self.assertGreater(json.loads(t.metrics.read_text())["frames"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
