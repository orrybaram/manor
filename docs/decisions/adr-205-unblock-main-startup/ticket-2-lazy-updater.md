---
title: Load electron-updater lazily
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Load electron-updater lazily

See ADR-205 §2.

- `electron/updater.ts`: remove the static `electron-updater` value import
  (type-only imports are fine: `import type { UpdateInfo, ProgressInfo }`).
  Add a memoised `loadUpdater()` doing `(await import("electron-updater")).autoUpdater`
  that also wires the event listeners exactly once (the `send` helper needs
  `getWindow`, so store it module-level when `initAutoUpdater` is called).
- `initAutoUpdater(getWindow)`: still a no-op when not packaged. Stores
  `getWindow`, then `setTimeout(5000)` → load + `checkForUpdates()`; the 4 h
  `setInterval` loads (memoised) then checks. Swallow errors as today.
- `checkForUpdates()` → `async`, sets `lastTriggerWasManual`, loads, checks.
  In dev (not packaged) it should behave as before (today it calls
  `autoUpdater.checkForUpdates()` which errors/no-ops — keep equivalent,
  catching errors so an IPC call doesn't reject noisily unless it did before).
- `quitAndInstall()` → `async`, loads, calls `quitAndInstall()`.
- Update callers: `electron/ipc/misc.ts`, `electron/routes/system.ts`,
  `electron/app-menu.ts` / `app-menu-template.ts` (check the `checkForUpdates`
  type it takes — widen to `() => void | Promise<void>` if needed). Keep tests
  in `routes/system.test.ts`, `control-relay.test.ts`, app-menu tests passing.

## Files to touch
- `electron/updater.ts`
- `electron/ipc/misc.ts`
- `electron/routes/system.ts`
- `electron/app-menu.ts`, `electron/app-menu-template.ts` (types only, if needed)
