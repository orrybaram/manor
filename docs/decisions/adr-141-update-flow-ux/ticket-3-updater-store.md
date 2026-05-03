---
title: Updater zustand store (in-memory state)
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Updater zustand store

Single source of truth for update state. Backs both the AboutModal UI and the toast hook. In-memory only (Q11 — no persistence).

## Required changes

Create `src/store/updater-store.ts`:

```ts
import { create } from "zustand";

export interface UpdaterState {
  pending: { version: string } | null;       // set when update-downloaded fires
  lastChecked: number | null;                // ms epoch; null until first check
  checking: boolean;                         // true between checking-for-update and resolution
  lastTriggerWasManual: boolean;             // whose check are we resolving
  error: string | null;                      // most recent error message; null after success

  triggerManualCheck: () => void;
  clearPending: () => void;
}

export const useUpdaterStore = create<UpdaterState>(...);
```

State transitions (driven by event subscriptions):
- `updater:checking-for-update` ({manual}) → `checking = true`, `lastTriggerWasManual = manual`, `error = null`
- `updater:update-not-available` ({manual}) → `checking = false`, `lastChecked = Date.now()`
- `updater:update-available` → no state change (we wait for downloaded). Optionally bump `lastChecked`.
- `updater:update-downloaded` (info) → `checking = false`, `pending = info`, `lastChecked = Date.now()`
- `updater:error` (msg) → `checking = false`, `error = msg`, `lastChecked = Date.now()`
- `triggerManualCheck()` → set `lastTriggerWasManual = true` *before* invoking, then call `window.electronAPI.updater.checkForUpdates()`. The `checking-for-update` event will overwrite the flag with the value from main, which should agree.

## Initialization

Subscribe to all events at module-init scope (outside the create callback) so the store stays current regardless of which component reads it first. Guard against `window.electronAPI?.updater` being absent (e.g. in tests, or when `!isPackaged` if event channels aren't even wired — though they will be).

```ts
const u = window.electronAPI?.updater;
if (u) {
  u.onChecking(({ manual }) => useUpdaterStore.setState({ checking: true, lastTriggerWasManual: manual, error: null }));
  // ...etc
}
```

## Files to touch
- New: `src/store/updater-store.ts`

## Acceptance
- Store compiles, no runtime errors when imported.
- `pnpm lint` and typecheck pass.
- Manual sanity: import the store in a scratch component and confirm the state shape matches the spec.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-141): Updater zustand store (in-memory state)"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
