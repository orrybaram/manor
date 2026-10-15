---
title: Stats count remote agents
status: done
priority: low
assignee: sonnet
blocked_by: [9]
---

# Stats count remote agents

ADR-230 D14 (gap S1).

## What to build

- **The busy gauge.** In `electron/server/create-manor-server.ts:572-579`,
  `countBusyAgents([...agentManager.getActiveAgents(), ...(routing?.agents()
  ?? [])])`. Also sample it when the host proxies' agents update: subscribe
  to the routing's agent-change signal, or add one if none exists. Call the
  same `statsStore` observe path with a synthetic sample, or add an
  `observeBusyCount` if `observeHookEvent` needs a hook event.
- **Kill lookups** fall back to `deps.hostRouting?.agents().find(a =>
  a.paneId === id)`:
  - `electron/bridge/handlers/processes.ts:37-40`
  - `electron/process-control.ts:172-174`: add `hostRouting` to
    `KillAllProcessesDeps` (:156-161) and to its callers
    (`processes.ts:62-64`, `electron/routes/system.ts:122`).
  - Leave `abandonAgentForPane` (`agents.ts:229`) alone. The host owns
    that.
- Desktop only. Host servers' stats stores are never read.

## Tests (each must fail on the base commit)

- `electron/__tests__/processes-kill-stats.test.ts`: killing a remote pane
  whose agent is in `hostRouting.agents()` records the kill (mid-thought,
  when it is thinking).
- A test that the busy gauge counts a busy remote agent. Put it in
  `stats-signals.test.ts` or a create-manor-server-level test, whichever
  reaches the wiring.
- `electron/routes/system.test.ts`: kill-all counts remote agents.

## Files to touch
- `electron/server/create-manor-server.ts`
- `electron/bridge/handlers/processes.ts`, `electron/process-control.ts`, `electron/routes/system.ts`
- Tests named above.
