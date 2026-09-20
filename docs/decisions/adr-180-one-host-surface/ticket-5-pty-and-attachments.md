---
title: pty moves to the table, and viewers become connections
status: todo
priority: critical
assignee: opus
blocked_by: [3, 4]
---

# pty moves to the table, and viewers become connections

ADR-180 D6. The first namespace to actually cross, and the one that proves the
design: it is the hottest path in the app, it has per-pane subscriptions, and
it is where winsize ownership lives.

## The handlers

`pty.create/write/resize/reset/close/detach` are already on the table and
already decorated. Add the two that are not: `pty.consumePrewarmed` and
`pty.updatePrewarmCwd`, both `LOCAL_ONLY` — a prewarmed session belongs to the
window that asked for one, and ADR-178's comment saying so stays as the reason.

Delete `register()` from `electron/ipc/pty.ts`; the lifted functions stay and
the file becomes handler implementation. `electron/ipc/__tests__/pty-pending-command.test.ts`
keeps testing the lifted functions.

## Attachments

`electron/pty-attachments.ts` today mixes `{kind:"desktop", id:number}` (a
`webContents.id` from `ipcMain.handle`) with `{kind:"bridge", id:string}` (a
socket). Collapse both into the connection:

```ts
export interface Viewer { connectionId: string; callerClass: "local" | "device" }
```

Ownership (ADR-179 D6, with D6 of this ADR's repair):

1. A `local` viewer outranks a `device` viewer.
2. Among viewers of the same class, the most recent attach wins.
3. On release, recompute and push `pty.winsizeOwner` to every viewer of the
   pane whose owner-ness changed.

This makes `isDesktopAttached(paneId)` into
`ownerOf(paneId)?.callerClass === "local"`, and it makes `createShaped` run
for **every** caller — a second desktop window on the same pane is now a
follower instead of a resize fight. Keep the existing tests and add one for
local-vs-local.

## The renderer

`pty.*` leaves `manorHost.native`, so the proxy sends it over the transport.
`useTerminalStream`'s subscriptions become `pty.onOutput(paneId, cb)` on the
bridge — the same method name, now a `subscribe` frame with `key = paneId`.
`app-lifecycle.ts` stops sending the `pty-output-${id}` family; the
`BridgeServer` is the only producer (ticket 4 left this for here).

`onWinsizeOwner` stops being a no-op on the desktop: delete the stub in
`preload.ts` and let `useTerminalResize` flip between fit and follower on a
desktop window exactly as it does in a browser.

## Watch for

- **Sequencing.** ADR-159's warm-restore drops output a snapshot already
  covers, using the `seq` that rides with `pty.output`. The frame carries it
  today for the browser; make sure the desktop path still gets it and that the
  subscribe frame is sent *before* `pty.create` resolves, or the first bytes
  of a new shell are lost.
- **Throughput.** Structured clone, not JSON: the IPC transport must pass the
  frame object straight to `webContents.send`. Run something loud
  (`yes`, a big `git log`) in a desktop pane and confirm it is not slower.
- ADR-163/164/165 are the three records about a viewer's grid disagreeing with
  the PTY. Do not resize from a follower.

## Files to touch
- `electron/bridge/handlers.ts` — `pty.consumePrewarmed`, `pty.updatePrewarmCwd`, `LOCAL_ONLY` entries
- `electron/ipc/pty.ts` — delete `register()`, keep the lifted functions
- `electron/pty-attachments.ts` — one `Viewer` shape, ownership rules 1–3
- `electron/bridge/server.ts` — ownership push uses the new shape
- `electron/app-lifecycle.ts` — stop sending `pty-*` per-pane channels
- `electron/preload.ts` — remove the `pty` namespace and the `onWinsizeOwner` stub
- `src/hooks/useTerminalStream.ts`, `src/hooks/useTerminalResize.ts` — follower flag now applies on the desktop
- `electron/__tests__/pty-attachments.test.ts` — local-vs-local ownership
