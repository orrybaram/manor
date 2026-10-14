---
title: The host decides when it is busy
status: done
priority: medium
assignee: sonnet
blocked_by: [1, 4]
---

# The host decides when it is busy

ADR-229 D7. The keep-awake rule (ADR-178 §1), decided on the host server
and acted on from the box and from the desktop.

## What to build

- **Host server busy flag** (new `electron/host-server/busy.ts`).
  - Subscribe to the agent pipeline's updates. `busy` is true when any agent
    is in `thinking`, `working` or `requires_input`. Export and reuse the
    reconciler's `isActiveStatus`; don't copy the set.
  - Going busy is immediate. Going idle waits 60 s, and is cancelled if an
    agent goes active again.
  - Report `busy: boolean` and `idleSince: number | null` in
    `HostServerStatus`.
  - Publish an owner event, `hostServer.busyChanged` (`{busy}`), on each
    debounced transition.
- **Box hooks.** On each transition, run `~/.manor/remote/hooks/on-busy` or
  `on-idle` if the file exists and is executable:
  - spawned detached from the server's lifetime but awaited with a 30 s
    timeout;
  - env `MANOR_BUSY=1|0`;
  - stdout and stderr appended to `logs/hooks.log`, capped.
  - A failing hook is logged and otherwise ignored. Never run two of the
    same hook at once; a newer transition supersedes a pending one.
- **Desktop** (`electron/backend/host-server-sync.ts` or wherever owner
  events are consumed; `HostServerClient` already subscribes to events
  since ADR-227):
  - On `busyChanged`, and on each owner connect from `status().busy`, call
    `provider.setBusy(busy)` through the registry.
  - **Idle stop** for recipe providers with `idleStopMinutes`. A timer on
    the desktop calls `registry.stop(hostId)` when all of these hold:
    - the host has been idle (from the host's `idleSince`) for that long;
    - no window has a pane of that host mounted (ask the desktop's pane
      registry or layout claims; find the existing "mounted" signal);
    - the provider is not already sleeping.

    Re-check every condition right before stopping. Never stop while busy.
  - `hosts.list` exposes `busy` and `idleStopNote: boolean` (true when the
    recipe has `idleStopMinutes` but neither `autoSleep` nor a box hook
    exists). Ticket 8 uses it for "Stops after N min idle only while This
    Mac is awake". To know about the hook, the host server reports
    `hooks: {onBusy: boolean, onIdle: boolean}` in its status.

## Carried over from ticket 4

- `RecipeHostProvider` already stores `busy` from `setBusy` (unused). The
  idle stop should read it there.

## Tests

- Busy debounce: active → busy now; idle → busy false after 60 s; flap
  inside the window → no event.
- Hook runner: runs the right hook, times out, supersedes, ignores a
  missing or non-executable file.
- Idle-stop timer with fake clock and registry: stops only when idle long
  enough, unmounted and not busy; a busy flip cancels it.

## Files to touch
- new `electron/host-server/busy.ts`, `electron/host-server/server.ts` (wire), `electron/host-server/relay.ts` (status), `electron/host-server/handlers.ts` (event allowlist)
- `electron/agent-status/reconciler.ts` (export `isActiveStatus`)
- `electron/backend/host-server-sync.ts`, `electron/backend/registry.ts`, `electron/backend/providers/recipe-provider.ts`
- `electron/bridge/handlers/hosts.ts`
