---
title: createManorServer(platform) shared by initApp and the host server
status: todo
priority: critical
assignee: opus
blocked_by: [1, 2]
---

# createManorServer(platform) shared by initApp and the host server

ADR-227 D1. Behavior must stay the same on both sides: the host server still
reads the owner's manifest and layout in this ticket. The flip is ticket 5.

## Do
- Create `electron/server/platform.ts` with a `Platform` interface:
  - `dataDir`, `secretBox`, `appVersion`, `hostName`
  - `daemonTransport`
  - `notifier` (optional)
  - `windows?: {isPrimary, claimOf, rendererWindows}`
  - `remoteHosts?` (a `BackendRegistry` factory, or the hosts to register)
  - `playSound?`, `appCommandResult?` (from ticket 1)
- Create `electron/server/create-manor-server.ts`. Its
  `createManorServer(platform, opts): ManorServer` composes the shared parts
  in the order `initApp` uses today:
  - daemon client and local backend
  - preferences and theme
  - `ProjectManager`
  - `LayoutPersistence` and `LayoutStore`
  - `workspaceOps`
  - `AgentManager` and `createAgentPipeline`
  - `ChatMirror` and the stream fan-out (`dispatchStreamEvent`)
  - `GitHubManager` and `LinearManager`
  - relay stores
  - `BroadcastBus`
  - `BridgeServer` over a table the caller passes in
  
  It returns:
  - `{deps: ServerDeps, bus, bridge, start(), stop()}`;
  - the parts each caller needs to extend.
  
  `stop()` runs the shared part of today's `performShutdown` order.
- **Desktop.** Rewrite `initApp()` (`electron/app-lifecycle.ts:135`) to call
  `createManorServer(electronPlatform)`. Keep only the Electron-only parts in
  `initApp`: windows, menu, IPC modules, webview server, portless, updater,
  power monitor, hook HTTP server, `bootstrapHost`, and `app` quit hooks.
  - Get rid of the late-bound `let bridgeServer | null`: build the bridge
    after the deps, as the host does.
- **Host.** Rewrite `createHostServer` (`electron/host-server/server.ts:151`)
  to call `createManorServer(hostPlatform)` and add the host-only parts:
  - `OwnerSync` and the snapshot store (still present until ticket 5)
  - winsize
  - the daemon retry loop
  - `HostHookFeed({firstContact: "replayAll"})`
  - the always-on relay room
  
  `HOST_TABLE` keeps its current allowlist.
- Extend `electron/platform/__tests__/electron-free.test.ts` to bundle
  `electron/server/create-manor-server.ts`.
- Afterwards, these must still pass:
  - all `electron/host-server/__tests__`
  - the desktop unit tests
  - `npm run typecheck`

## Files to touch
- `electron/server/platform.ts` (new)
- `electron/server/create-manor-server.ts` (new)
- `electron/app-lifecycle.ts`
- `electron/host-server/server.ts`
- `electron/host-server/agents.ts`: fold this into the shared pipeline if it
  becomes redundant.
- `electron/platform/__tests__/electron-free.test.ts`

## Carried over from ticket 1
- **`Platform` supplies the new optional deps.** Ticket 1 added
  `playSound` and `appCommandResult` as optional `ServerDeps` fields;
  `app-lifecycle.ts` currently sets them directly on `ipcDeps`. `Platform`
  should supply them.
- **Decide three desktop-only methods.** Each one stays desktop-only or
  becomes shared with an optional dep:
  - `diffs.start` passes `mainWindow` to `DiffWatcher.start` as a visibility
    gate;
  - `processes.list` reports `webviewServer`;
  - `keybindings.runInMainWindow`.
- **Make desktop-flavoured `ServerDeps` fields optional** where the host
  has no equivalent: `backendRegistry` remote hosts, `hostServerSync`,
  `remoteForwards` and portless. These belong with the `remoteHosts?`
  port.
