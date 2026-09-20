---
title: Winsize ownership transfers live; followers are told; theme broadcasts
status: todo
priority: medium
assignee: opus
blocked_by: [3]
---

# Winsize ownership transfers live; followers are told; theme broadcasts

ADR-179 D6, closing ADR-178's recorded slice-1 gaps.

## Server

- `electron/remote-control/ws-bridge-server.ts` — give each `Connection` an
  `id` (`bridge:<n>`); expose `onDisconnect(cb)`.
- `electron/pty-attachments.ts` — viewers are `{ kind: "desktop", id } |
  { kind: "bridge", id }`, attached in order. `ownerOf(paneId)`: a desktop
  viewer if any, else the **most recently attached** bridge viewer, else
  null. `attach`/`release`/`releaseViewer` return `{ changed: paneIds }` where
  the owner changed.
- `ws-handlers.ts` — `pty.create`/`pty.reset` from a bridge attach the
  connection; `pty.close`/`pty.detach` release; disconnect releases all.
  `pty.resize` from a bridge is honoured only if that connection is the
  owner. When ownership changes, publish `pty.winsizeOwner { paneId, cols,
  rows }` **per socket** with `owner: boolean` (the bridge server needs a
  per-connection publish; add it), and to desktop windows as an event they
  ignore for now.
- When a bridge viewer becomes owner, the server does nothing to the PTY —
  the renderer's next fit will resize it.

## Renderer

- `src/hooks/useTerminalLifecycle.ts` — subscribe to `pty.onWinsizeOwner`
  for the pane; `owner: true` → `follower = null` (fit mode, send a fit now);
  `owner: false` → `follower = { cols, rows }` (adopt the grid). The existing
  `applyWinsize` from ADR-178 ticket 5 is the seam.
- `TerminalPane` badge updates live.

## Carried over from ticket 4's report

- The web bridge's `rendererId` (connection id) changes on reconnect, so a
  selection hint addressed to the previous id is dropped. Make the id stable
  across reconnects: the client sends its previous id in `hello`, the server
  reuses it if unclaimed. This also keeps `pty-attachments` viewer identity
  stable across a blip, which the ownership rules below need.

## Theme

- `electron/ipc/theme.ts` — after `theme:setSelected` (and per-project
  override changes) `publishRendererBroadcast("theme", "changed", …)`;
  `theme.onChanged` in preload/bridge; `theme-store.ts` re-reads on it.

## Tests

- `pty-attachments.test.ts` — owner rules, ordering, change detection.
- `ws-bridge.test.ts` — two bridge sockets on a desktop-free pane: the second
  is owner, the first receives `owner:false`; desktop attaches → both get
  `owner:false`; desktop releases → the most recent bridge viewer gets
  `owner:true`; a non-owner `pty.resize` does not reach the backend.
- E2E `web-app.spec.ts` — close the desktop's terminal tab while the browser
  is attached; the follower badge disappears and `readSessionMeta` `cols`
  becomes the browser's.

## Files to touch
- `electron/remote-control/ws-bridge-server.ts`, `ws-handlers.ts`, `electron/pty-attachments.ts`
- `electron/ipc/theme.ts`, `electron/renderer-broadcast.ts`, `electron/preload.ts`, `src/electron.d.ts`
- `src/hooks/useTerminalLifecycle.ts`, `src/components/workspace-panes/TerminalPane/TerminalPane.tsx`, `src/store/theme-store.ts`
- tests as listed
