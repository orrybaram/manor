# A stand-in for an inline agent harness: keeps a region at the bottom of the
# screen and repaints it in place, re-measuring on SIGWINCH.
#
# Two things about it matter, and the first one is why this file changed.
#
# The region is a large fraction of the screen, the way an agent mid-turn looks,
# rather than a fixed handful of lines. A short frame always fits, so it never
# provokes the failure where the emulator's grid is shorter than the rows the
# program was told it has: cursor-up clamps at the top of the screen instead of
# reaching the frame it meant to overwrite. This script used to draw five lines
# and was green through exactly that bug.
#
# Only the first line of the region carries the tag, so "on screen once" is one
# match no matter how tall the region is at the time.

TAG="ZQFRAME"

pad=""
i=0
while [ "$i" -lt 1000 ]; do
  pad="$pad="
  i=$((i + 1))
done

remeasure=1
trap 'remeasure=1' WINCH

tagline=""
fillline=""
region=5

measure() {
  remeasure=0
  size=$(stty size 2>/dev/null)
  rows=$(printf '%s' "$size" | cut -d' ' -f1)
  cols=$(printf '%s' "$size" | cut -d' ' -f2)
  [ -n "$cols" ] || cols=80
  [ -n "$rows" ] || rows=24

  width=$((cols - 1))
  [ "$width" -gt 16 ] || width=16

  # Most of the screen, leaving room for the shell prompt above it.
  region=$((rows - 6))
  [ "$region" -gt 3 ] || region=3

  tagline=$(printf '%.*s' "$width" "$(printf '%s%s' "$TAG" "$pad")")
  fillline=$(printf '%.*s' "$width" "$(printf 'x%s' "$pad")")
}

frame() {
  printf '%s\033[K\n' "$tagline"
  i=2
  while [ "$i" -le "$region" ]; do
    printf '%s\033[K\n' "$fillline"
    i=$((i + 1))
  done
}

measure
printf '%s\n' "TUIREADY"
frame
drawn=$region

while :; do
  [ "$remeasure" -eq 1 ] && measure
  # Move back over the block we actually drew and erase it, the way an inline
  # harness does — not over the block we are about to draw, which may differ.
  printf '\033[%dF\033[0J' "$drawn"
  frame
  drawn=$region
  sleep 0.03
done
