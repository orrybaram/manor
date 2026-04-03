---
title: Change notificationSound preference from boolean to string | false
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Change notificationSound preference from boolean to string | false

Update the `notificationSound` preference type across all layers: Electron backend, type definitions, and frontend store. Add backward-compatible migration for existing boolean values.

## Implementation

### `electron/preferences.ts`
- Change `AppPreferences.notificationSound` from `boolean` to `string | false`
- Update `DEFAULTS.notificationSound` from `true` to `"Glass"`
- In `loadState()`, add migration: if `parsed.notificationSound === true`, convert to `"Glass"`; if `false`, keep `false`

### `src/electron.d.ts`
- Change `AppPreferences.notificationSound` from `boolean` to `string | false`

### `src/store/preferences-store.ts`
- Update `defaultPreferences.notificationSound` from `true` to `"Glass"`

## Files to touch
- `electron/preferences.ts` — Type change + migration logic
- `src/electron.d.ts` — Mirror type change
- `src/store/preferences-store.ts` — Update default value
