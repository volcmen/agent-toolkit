#!/bin/sh
# Link sbg into ~/.local/bin and the fish auto-wrap into ~/.config/fish/conf.d.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$HOME/.local/bin" "$HOME/.config/fish/conf.d"
ln -sfn "$root/bin/sbg" "$HOME/.local/bin/sbg"
ln -sfn "$root/fish/sbg-auto.fish" "$HOME/.config/fish/conf.d/sbg-auto.fish"
if [ ! -x "$root/plugins/target/release/sbg-fx" ]; then
    (cd "$root/plugins" && cargo build --release --quiet)
fi
echo "linked: ~/.local/bin/sbg, ~/.config/fish/conf.d/sbg-auto.fish (open a new fish shell)"
