---
title: Backend updater enhancements (events, interval, isPackaged)
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Backend updater enhancements

Extend the existing updater plumbing so the renderer has the signals needed to drive the new UI.

## Required changes

1. **Forward two missing events** in `electron/updater.ts`:
   - `autoUpdater.on("checking-for-update", ...)` → `win.webContents.send("updater:checking-for-update")`
   - `autoUpdater.on("update-not-available", ...)` → `win.webContents.send("updater:update-not-available", info)`

2. **Periodic recheck**: after the initial 5-second `checkForUpdates()`, register `setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)`. Wrap the call in try/catch the same way the initial one is. No need to clear the interval — runs for app lifetime.

3. **Manual-check signaling**: the renderer needs to know whether a `checking-for-update` event came from a user click or from the auto/interval check. Simplest approach: track a module-level boolean `lastTriggerWasManual` in `electron/updater.ts`. Set it `true` inside the exported `checkForUpdates()` function (which is what the IPC handler calls). Reset it `false` at the start of every `autoUpdater.on("checking-for-update")` callback after forwarding it. Forward it as part of the channel: `win.webContents.send("updater:checking-for-update", { manual: lastTriggerWasManual })`. Also include `{ manual }` on `update-not-available` and `error` so the renderer can decide whether to surface them.

4. **Skip updater entirely in dev**: in `initAutoUpdater`, early-return if `!app.isPackaged`. Import `app` from `electron`. This prevents the swallowed-error noise and matches Q12.

5. **Expose `app.isPackaged` synchronously to renderer**: in `electron/preload.ts`, add to the `electronAPI` object:
   ```ts
   env: {
     isPackaged: process.env.NODE_ENV === "production",  // wrong — see below
   }
   ```
   The correct path: use `process.contextIsolated` is irrelevant; the right approach is to read the flag in main and pass it to the renderer. Two options:
   - **Preferred**: in `main.ts` (or wherever `BrowserWindow` is created), set `additionalArguments: [`--manor-packaged=${app.isPackaged}`]` on `webPreferences`. In preload, parse `process.argv` for this flag and expose `isPackaged: boolean`. Synchronous, no IPC round-trip.
   - **Alternative**: synchronous `ipcRenderer.sendSync("env:isPackaged")` in preload during contextBridge setup, with a matching `ipcMain.on("env:isPackaged", e => { e.returnValue = app.isPackaged })` in main. Slightly more code but fewer moving parts.
   Pick whichever is cleaner given the existing preload structure. Document the choice in a one-line comment.

6. **Update `src/electron.d.ts`**:
   - Add `env: { isPackaged: boolean }` to the `electronAPI` shape.
   - Extend the `updater` block with:
     - `onChecking: (cb: (payload: { manual: boolean }) => void) => () => void`
     - `onUpdateNotAvailable: (cb: (info: { version: string; manual: boolean }) => void) => () => void`
   - Update existing `onError` signature to include `{ manual: boolean }` if you choose to add it (keep it backwards-compatible — second arg or include in object).

7. **Wire the new event subscriptions in `electron/preload.ts`**: add `onChecking` and `onUpdateNotAvailable` to the `updater` block following the `onChannel` pattern already used.

## Files to touch
- `electron/updater.ts` — forward events, interval, manual flag, dev guard
- `electron/preload.ts` — new event subscriptions, env.isPackaged exposure
- `electron/main.ts` or `electron/window.ts` — pass `isPackaged` via `additionalArguments` if going that route
- `src/electron.d.ts` — type updates

## Acceptance
- `pnpm lint` and typecheck pass.
- Running `pnpm dev` produces no updater errors in console (dev guard active).
- A packaged build (`pnpm package`) still initializes the updater.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-141): Backend updater enhancements (events, interval, isPackaged)"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
