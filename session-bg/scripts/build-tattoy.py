#!/usr/bin/env python3
"""Build the pinned Tattoy compatibility fixes; verify before selecting for sbg."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "patches/tattoy-0.1.8-compat.patch"
REVISION = "b1af54b4bc6a1ec5288f865bb4af19f09facf286"
SOURCES = (
    (f"https://codeload.github.com/tattoy-org/tattoy/tar.gz/{REVISION}",
     "166532fa4599f314352b62eb5d2c5a981bc13a4c064bdcb785c68cdec6ba1939", ""),
    ("https://crates.io/api/v1/crates/shadow-terminal/0.2.3/download",
     "7ab4566cd23dd35d3fd0425052ed3a80663d7a2cdad7122e6f64fc71a5aefcfd", "shadow-terminal"),
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recipe() -> dict:
    return {"revision": REVISION, "patch_sha256": digest(PATCH), "sources": [s[1] for s in SOURCES]}


def install_root() -> Path:
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return base / "sbg/tattoy"


def installed() -> bool:
    root = install_root()
    try:
        record = json.loads((root / "build.json").read_text())
        return (record["recipe"] == recipe() and os.access(root / "bin/tattoy", os.X_OK)
                and record["binary_sha256"] == digest(root / "bin/tattoy"))
    except (OSError, ValueError, KeyError):
        return False


def extract(data: bytes, destination: Path) -> None:
    """Strip one archive directory; reject links and path traversal."""
    destination = destination.resolve()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"unsupported archive entry: {member.name}")
            parts = Path(member.name).parts
            target = destination.joinpath(*parts[1:]).resolve()
            if destination not in target.parents:
                raise ValueError(f"unsafe archive path: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify installed recipe and executable; do not build")
    parser.add_argument("--build-dir", type=Path, help="reuse a dedicated build directory")
    args = parser.parse_args()
    if installed():
        print(f"ok Tattoy compatibility build: {install_root() / 'bin/tattoy'}")
        return 0
    if args.check:
        print("Tattoy compatibility build missing or stale; run python3 scripts/build-tattoy.py", file=sys.stderr)
        return 1
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "sbg"
    cache.mkdir(parents=True, exist_ok=True)
    build = (args.build_dir or cache / ("tattoy-build-" + recipe()["patch_sha256"][:12])).resolve()
    with (cache / "tattoy-build.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if installed():
            return 0
        marker = build / ".sbg-recipe.json"
        if not marker.exists() or json.loads(marker.read_text()) != recipe():
            if build.exists() and any(build.iterdir()):
                raise SystemExit(f"Refusing to overwrite a different build directory: {build}")
            build.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="tattoy-source-", dir=build.parent) as tmp:
                source = Path(tmp) / "source"
                for url, expected, subdir in SOURCES:
                    print(f"Downloading {url}", flush=True)
                    data = urllib.request.urlopen(url, timeout=60).read()
                    if hashlib.sha256(data).hexdigest() != expected:
                        raise SystemExit(f"Source checksum mismatch: {url}")
                    extract(data, source / subdir)
                subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=source, check=True)
                subprocess.run(["git", "apply", str(PATCH)], cwd=source, check=True)
                (source / marker.name).write_text(json.dumps(recipe(), indent=2) + "\n")
                os.replace(source, build)
        subprocess.run(["cargo", "build", "--release", "--locked", "-p", "tattoy"], cwd=build, check=True)
        subprocess.run(["cargo", "test", "--release", "--locked", "-p", "tattoy", "sbg_compat_tests"], cwd=build, check=True)
        binary = build / "target/release/tattoy"
        subprocess.run([sys.executable, str(ROOT / "scripts/color-smoke.py"), str(binary)], check=True)
        subprocess.run([sys.executable, str(ROOT / "scripts/input-smoke.py"), str(binary)], check=True)
        destination = install_root()
        (destination / "bin").mkdir(parents=True, exist_ok=True)
        # Atomic replacement leaves already-running sessions intact.
        with tempfile.NamedTemporaryFile(dir=destination / "bin", delete=False) as file:
            staged = Path(file.name)
        try:
            shutil.copy2(binary, staged)
            staged.chmod(0o755)
            os.replace(staged, destination / "bin/tattoy")
        finally:
            staged.unlink(missing_ok=True)
        (destination / "build.json").write_text(json.dumps({"recipe": recipe(), "binary_sha256": digest(binary)}, indent=2) + "\n")
        if not installed():
            raise SystemExit("Installed backend verification failed")
        print(f"Installed {destination / 'bin/tattoy'}; new sbg sessions use this build.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
