---
title: hostPipe IPC and the renderer host pipe transport
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# hostPipe IPC and the renderer host pipe transport

ADR-228 D4 (main carries frames, renderer pipe).

## Do
- **Main.** Add a native `hostPipe` namespace in the preload, next to the
  other native namespaces in `electron/preload.ts`.
  - **Calls:**
    - `open(hostId) → pipeId`
    - `send(pipeId, text)`
    - `close(pipeId)`
  - **Events:**
    - `hostPipe.frame(pipeId, text)`
    - `hostPipe.closed(pipeId, code)`
  - `open` spawns `server-bridge --viewer` through the host's `HostTransport`.
    Add `openViewerChannel` next to `openServerChannel` in
    `electron/backend/providers/ssh-provider.ts:132` and
    `electron/terminal-host/transport-ssh.ts:395`.
  - Main splits NDJSON into text frames and sends them as they are. It never
    parses them.
  - Pipes are owned per `webContents`. Close them on window close, and on
    the host's `hostLost`.
  - Refuse `open` for a host that isn't adopted or doesn't report
    `viewerBridge`. Use close code `4504`, so the transport treats it as
    "unreachable" and retries.
- **Renderer.**
  - Add `src/bridge/transports/host-pipe.ts`. It implements `Pipe`
    (`src/bridge/transports/ws.ts:48-82`) over `window.manorHost.hostPipe`,
    and declares `unreachableCodes`.
  - `createWsTransport` gains `preAuthenticated: true`: send no hello, and
    treat the first `hello` reply frame as the handshake. `onHello` gets the
    same facts as on the web.
- **Tests.**
  - A unit test for the pipe and transport against a fake `hostPipe`.
  - An integration test with the host-server harness: open a viewer pipe,
    call `projects.getAll`, receive a `projects.changed` event.

## Files to touch
- `electron/preload.ts`, `electron/bridge/transports/ipc.ts` (native list),
  `src/bridge/unavailable.ts` (`hostPipe` is native-only, `unavailable:web` in
  a browser)
- `electron/backend/providers/ssh-provider.ts`,
  `electron/terminal-host/transport-ssh.ts`,
  `electron/terminal-host/transport.ts`
- a new `electron/ipc/host-pipe.ts` (or wherever native IPC modules live)
- `src/bridge/transports/host-pipe.ts` (new), `src/bridge/transports/ws.ts`
