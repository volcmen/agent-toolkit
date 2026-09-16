#!/bin/sh
# Build the plugin if needed, then link sbg and the claude/codex PATH shims.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
if [ ! -x "$root/plugins/target/release/sbg-fx" ]; then
    (cd "$root/plugins" && cargo build --release --quiet)
fi
exec python3 "$root/bin/sbg" install
