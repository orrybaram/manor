#!/usr/bin/env bash
# Regenerate public/fonts/MesloLGMNerdFontMono-{Regular,Bold}{,-symbols}.woff2
# from the TTFs in scripts/fonts/src (not shipped). Needs `uv`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../public/fonts"
for weight in Regular Bold; do
  uv run --quiet --with 'fonttools[woff]' python "$here/split-terminal-font.py" \
    "$here/src/MesloLGMNerdFontMono-$weight.ttf" \
    "$out/MesloLGMNerdFontMono-$weight.woff2" \
    "$out/MesloLGMNerdFontMono-$weight-symbols.woff2"
done

