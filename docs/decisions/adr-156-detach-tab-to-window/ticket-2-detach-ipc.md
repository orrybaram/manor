---
title: Detach IPC + handoff channel
status: in-progress
priority: critical
assignee: opus
blocked_by: [1]
---

# Detach IPC + handoff channel

Add the main-process ⇄ renderer channels that create a detached window and hand
its serialized tab payload across the process boundary.

## Requirements

Create `electron/ipc/window.ts`, register it in `electron/ipc/index.ts`
(`registerAllIpc`), expose it in `electron/preload.ts` under
`window.electronAPI.window`, and type it in `src/electron.d.ts`.

1. **`window:detachTab`** — `invoke(payload: DetachedTabPayload, spawnBounds:
   { x: number; y: number; width: number; height: number }): Promise<string>`
   - Generate a `windowId` (e.g. `detached-<uuid>`). Do NOT use `Math.random`
     if the environment forbids it — use `crypto.randomUUID()` from `node:crypto`.
   - Call `createDetachedWindow(windowId, spawnBounds)` (from ticket 1).
   - Stash `payload` in a `Map<string, DetachedTabPayload>` keyed by `windowId`.
   - Return `windowId`.

2. **`window:getDetachPayload`** — `invoke(): Promise<DetachedTabPayload | null>`
   - The detached renderer calls this once on boot. Resolve the `windowId` from
     the calling `webContents` (map `event.sender` → the `BrowserWindow` created
     for that id; track the association when creating the window).
   - Return the stashed payload and delete it from the map (one-shot).

3. **`window:getBounds`** — `invoke(): Promise<{ x; y; width; height }>`
   - Return the outer bounds of the calling window (`BrowserWindow.fromWebContents(event.sender).getBounds()`).
   - Used by the drag-out trigger (ticket 5) to decide "released outside window".

4. **Type `DetachedTabPayload`** in a shared location importable by both the
   store and the IPC layer (e.g. a new `src/store/detach-types.ts` or an existing
   shared types module). Shape (finalized in ticket 3, stubbed here):
   ```ts
   interface DetachedTabPayload {
     tab: { id: string; title: string; rootNode: PaneNode; focusedPaneId: string };
     paneState: {
       cwd: Record<string, string | null>;
       title: Record<string, string | null>;
       contentType: Record<string, "terminal" | "browser" | "diff">;
       url: Record<string, string | null>;
       favicon: Record<string, string | null>;
       agentStatus: Record<string, AgentState | null>;
       audioPlaying: Record<string, boolean>;
       audioMuted: Record<string, boolean>;
     };
     sourceWorkspacePath: string;
   }
   ```

## Files to touch
- `electron/ipc/window.ts` — new: the three handlers + payload map + windowId↔window map.
- `electron/ipc/index.ts` — register the new module in `registerAllIpc`.
- `electron/preload.ts` — expose `window.electronAPI.window = { detachTab, getDetachPayload, getBounds }`.
- `src/electron.d.ts` — type the new `window` namespace on `ElectronAPI`.
- `src/store/detach-types.ts` — new: `DetachedTabPayload` type (or place in an existing shared types file).

## Notes
- Payloads must be structured-clone-safe (plain data only) since they cross IPC.
- Keep the `windowId → BrowserWindow` association from ticket 1's registry so
  `getDetachPayload` can identify its caller.
