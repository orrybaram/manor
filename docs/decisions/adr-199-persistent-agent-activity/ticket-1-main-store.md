---
title: AgentActivityStore in main with persistence and IPC
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# AgentActivityStore in main with persistence and IPC

Implement ADR-199 §1 and §2 (read `docs/decisions/adr-199-persistent-agent-activity/index.md`).

- `electron/agent-activity-store.ts`: model it on `electron/stats-store.ts`:
  - same data-dir resolution, debounced write, `flush()` on quit, safe load and `onChange` subscription
  - API: `record(agent: AgentInfo, status: AgentStatus, at = Date.now())`, `getSnapshot(now = Date.now()): AgentActivitySnapshot`, `onChange(cb)`, `flush()`
  - records per Agent id plus a `meta` snapshot (`name`, `projectId`, `workspacePath`, `hostId`)
  - app `sessions` `{ start, end }`: `start` at construction; `end` refreshed on every save and on flush
  - retention 24h: keep the last transition before the cutoff; cap 500 entries per Agent and 200 Agents (drop the least recently active)
  - corrupt or missing file → empty state
- Wire it in `electron/app-lifecycle.ts`:
  - construct it next to `StatsStore`
  - in `publishPaneStatus`, after `sendToRendererWindows`, resolve `agentManager.getAgentByPaneId(update.paneId)` and `record(...)` it if found
  - flush on quit wherever stats-store flushes
  - pass it into the IPC deps (`electron/ipc/types.ts`)
- IPC `electron/ipc/agent-activity.ts` (register it where the other IPC modules are registered):
  - `agentActivity:get` returns the snapshot
  - `agentActivity:changed` broadcasts, debounced 1s, same pattern as `electron/ipc/stats.ts`
- `electron/preload.ts`: expose `agentActivity.get()` and `agentActivity.onChanged(cb)`, following the stats bridge shape.
- `src/electron.d.ts`: add the `AgentActivitySnapshot` types and the bridge methods.
- Unit tests `electron/__tests__/agent-activity-store.test.ts`:
  - record dedupes equal statuses
  - retention keeps the pre-cutoff transition
  - both caps
  - session start/end
  - persistence round-trip
  - corrupt file

## Files to touch
- `electron/agent-activity-store.ts` (new), `electron/__tests__/agent-activity-store.test.ts` (new)
- `electron/ipc/agent-activity.ts` (new), IPC registration site, `electron/ipc/types.ts`
- `electron/app-lifecycle.ts`, `electron/preload.ts`, `src/electron.d.ts`
