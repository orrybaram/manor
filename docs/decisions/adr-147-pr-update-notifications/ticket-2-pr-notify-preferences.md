---
title: Add PR notification preferences
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add PR notification preferences

Add four independent boolean preferences for PR-update notifications, following
the existing `notifyOnResponse` pattern exactly.

New keys (all default `true`):
- `notifyOnPrComment`
- `notifyOnPrApproved`
- `notifyOnPrChangesRequested`
- `notifyOnPrChecksFailed`

## Files to touch

- `electron/preferences.ts`
  - Add the four keys to the `AppPreferences` interface.
  - Add them to `DEFAULTS` with value `true`.

- `src/electron.d.ts`
  - Add the four keys to the `AppPreferences` interface (renderer mirror,
    lines 1-13).

- `src/store/preferences-store.ts`
  - Add the four keys with value `true` to the `defaultPreferences` object
    (lines 13-23).

## Notes
- No IPC changes — `preferences:getAll` / `preferences:set` are generic
  key/value passthroughs.
- Keep all three copies of the defaults in sync (this is the known dual/triple
  source-of-truth in this codebase).
