"""Offline tests for the sbg launcher."""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SBG = ROOT / "bin" / "sbg"


def load_sbg():
    spec = importlib.util.spec_from_loader("sbg", loader=None)
    module = importlib.util.module_from_spec(spec)
    code = compile(SBG.read_text(encoding="utf-8"), str(SBG), "exec")
    module.__file__ = str(SBG)
    exec(code, module.__dict__)
    return module


sbg = load_sbg()


class PaletteTests(unittest.TestCase):
    def test_parses_kitty_theme_lines(self):
        colors = sbg.parse_kitty_colors("background #1a1b26\ncolor1 f7768e\n# color2 #000000\nfont_size 13\n")
        self.assertEqual(colors["background"], (0x1A, 0x1B, 0x26))
        self.assertEqual(colors["color1"], (0xF7, 0x76, 0x8E))
        self.assertNotIn("color2", colors)

    def test_palette_has_256_indexes_plus_fg_bg(self):
        text = sbg.build_palette({"color0": (1, 2, 3), "foreground": (9, 9, 9)})
        lines = text.strip().splitlines()
        self.assertEqual(len(lines), 258)
        self.assertEqual(lines[0], "0 = [1, 2, 3]")
        self.assertEqual(lines[16], "16 = [0, 0, 0]")
        self.assertEqual(lines[231], "231 = [255, 255, 255]")
        self.assertEqual(lines[255], "255 = [238, 238, 238]")
        self.assertIn("foreground = [9, 9, 9]", lines)
        self.assertIn("background = [0, 0, 0]", lines)

    def test_ensure_palette_writes_from_theme_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            theme = Path(tmp) / "theme.conf"
            theme.write_text("background #101010\n", encoding="utf-8")
            os.environ["SBG_TATTOY_CONFIG_DIR"] = str(Path(tmp) / "tattoy")
            try:
                written = sbg.ensure_palette(theme)
                self.assertIn("background = [16, 16, 16]", written.read_text(encoding="utf-8"))
                theme.write_text("background #202020\n", encoding="utf-8")
                self.assertIn("background = [16, 16, 16]", sbg.ensure_palette(theme).read_text(encoding="utf-8"))
                self.assertIn("background = [32, 32, 32]", sbg.ensure_palette(theme, force=True).read_text(encoding="utf-8"))
            finally:
                del os.environ["SBG_TATTOY_CONFIG_DIR"]


class EffectChoiceTests(unittest.TestCase):
    def test_explicit_theme_wins(self):
        self.assertEqual(sbg.choose_effect("waves"), "waves")

    def test_auto_is_stable_per_pane_and_varies_across_panes(self):
        os.environ["ZELLIJ_PANE_ID"] = "1"
        first = sbg.choose_effect("auto")
        self.assertEqual(first, sbg.choose_effect("auto"))
        picks = set()
        for pane in range(12):
            os.environ["ZELLIJ_PANE_ID"] = str(pane)
            picks.add(sbg.choose_effect("auto"))
        del os.environ["ZELLIJ_PANE_ID"]
        self.assertGreater(len(picks), 1)

    def test_unknown_theme_exits(self):
        with self.assertRaises(SystemExit):
            sbg.choose_effect("lava")


class ConfigTests(unittest.TestCase):
    def test_rendered_config_has_no_placeholders_and_points_at_plugin(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["XDG_CACHE_HOME"] = tmp
            try:
                path = sbg.render_config("stars", Path("/opt/sbg-fx"), 15, 0.5, "off")
            finally:
                del os.environ["XDG_CACHE_HOME"]
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("@@", text)
            self.assertIn('path = "/opt/sbg-fx"', text)
            self.assertIn('name = "sbg-stars"', text)
            self.assertIn("frame_rate = 15", text)
            self.assertIn("opacity = 0.50", text)
            self.assertIn("show_startup_logo = false", text)

    def test_plain_arguments_pass_straight_through(self):
        self.assertEqual(sbg.command_line(["claude", "--resume"]), "claude --resume")

    def test_whitespace_arguments_become_a_wrapper_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["XDG_CACHE_HOME"] = tmp
            try:
                line = sbg.command_line(["claude", "fix the tests", "--model", "opus"])
            finally:
                del os.environ["XDG_CACHE_HOME"]
            script = Path(line)
            self.assertTrue(script.is_file())
            self.assertTrue(os.access(script, os.X_OK))
            self.assertEqual(script.read_text(encoding="utf-8"), "#!/bin/sh\nexec claude 'fix the tests' --model opus\n")


class CliTests(unittest.TestCase):
    def run_sbg(self, *args, env=None):
        merged = dict(os.environ, **(env or {}))
        return subprocess.run([sys.executable, str(SBG), *args], capture_output=True, text=True, env=merged, check=False)

    def test_dry_run_prints_effect_and_invocation(self):
        result = self.run_sbg("--dry-run", "matrix", "--", "claude", "--resume", env={"SBG_FX": str(SBG)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SBG_EFFECT=matrix", result.stdout)
        self.assertIn("--command 'claude --resume'", result.stdout)

    def test_dry_run_marks_the_session_active(self):
        result = self.run_sbg("--dry-run", "stars", "--", "codex", env={"SBG_FX": str(SBG)})
        self.assertIn("SBG_ACTIVE=1", result.stdout)

    def test_auto_theme_with_double_dash_only(self):
        result = self.run_sbg("--dry-run", "--", "codex", env={"SBG_FX": str(SBG), "ZELLIJ_PANE_ID": "7"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"SBG_EFFECT=(matrix|plasma|waves|stars)")

    def test_missing_command_is_an_error(self):
        result = self.run_sbg("matrix")
        self.assertEqual(result.returncode, 2)

    def test_list(self):
        result = self.run_sbg("--list")
        self.assertEqual(result.stdout.split(), list(sbg.EFFECTS))


class ShimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.shims = root / "shims"
        self.real = root / "real"
        self.shims.mkdir()
        self.real.mkdir()
        for name in ("claude", "codex"):
            (self.shims / name).symlink_to(ROOT / "bin" / "sbg-shim")
            fake = self.real / name
            fake.write_text("#!/bin/sh\necho real\n")
            fake.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def shim(self, name, *args, env=None):
        merged = dict(os.environ)
        for key in ("SBG_ACTIVE", "SBG_AUTO", "SBG_THEME"):
            merged.pop(key, None)
        merged.update(SBG_SHIM_DRY_RUN="1", SBG_FX=str(SBG), PATH=f"{self.shims}:{self.real}:{os.environ['PATH']}")
        merged.update(env or {})
        return subprocess.run([str(self.shims / name), *args], capture_output=True, text=True, env=merged, check=False, stdin=subprocess.DEVNULL)

    def test_interactive_claude_is_wrapped_with_the_real_binary(self):
        result = self.shim("claude", "fix the tests")
        self.assertIn("SBG_EFFECT=", result.stdout, result.stderr)
        self.assertIn("--command", result.stdout)
        script = Path(result.stdout.split("--command ")[1].strip())
        self.assertIn(f"{self.real / 'claude'} 'fix the tests'", script.read_text())

    def test_codex_resume_is_wrapped(self):
        result = self.shim("codex", "resume")
        self.assertIn(f"--command '{self.real / 'codex'} resume'", result.stdout, result.stderr)

    def test_batch_flags_and_subcommands_pass_through(self):
        for call in (("claude", "--version"), ("claude", "-p", "hi"), ("claude", "mcp", "list"), ("codex", "exec", "hi"), ("codex", "--help")):
            result = self.shim(*call)
            self.assertTrue(result.stdout.startswith(f"passthrough: {self.real / call[0]}"), (call, result.stdout, result.stderr))

    def test_disabled_or_nested_passes_through(self):
        self.assertTrue(self.shim("claude", env={"SBG_AUTO": "0"}).stdout.startswith("passthrough:"))
        self.assertTrue(self.shim("claude", env={"SBG_ACTIVE": "1"}).stdout.startswith("passthrough:"))

    def test_theme_override(self):
        result = self.shim("codex", env={"SBG_THEME": "stars"})
        self.assertIn("SBG_EFFECT=stars", result.stdout, result.stderr)

    def test_missing_real_binary_is_an_error(self):
        result = self.shim("claude", env={"PATH": f"{self.shims}:{Path(sys.executable).parent}"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("real binary not found", result.stderr)


class InstallTests(unittest.TestCase):
    def test_install_links_shims_and_doctor_reports_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, SBG_SHIM_DIR=f"{tmp}/shims", SBG_FX=str(SBG), HOME=tmp, SBG_TATTOY_CONFIG_DIR=f"{tmp}/tattoy", XDG_CACHE_HOME=f"{tmp}/cache")
            result = subprocess.run([sys.executable, str(SBG), "install"], capture_output=True, text=True, env=env, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.readlink(f"{tmp}/shims/claude"), str(ROOT / "bin" / "sbg-shim"))
            self.assertTrue(Path(tmp, ".local", "bin", "sbg").is_symlink())
            env["PATH"] = f"{tmp}/shims:{os.environ['PATH']}"
            doctor = subprocess.run([sys.executable, str(SBG), "doctor"], capture_output=True, text=True, env=env, check=False)
            self.assertIn("(linked)", doctor.stdout)
            self.assertIn("PATH order: shims first", doctor.stdout)


if __name__ == "__main__":
    unittest.main()
