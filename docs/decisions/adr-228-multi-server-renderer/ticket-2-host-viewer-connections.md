---
title: Desktop viewer connections on the host server
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Desktop viewer connections on the host server

ADR-228 D4 (the stream, host side) and D5 (winsize ranking).

## Do
- **`server-bridge --viewer`** (`electron/terminal-host/server-bridge.ts`,
  `manor-host` arg parsing). It is the same as today's owner path, but the
  hello it writes is `{type:"hello", token, viewer:"desktop"}`.
- **The host's bridge records it.**
  - Where `WsBridgeServer` / `BridgeServer` accept the owner hello
    (`electron/host-server/socket.ts`, `electron/bridge/transports/ws.ts`),
    keep `callerClass: "owner"`.
  - Add a connection fact `viewer: "desktop"` that handlers and
    `pty-attachments` can read.
- **Winsize ranking** (`electron/pty-attachments.ts:81-103`). A
  `viewer:"desktop"` connection ranks like `local`, above `owner` and
  `device`. The foreign hold from `electron/host-server/winsize.ts` keeps its
  meaning ("another daemon client is attached").
  - Make sure the host server's own daemon socket and its viewer connections
    don't count as foreign.
- **Layout origin.** A viewer connection's commands carry its own connection
  as origin. Only main's owner channel forwards an origin (`layout.ts:54`).
  Keep that rule.
- **Capabilities and room id.** `hostServer.status()` adds:
  - `capabilities: string[]`, including `"viewer-bridge"`;
  - `roomId`, the hash of the relay public key, as the relay addresses it.
- **On the desktop**, `hosts.list` / `HostStatusInfo` (`src/store/host-store.ts`,
  `electron/bridge/handlers/hosts.ts`) carry `roomId` and `viewerBridge`
  (boolean) from the last status.
- **Tests:**
  - a viewer connection outranks a device for winsize;
  - a device stays the owner when no viewer is mounted;
  - a status read reports the capability and the room id.

## Files to touch
- `electron/terminal-host/server-bridge.ts`, `manor-host` CLI entry
- `electron/host-server/socket.ts`, `electron/host-server/handlers.ts`
  (`hostServer.status`)
- `electron/bridge/types.ts` (connection fact), `electron/bridge/server.ts`
- `electron/pty-attachments.ts`
- `electron/bridge/handlers/hosts.ts`, `src/store/host-store.ts`
- tests under `electron/host-server/__tests__/` and `electron/__tests__/`
