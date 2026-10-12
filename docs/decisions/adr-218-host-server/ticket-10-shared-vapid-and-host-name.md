---
title: Shared VAPID key and host name in the hello
status: in-progress
priority: high
assignee: sonnet
blocked_by: [6, 7, 8]
---

# Shared VAPID key and host name in the hello

ADR-218 D3 (push) and D7. Both gaps were found while building ticket 8.

## Shared VAPID key
- A browser service worker holds one push subscription, tied to one VAPID key (`src/.../web-push.ts` replaces the subscription when the key differs). With a different key per server, only the last-opened room would get pushes.
- Add an owner-only method `hostServer.setVapidKeys({ publicKey, privateKey })`:
  - It stores the keys through the host's `PushManager` and `SecretBox`.
  - It replaces the host's own keys.
  - When the key actually changes, it clears the existing subscriptions, because they were made against the old key and would fail. The phone re-subscribes on its next load.
  - It is idempotent when the key is unchanged.
- `PushManager` gains a way to import a keypair. Keep `vapidPublicKey` returning the active key.
- Desktop: `HostServerSync` sends the desktop's VAPID keypair after every owner-channel connect, alongside the manifest and layout. Read it from the desktop `PushManager`; never generate a new one for this.
- The phone: with one shared key, `subscribePush` on any room reuses the same browser subscription, so the endpoint is the same everywhere. Make sure the web app calls `subscribePush` once per connected room (each server stores the endpoint), without unsubscribing first.
- Push dedupe (ticket 7) now works by that shared endpoint. Check it with a test.

## Host name in the hello
- Add optional `hostName: string` to the hello reply (`HelloReplyFrame` in `electron/bridge/types.ts`).
- The host server sends `os.hostname()`, or a name the desktop sets. Include `hostName` in `syncManifest`'s payload (the desktop's display name for that host, from its hosts record) and prefer it when present.
- The desktop server sends its own name (`os.hostname()`), so the phone's pairings show real names for every room.
- The web app already reads `hostName` from the hello (ticket 8, `install-web.ts`).

## Tests
- `setVapidKeys` stores the keys, clears subscriptions only when the key changes, and is owner-only.
- A host server that received the desktop's key reports the same `vapidPublicKey`.
- The hello carries `hostName`, and the manifest's name wins.
- The web app keeps one subscription across two rooms that share a key.

## Files to touch
- `electron/remote-control/push.ts`
- `electron/host-server/handlers.ts`, `owner.ts`, `relay.ts`
- `electron/backend/host-server-sync.ts`, `host-server-client.ts`
- `electron/bridge/types.ts`, `electron/bridge/transports/ws.ts` (hello reply)
- `src/` web push subscription code, only if needed
