---
title: LayoutStore on the Manor server — apply, persist, broadcast
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# LayoutStore on the Manor server — apply, persist, broadcast

ADR-179 D1, D3 (server-derived `paneSessions`, closed stack). After this
ticket the server can own layout; the desktop renderer switches over in
ticket 3. Ship this with the renderer **still** saving through the old path so
the two can be compared; ticket 3 deletes the old path.

## `electron/layout/layout-store.ts` (new)

```ts
class LayoutStore {
  constructor(persistence: LayoutPersistence, broadcast: (ws: string, v: number, layout: WorkspaceLayout, claims: Claims) => void, backend: LocalBackend)
  load(): void                      // v2/v3 file → memory; migration below
  getAll(): Record<workspacePath, { version, layout, defaultViewport }>
  get(workspacePath): { version, layout } | null
  ensure(workspacePath): ...        // a fresh single-panel layout, as createSinglePanelLayout does
  apply(workspacePath, command: LayoutCommand, origin: { kind: "window" | "bridge" | "route"; id: string }): { version } | { error }
  remove(workspacePath): void       // removeWorkspaceLayout
  onPtyEvent(event: StreamEvent): void   // cwd/title/agentStatus → paneSessions
  reportViewport(workspacePath, rendererId, viewport): void   // ticket 4 fills the shape; land the method now
}
```

- `apply` runs `applyLayoutCommand` from `src/lib/layout/commands.ts`, bumps
  `version`, runs `effects.killPanes` through `backend.pty.kill` (terminal
  panes only — check `contentType`), schedules a debounced persist (300 ms,
  flush on `before-quit`), and broadcasts. Serialize `apply` per workspace
  with a simple promise chain so two commands cannot interleave.
- `paneSessions` — subscribe to `backend.pty.onEvent` in `app-lifecycle.ts`
  next to the existing forwarders; `cwd`/`title`/`agentStatus` events update
  the pane's `paneSessions` entry in memory (no broadcast for these — the
  renderer already receives the PTY event itself; they only need to be *in the
  file*). `daemonSessionId` is the `paneId` (see `ipc/pty.ts` `ptyCreate`).
- **Persistence v3** in `terminal-host/layout-persistence.ts`:
  `PersistedLayout.version: 3`, each workspace gains `defaultViewport:
  { activePanelId, selectedTabIds: Record<panelId, tabId>, focusedPaneIds:
  Record<tabId, paneId> }`, and the tree keeps its fields for this ticket
  (ticket 4 strips them). Migration v2→v3: copy the focus fields into
  `defaultViewport`; idempotent; never drops a tab; unit-tested against a
  captured v2 fixture with two workspaces, pinned tabs and a browser pane.
  `LayoutPersistence.save` writes the whole file from memory — the
  read-modify-write in `saveWorkspace` goes.

## Bridge and IPC

- `electron/ipc/layout.ts` — lifted functions `layoutGetAll`, `layoutApply`,
  `layoutReportViewport`; `ipcMain.handle("layout:getAll" | "layout:apply" |
  "layout:reportViewport")`. Keep `layout:save`/`layout:load` working for one
  more ticket.
- `electron/remote-control/ws-handlers.ts` — `layout.getAll`, `layout.apply`
  (in `MUTATING`, target = `workspacePath`), `layout.reportViewport`.
  `layout.save` keeps refusing until ticket 3 deletes it.
- `electron/renderer-broadcast.ts` — `publishRendererBroadcast("layout",
  "changed", { workspacePath, version, layout, claims })` to windows **and**
  the bridge; add `layout.changed` to `ws-bridge-server.ts`'s name table.
- `electron/preload.ts`, `src/electron.d.ts` — `layout.getAll()`,
  `layout.apply(workspacePath, command)`, `layout.reportViewport(...)`,
  `layout.onChanged(cb)`.

## Wiring

`electron/app-lifecycle.ts` — construct `LayoutStore` with
`layoutPersistence`, `backend`, and the broadcaster; `load()` before the
window is created; add to `IpcDeps` (and `ControlDeps` for ticket 5).

## Tests

- `electron/layout/__tests__/layout-store.test.ts` — apply → version bumps
  and broadcast fires with the reduced layout; two rapid applies serialize;
  `close-pane` on a terminal pane calls `backend.pty.kill` once and on a diff
  pane never; unknown workspace → `ensure` creates; persist is debounced and
  flushed; v2 fixture migrates to v3 and a second load is a no-op.
- `ws-bridge.test.ts` — `layout.apply` resolves and audits with the workspace
  as target; a subscribed socket receives `layout.changed`.

## Files to touch
- `electron/layout/layout-store.ts` — new
- `electron/terminal-host/layout-persistence.ts` — v3, migration, whole-file save
- `electron/ipc/layout.ts`, `electron/ipc/types.ts` — handlers, `IpcDeps.layoutStore`
- `electron/routes/types.ts` — `ControlDeps.layoutStore` (used in ticket 5)
- `electron/remote-control/ws-handlers.ts`, `ws-bridge-server.ts`, `electron/renderer-broadcast.ts` — bridge side
- `electron/app-lifecycle.ts` — construct, `onPtyEvent`, flush on quit
- `electron/preload.ts`, `src/electron.d.ts` — API
- tests as listed
