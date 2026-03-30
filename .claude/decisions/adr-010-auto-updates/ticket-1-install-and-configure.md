---
title: Install electron-updater and configure build
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Install electron-updater and configure build

## Tasks

1. Install `electron-updater` as a production dependency
2. Update `package.json` build config:
   - Add `"publish": { "provider": "github" }` inside the `"build"` section
   - Change `"mac.target"` from `"dmg"` to `["dmg", "zip"]` (zip is required for Squirrel-based macOS auto-updates)

## Files to touch
- `package.json` — add dependency, update build config
