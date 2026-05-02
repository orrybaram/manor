---
title: Wire push:start / push:progress / push:cancel IPC channels
status: done
priority: critical
assignee: sonnet
blocked_by: [2]
---

# Ticket 3: IPC channels and preload exposure

Replace the single `git:push` invoke with three channels: a start invoke, a streaming event, and a cancel invoke. Register a `before-quit` cleanup.

## Files to touch

- `electron/ipc/branches-diffs.ts`
  - **Delete** the existing `ipcMain.handle("git:push", ...)` handler.
  - Add a module-level `Map<string, { cancel: () => void }>` keyed by `pushId` (= workspace path) to track in-flight pushes for cancellation.
  - Add `ipcMain.handle("git:push:start", (event, args: { wsPath: string; setUpstream?: boolean }) => { ... })`:
    - Generate `pushId = args.wsPath` (per-workspace dedupe).
    - If a push for this `pushId` already exists in the map, throw `"Push already in progress for this workspace"`.
    - Resolve `webContents` from `event.sender`.
    - Call `backend.git.pushStream(args.wsPath, { setUpstream: args.setUpstream }, { onLine, onDone })`:
      - `onLine(line)` → if `webContents.isDestroyed()` is false, `webContents.send("git:push:progress", { pushId, type: "line", line })`.
      - `onDone({ exitCode, stderr })` → remove from map, then if not destroyed: `webContents.send("git:push:progress", { pushId, type: "done", exitCode, stderr })`.
    - Store `{ cancel }` in the map.
    - Return `{ pushId, startedAt: Date.now() }`.
  - Add `ipcMain.handle("git:push:cancel", (_event, args: { pushId: string }) => { ... })`:
    - Look up entry in map; if found, call `entry.cancel()`. (Do NOT remove from map here — let `onDone` remove it so the done event still fires with the SIGTERM exit code.)
    - Return `void`.
  - Export the active-pushes map (or a `killAllActivePushes()` helper) so `app-lifecycle.ts` can call it on `before-quit`.

- `electron/app-lifecycle.ts`
  - Import the kill-all helper from `branches-diffs.ts` (or wherever it's exported).
  - Register on `app.on("before-quit", () => killAllActivePushes())`. Place near other lifecycle cleanup (search for existing `before-quit` registrations; if none, add a new section).

- `electron/preload.ts`
  - **Delete** the existing `git.push: (wsPath, remote?, branch?) => ipcRenderer.invoke("git:push", ...)`.
  - Add:
    ```ts
    git: {
      // ...existing methods unchanged...
      push: {
        start: (args: { wsPath: string; setUpstream?: boolean }) =>
          ipcRenderer.invoke("git:push:start", args),
        cancel: (pushId: string) =>
          ipcRenderer.invoke("git:push:cancel", { pushId }),
        onProgress: (handler: (evt: PushProgressEvent) => void) => {
          const listener = (_e: unknown, evt: PushProgressEvent) => handler(evt);
          ipcRenderer.on("git:push:progress", listener);
          return () => ipcRenderer.removeListener("git:push:progress", listener);
        },
      },
    }
    ```
  - Define and export the `PushProgressEvent` type:
    ```ts
    export type PushProgressEvent =
      | { pushId: string; type: "line"; line: string }
      | { pushId: string; type: "done"; exitCode: number | null; stderr: string };
    ```
  - Update the `electronAPI` type definition (likely `src/types/electron.d.ts` or co-located in preload — find and update the renderer-facing type).

## Notes

- Track active pushes in a single module-level `Map`, not per-`webContents` — there's only one renderer in this app.
- The done event must always fire, even on cancel. The renderer relies on it to clear the toast spinner state.
- Don't include `errorKind` / `errorMessage` in the done payload — categorization happens in the renderer (ticket 5) using the pure function from ticket 1.
- Verify nothing else references the old `git:push` channel name (grep `"git:push"`). If there are stale references in tests, update them; if there are stale references in untouched callers, surface them in the ticket completion.
