"""Offline tests for the sbg launcher."""
from __future__ import annotations

import importlib.util
import os
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

    def test_whitespace_arguments_are_rejected(self):
        with self.assertRaises(SystemExit):
            sbg.command_line(["sh", "-c", "echo hi"])
        self.assertEqual(sbg.command_line(["claude", "--resume"]), "claude --resume")


class CliTests(unittest.TestCase):
    def run_sbg(self, *args, env=None):
        merged = dict(os.environ, **(env or {}))
        return subprocess.run([sys.executable, str(SBG), *args], capture_output=True, text=True, env=merged, check=False)

    def test_dry_run_prints_effect_and_invocation(self):
        result = self.run_sbg("--dry-run", "matrix", "--", "claude", "--resume", env={"SBG_FX": str(SBG)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SBG_EFFECT=matrix", result.stdout)
        self.assertIn("--command 'claude --resume'", result.stdout)

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


if __name__ == "__main__":
    unittest.main()
