---
title: Main arbitrates winsize among its forwarded callers
status: done
priority: high
assignee: opus
blocked_by: [1, 3]
---

# Main arbitrates winsize among its forwarded callers

ADR-230 D10 (gap R6). Read the ADR's D10 in full first.

## What to build

In `HostRouting.invokePty` (`electron/server/host-routing.ts:323-342`):
- Build `Viewer { connectionId: ctx.caller.id, callerClass, viewer? }`, as
  `asViewer(ctx.caller)` does in `electron/bridge/handlers/pty.ts:99-153`.
- Use main's process-wide `PtyAttachments` registry
  (`electron/pty-attachments.ts`). Pane ids are unique across hosts.
- **create, attach, reset:**
  - if `!wouldOwn(pane, viewer)`, replace the caller's cols and rows with
    the host's current grid. Use the last known size the proxy holds; if
    there is none, use the caller's;
  - forward to the host;
  - `attach` locally;
  - answer with `winsizeOwner = hostOwner && localOwner`.
- **resize:** drop it (answer ok, as `ptyResize` does at pty.ts:289) unless
  `ownerOf(pane)?.connectionId === caller.id`.
- **claimWinsize:** claim locally, then forward.
- **write:** call `reclaimOnInput` locally, then forward.
- **detach:**
  - release the caller locally;
  - forward to the host only when no local holder is left;
  - clear `ptyViewing` only then.
  - Reconcile with `letGo` (:396-405).
- **`winsizeOwner` events for remote panes** (today they come through
  `HostProxy.watchPty` → `publishKeyed` → a keyed bridge publish):
  - deliver each subscriber its own flag, `hostOwner && (local owner is
    this connection)`;
  - add `BridgeServer.publishTo(connectionId, ns, event, args)` in
    `electron/bridge/server.ts`, or expose the private `deliverTo`;
  - re-send on local owner changes too, by hooking the registry's
    attachment-change callback for remote panes.
- **Disconnect.** `releaseViewer` already runs on the registry
  (`server.ts:206,275`). Make sure it triggers the detach-forwarding rule
  above for remote panes.
- Check whether `onOwnerChanged` → `sessionGrid` (`server.ts:73-84`) can
  answer for a remote pane. If it can't, use the proxy's last size.

## Tests (each must fail on the base commit)

In `electron/server/__tests__/host-routing.test.ts`, with the real host
harness, as at :437:
- two forwarded callers (a phone and a fallback window) on one remote pane:
  - only the later or claiming one is `winsizeOwner`;
  - the other's resize doesn't reach the host.
- after the owner detaches, the other caller still receives output (the
  host isn't detached), and becomes owner.
- after the last caller detaches, the host sees one detach.
- `winsizeOwner` events differ per connection.

Also add registry-level cases to `electron/__tests__/pty-attachments.test.ts`
if any registry behaviour changes.

## Files to touch
- `electron/server/host-routing.ts`
- `electron/bridge/server.ts`
- `electron/pty-attachments.ts`, only if needed
- `electron/backend/host-proxy.ts`, if the last-size cache lives there
- Tests named above.
