---
title: Host server composition and serve entry
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Host server composition and serve entry

ADR-218 D1, D2 and D6. Build `electron/host-server/`, a headless Manor server
for one remote host. Do NOT refactor `initApp()`; compose a new, smaller server
from existing parts.

## Shape
- `createHostServer({ dataDir, daemonNamespace: "remote", secretBox, appInfo })` returns `{ start(), stop(), bridge }`.
  - `dataDir` defaults to `~/.manor/remote/server/`; add `remoteServerDir()` and friends to `electron/paths.ts`.
- Daemon: a `TerminalHostClient` to the local `remote` namespace socket (`~/.manor/remote/daemon/terminal-host.sock`), reached as a plain local client.
- Hooks and status:
  - Subscribe to the daemon's `hookEvent` stream.
  - On start, `replayHooks` from a persisted `lastHookSeq` (and epoch) kept in `dataDir`.
  - Feed every payload through the same ingestion path as `AgentHookServer.ingestHookPayload` (`electron/agent-hooks.ts:78`) into `createAgentStatusDriver` (`electron/agent-status/driver.ts`) and an `AgentManager` that persists `agents.json` in `dataDir`. Every agent here has `hostId: "local"`; the server is local to itself.
- Chat mirror: `ChatMirror` (`electron/chat-mirror/mirror.ts`) with the local transcript source, publishing through the host bridge.
- Bridge: `BridgeServer` from `electron/bridge/server.ts`, with a host handler table defined in `electron/host-server/handlers.ts`.
  - It is an explicit allowlist: `pty` (attach, write, read, create-as-viewer, no spawn), `agents` reads, `projects` reads (from the manifest cache, ticket 4), `layout` reads, `chat`, `preferences` and `theme` reads (defaults), `daemon`.
  - Every other namespace answers `unavailable:host`.
  - `BridgeServer` takes `HostDeps`, which carries Electron objects. Introduce a narrower deps type, or a `HostServerDeps` that satisfies only what the allowlisted handlers read. Do not pass fake `BrowserWindow`s.
- Entry: `electron/host-server/index.ts` handles `serve`. It writes a pid/version file, a unix socket at `dataDir/server.sock`, and a 0600 `dataDir/owner-token`.
  - It shuts down on SIGTERM and logs to `dataDir/logs/`.
- Two-readers test (ADR-218 Consequences): feed one recorded hook journal into the desktop's ingestion path and into the host server's, and assert identical per-pane agent state.

## Files to touch
- `electron/host-server/*` (new)
- `electron/paths.ts`: remote server paths
- `electron/bridge/server.ts`, `electron/ipc/types.ts`: narrow the deps type the bridge needs
- `electron/agent-hooks.ts`: make ingestion usable without the HTTP server, if it isn't already
