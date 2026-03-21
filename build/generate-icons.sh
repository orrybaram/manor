#!/bin/bash
# Generate macOS .icns file from a source PNG image
# Usage: ./generate-icons.sh <source-image.png>

set -euo pipefail

SOURCE="${1:?Usage: $0 <source-image.png>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ICONSET_DIR="$SCRIPT_DIR/icon.iconset"

if [ ! -f "$SOURCE" ]; then
  echo "Error: Source image not found: $SOURCE"
  exit 1
fi

echo "Creating iconset from: $SOURCE"

# Clean and create iconset directory
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# Generate all required sizes for macOS .icns
# Format: icon_WxH.png and icon_WxH@2x.png
sizes=(16 32 128 256 512)

for size in "${sizes[@]}"; do
  double=$((size * 2))

  echo "  ${size}x${size}"
  sips -z "$size" "$size" "$SOURCE" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null 2>&1

  echo "  ${size}x${size}@2x (${double}x${double})"
  sips -z "$double" "$double" "$SOURCE" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null 2>&1
done

# Convert iconset to .icns
echo "Converting to .icns..."
iconutil -c icns "$ICONSET_DIR" -o "$SCRIPT_DIR/icon.icns"

# Clean up iconset directory
rm -rf "$ICONSET_DIR"

echo "Done! Created: $SCRIPT_DIR/icon.icns"
