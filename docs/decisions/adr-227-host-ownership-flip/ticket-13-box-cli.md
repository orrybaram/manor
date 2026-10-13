---
title: The box's manor CLI is answered by the host server
status: in-progress
priority: medium
assignee: opus
blocked_by: [5]
---

# The box's manor CLI is answered by the host server

ADR-227 D8.

Today a CLI request on a remote host takes this path: daemon
`controlRequest`, then the desktop's `RemoteHostConnection.answerControlRequest`,
then `handleRelayedControlRequest` (`electron/app-lifecycle.ts:811-815`,
ADR-189). With the lid closed it fails with "Manor desktop is not connected
to this host".

## Do
- **The host server becomes the daemon's control-relay answerer.** It is a
  daemon client too. Add a daemon-side registration, so the host server
  claims the relay for its namespace and the desktop no longer receives
  relayed requests. Check whether the daemon protocol needs a bump. If it
  does, it restarts the daemon and ends sessions (ADR-185), so prefer a
  backward-compatible message.
- **Route table.** Answer with the existing routes (`electron/routes/*`),
  run over `ServerDeps` with the host's deps:
  - projects, workspaces and folders (`routes/projects.ts`)
  - agents list and launch (`routes/agents.ts`)
  - issues (`issue-backends.ts`)
  - `current-workspace`
  
  Desktop-only routes answer the same "needs Manor desktop" wording. These
  are webview, panes, browser and system (`routes/system.ts` imports
  `shell`).
- **Scoping.** `callerMaySee` (`electron/routes/caller-host.ts`) still
  applies, and every caller counts as local on the host.
- **Desktop side.** Remove `setControlRelaySink` and
  `answerControlRequest`, or keep them only as a fallback for a host whose
  server is not running. Choose one and document the choice in the ticket
  when done.
- **Test.** With no desktop connected, the CLI on the box runs
  `create-workspace` and `list-workspaces`, and the workspace appears to a
  device on the host server.

## Files to touch
- `electron/terminal-host/index.ts`: control relay registration.
- `electron/terminal-host/types.ts`
- `electron/terminal-host/client.ts`
- `electron/host-server/server.ts`
- `electron/routes/*`: retype over `ServerDeps` where needed.
- `electron/routes/caller-host.ts`
- `electron/backend/host-connection.ts`
- `electron/app-lifecycle.ts`
- `electron/host-server/__tests__/cli-relay.test.ts` (new)

## Carried over from ticket 8

- **The desktop's own control routes, MCP and CLI are not routed for adopted hosts.** They write through `ProjectManager` or `workspaceOps` directly, not through `BridgeServer.forward`, so e.g. create-workspace and `POST /agents` for a remote project fail with "Unknown project" once its host is adopted (regression since ticket 6). Route them through `HostRouting` (or the proxy) the same way the bridge does. This ticket touches the control surface anyway; cover it with a test.

## Carried over from ticket 9

- The desktop's HTTP write routes `DELETE /agents/:id`, `PATCH /agents/:id`, `/agents/:id/seen`, and `/sessions/end`'s `agentStatus.signal` still act only on the desktop's own agent store. Reads and `/sessions/send`/`interrupt` resolve adopted hosts' agents; these writes don't. The bridge methods already forward via `byAgent`; make the HTTP routes use the same path.
- Stats-only reads (`process-control` / `processes.killSession` kill counters, the busy-agent count) don't count remote agents. Small; fix if it falls out of the routing work.
