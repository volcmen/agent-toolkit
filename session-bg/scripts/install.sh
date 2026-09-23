#!/bin/sh
# Build the compatible backend and plugin, then link sbg and the PATH shims.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
python3 "$root/scripts/build-tattoy.py"
(cd "$root/plugins" && cargo build --release --workspace --locked --quiet)
exec python3 "$root/bin/sbg" install
