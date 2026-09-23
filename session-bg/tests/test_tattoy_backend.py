"""Backend selection and safe, reproducible source preparation."""
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_sbg import ROOT, sbg

spec = importlib.util.spec_from_file_location("build_tattoy", ROOT / "scripts/build-tattoy.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BackendTests(unittest.TestCase):
    def test_managed_binary_and_explicit_override(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"XDG_DATA_HOME": tmp}):
            with patch.dict(os.environ):
                os.environ.pop("SBG_TATTOY", None)
                with patch.object(sbg.shutil, "which", return_value="/system/tattoy"):
                    self.assertEqual(sbg.tattoy_binary(), "/system/tattoy")
                    managed = Path(tmp) / "sbg/tattoy/bin/tattoy"
                    managed.parent.mkdir(parents=True)
                    managed.write_text("#!/bin/sh\nexit 0\n")
                    managed.chmod(0o755)
                    self.assertEqual(sbg.tattoy_binary(), str(managed))
                    os.environ["SBG_TATTOY"] = "/system/tattoy"
                    self.assertEqual(sbg.tattoy_binary(), "/system/tattoy")

    def test_invalid_override_does_not_silently_fall_back(self):
        with patch.dict(os.environ, {"SBG_TATTOY": "/missing/sbg-tattoy"}):
            with self.assertRaises(SystemExit):
                sbg.tattoy_binary()

    def archive(self, name, symlink=False):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            item = tarfile.TarInfo(name)
            if symlink:
                item.type = tarfile.SYMTYPE
                item.linkname = "/tmp/outside"
                archive.addfile(item)
            else:
                item.size = 3
                archive.addfile(item, io.BytesIO(b"abc"))
        return data.getvalue()

    def test_extract_strips_root_and_rejects_escape_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            builder.extract(self.archive("release/src/main.rs"), root)
            self.assertEqual((root / "src/main.rs").read_bytes(), b"abc")
            for data in (self.archive("release/../../outside"), self.archive("release/link", True)):
                with self.assertRaises(ValueError):
                    builder.extract(data, root)
            self.assertFalse((Path(tmp) / "outside").exists())
