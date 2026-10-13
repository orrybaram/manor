---
title: Foreign winsize hold in the attachments registry
status: todo
priority: high
assignee: opus
blocked_by: [3]
---

# Foreign winsize hold in the attachments registry

"Another daemon client holds this pane" (ADR-218 D5) is patched in five places:
- `BridgeServer` option `heldElsewhere` (was `server-core.ts:78-84,113,129,530`)
- `refreshWinsizeOwner` public wrapper (`server-core.ts:510-512`)
- `createShaped(..., forceFollower = false)` in `bridge/handlers/pty.ts:170-188`, now exported
- `hostPtyResize`, `hostPtyClaimWinsize` in `host-server/handlers.ts:218-234` (only add an `isForeign` check)
- `hostPtyCreate` computes `hasOtherClients(session.attachedClients, ownSocketsFor(paneId))` (`handlers.ts:182-187`) and `winsize.tick` recomputes it with a hard-coded `1` (`winsize.ts:94`), reading `ownerOf` directly
- two wires in `host-server/server.ts` (~245, 290)

`electron/.../pty-attachments.ts` is the winsize-owner registry, and its header says this logic moves into the daemon when there is no Electron main.

## Do

1. Add a foreign hold to `pty-attachments.ts`: `setForeign(paneId, on: boolean)`. `ownerOf` checks it before claims and returns a sentinel foreign viewer (e.g. `{ connectionId: FOREIGN_CONNECTION_ID, callerClass: … }`). Flipping it calls the existing `notifyChanged`, so the `onAttachmentChange` sink pushes `owner:false` to everyone.
2. Then: `wouldOwn` is false for devices, `ptyResize` drops non-owner resizes as it already does, `claim` loses to the hold. Delete `heldElsewhere`, `refreshWinsizeOwner`, `forceFollower`, `hostPtyResize`, `hostPtyClaimWinsize`, and the two server wires. The host table lists the desktop `pty.resize` / `pty.claimWinsize` handlers directly.
3. `winsize.ts`: compute "other clients" once (own sockets = attachment holders, not `ownerOf`); call `setForeign`. `hostPtyCreate` reads the registry rather than recomputing.
4. If clean, widen `Viewer.callerClass` to `CallerClass` and drop `asViewer`'s owner→device collapse (`pty.ts:127-132`), with explicit ranking in pty-attachments.
5. Update `host-server/__tests__/winsize-and-away.test.ts` and pty attachment tests; add a unit test for `setForeign` in the registry.

## Files to touch
- `electron/**/pty-attachments.ts` (find it), its tests
- `electron/bridge/server.ts`, `electron/bridge/handlers/pty.ts`
- `electron/host-server/handlers.ts`, `winsize.ts`, `server.ts`
- `electron/host-server/__tests__/winsize-and-away.test.ts`
