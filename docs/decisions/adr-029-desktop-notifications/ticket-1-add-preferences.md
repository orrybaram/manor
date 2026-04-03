---
title: Add notification preference keys
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add notification preference keys

Add three new preference keys to the existing preferences system.

## Files to touch

- `electron/preferences.ts` — Add `notifyOnResponse: boolean`, `notifyOnRequiresInput: boolean`, `notificationSound: boolean` to `AppPreferences` interface and `DEFAULTS` (all default `true`)
- `src/electron.d.ts` — Mirror the same three keys in the renderer-side `AppPreferences` interface
- `src/store/preferences-store.ts` — Add the three keys to `defaultPreferences`
