---
title: Shared agent pipeline and Electron-free agent handlers
status: done
priority: high
assignee: opus
blocked_by: [4]
---

# Shared agent pipeline and Electron-free agent handlers

## Problems (verified by review)

- Coalescing hook sink duplicated: `app-lifecycle.ts:402-410`, `host-server/agents.ts:92-127`, `host-server/__tests__/two-readers.test.ts:125-148`. Driver setup duplicated: `app-lifecycle.ts:605-614`, `agents.ts:96-109`, `two-readers.test.ts:126-138`. `resyncPaneFacts` twice: `host-server/server.ts:368-381`, `app-lifecycle.ts:659-667`.
- `two-readers.test.ts` `desktopReader` is a hand copy — the ADR-225 guard test doesn't test `initApp`'s wiring.
- `host-server/handlers.ts:238-267` (agentsGetAll/Get/GetActive/GetRecent/GetPaneStatuses) byte-identical to `bridge/handlers/agents.ts:86-121`. `host-server/server.ts:389-403` `sweepStaleAgents` = `agentsReconcileStale` (`bridge/handlers/agents.ts:320-350`) minus remote-host check. Cause: `bridge/handlers/agents.ts` imports `notifications.ts` → `electron`; desktop `agentsGetUnseen` reads a module global `getUnseenSnapshot`.

## Do

1. New module (e.g. `electron/agent-status/pipeline.ts`): `createAgentPipeline({ agentManager, getPaneContext, getPaneHostId, broadcastAgent, publishPaneStatus, onStatus, clocks })` returning `{ driver, hookSink, ingestion }`; export `coalescingHookSink(ingestion, coalescer)` and `resyncPaneFacts(pty, driver, ids?)`. Use it from `initApp` and `createHostAgents`. Keep it Electron-free.
2. `two-readers.test.ts`: `desktopReader` calls the real factory with the desktop's configuration.
3. Move agent read handlers and `agentsReconcileStale` into an Electron-free module (e.g. `electron/bridge/handlers/agents-read.ts`) typed over `AgentReadDeps` (`agentManager`, `agentStatus`, unseen sets, `backend.pty.listSessions`, optional `isHostConnected` port). Desktop `getUnseen` reads unseen sets from deps (HostDeps already has them) instead of the module global. Host table lists these directly; `host-server/server.ts` calls `agentsReconcileStale` and `sweepStaleAgents` is deleted. Electron-dependent desktop-only handlers stay in `agents.ts`.
4. Host startup: `sweepStaleAgents` and `resyncPaneFacts` share one `listSessions` call.
5. Make sure `electron/platform/__tests__/electron-free.test.ts` (or tarball build check) still passes — the new modules must not pull in electron.

## Files to touch
- `electron/agent-status/pipeline.ts` (new; pick the right directory by existing layout)
- `electron/app-lifecycle.ts`
- `electron/host-server/agents.ts`, `handlers.ts`, `server.ts`, `__tests__/two-readers.test.ts`
- `electron/bridge/handlers/agents.ts`, `electron/bridge/handlers/agents-read.ts` (new), `electron/bridge/handlers.ts`
