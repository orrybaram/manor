---
title: The renderer becomes a replica — actions send commands, broadcasts set state
status: in-progress
priority: critical
assignee: opus
blocked_by: [2]
---

# The renderer becomes a replica — actions send commands, broadcasts set state

ADR-179 D1 on the renderer side. After this ticket no renderer writes layout.
This is the largest ticket; keep it strictly to structure — viewport is
ticket 4, detach is ticket 6.

## `src/store/app-store.ts`

- `loadPersistedLayout` → calls `layout.getAll()`; sets `workspaceLayouts`
  and `layoutVersions: Record<path, number>`; rebuilds the per-pane side maps
  from `paneSessions` exactly as today.
- Subscribe once (in `App.tsx`'s mount effect or a store-level init) to
  `layout.onChanged`: if `version > layoutVersions[ws]`, replace
  `workspaceLayouts[ws]` and bump the version; **drop** older or equal
  versions. Also refresh `paneContentType`/`paneUrl` from the leaves, as
  `loadPersistedLayout` does.
- Each structural action (the ~25 from ticket 1) becomes: generate ids →
  build the command → `await window.electronAPI.layout.apply(ws, command)` →
  return. **No `set()` of `workspaceLayouts` in an action.** The broadcast
  does it. Actions that need to act *after* the layout lands (focus the new
  pane, select the new tab) do so from the `onChanged` handler by matching the
  ids they generated — keep a small `pendingFocus: Map<version|id, …>` or
  simply set the viewport optimistically (the pane will exist when the
  broadcast arrives; ticket 4 formalizes viewport).
- Side effects stay where they are but stop closing sessions:
  `closePane*`/`closeTab*` no longer call `pty.close` — the server kills via
  `effects.killPanes`. The **confirmation dialogs** stay in front of sending
  the command (`CloseAgentPaneDialog`, `app-store-close-pane-abandon` semantics).
- Delete: the zustand `subscribe` that saves, `saveActiveWorkspaceLayout`,
  `flushLayoutSave`, `scheduleLayoutSave`, the `beforeunload` flush, and
  `_cachedLayout`. `removeWorkspaceLayout` → `layout.remove` (add the tiny
  handler to ticket 2's set if it is missing).
- Delete the `layout.save` refusal path: `handleLayoutSaveRejection` and its
  test; `layout.save` leaves `ws-handlers.ts`, `ipc/layout.ts`, `preload.ts`,
  `electron.d.ts`. `src/lib/bridge-unavailable-toast.ts` stays (other callers).
- Remove the `src/store/pane-tree.ts` / `panel-tree.ts` shims from ticket 1
  and fix imports.

## Carried over from ticket 2's report

- `layout.getAll()` / `layout.get()` return `paneSessions` per tab — that is
  where the renderer now gets `daemonSessionId`/`lastCwd`/`lastTitle`/
  `lastAgentStatus` for the restore path once `layout.load` goes.
- The server fills `paneMetadata` on closing commands from its own
  `paneSessions`; delete the field from the command types and from the
  senders — the desktop store no longer runs the reducer locally after this
  ticket, so nothing needs it.
- `LayoutPersistence.reconcile` and `getActiveSessionIds` have no production
  callers. Decide: the restore path in `loadPersistedLayout` already derives
  warm/cold/fresh from `layout.getRestoredSessions` client-side — if that
  stays, delete `reconcile`/`getActiveSessionIds` and their tests; if you move
  reconciliation server-side, use them. Prefer deleting; note which.
- `set-pane-title` is a reducer no-op the server turns into a `paneSessions`
  write; the store's `setPaneTitle`/`clearPaneTitle` should send it (and keep
  updating the local `paneTitle` side map immediately, since no broadcast
  follows).

## Pane mount/unmount

`LeafPane`/`TerminalPane` already create the PTY on mount and `detach` on
unmount; a pane that leaves the tree because *another* renderer closed it
unmounts here and detaches — correct, the server already killed it. Verify
the detach-after-kill path does not log an error (`ptyDetach` on a dead
session); make it quiet if it does.

## Boot ordering

`App.tsx` mount: `loadProjects()` and `loadPersistedLayout()` already run in
`Promise.all`; the `onChanged` subscription must be installed **before**
`loadPersistedLayout` resolves so a broadcast in the gap is not lost (a
broadcast with a version ≤ the loaded one is dropped by the guard above, so
double delivery is harmless).

## Tests

- Store tests: rewrite the layout-action tests to assert the **command sent**
  (mock `window.electronAPI.layout.apply`) and that a subsequent
  `onChanged` broadcast lands in `workspaceLayouts`; assert no action mutates
  `workspaceLayouts` directly; assert stale versions are dropped.
- `app-store-close-pane-abandon.test.ts` — the dialog still gates; `pty.close`
  is no longer called by the store; the command is.
- Run the desktop E2E suite (`pnpm test:e2e`) — `smoke`, `workspace-switching`,
  `duplicate-tab`, `sidebar-focus`, `resize-lockup` exercise this path. They
  must pass; fix what they find if it is in this ticket's scope.

## Files to touch
- `src/store/app-store.ts` — the bulk
- `src/App.tsx` — `onChanged` subscription before load
- `src/components/workspace-panes/LeafPane.tsx`, `TerminalPane/` — detach-after-kill quiet
- `src/lib/bridge-unavailable-toast.ts` callers — remove the layout one
- `electron/remote-control/ws-handlers.ts`, `electron/ipc/layout.ts`, `electron/preload.ts`, `src/electron.d.ts` — delete `layout.save`/`layout.load`
- `src/store/pane-tree.ts`, `src/store/panel-tree.ts` — delete shims
- `src/store/__tests__/*` — as listed
