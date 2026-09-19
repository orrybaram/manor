---
title: agents.setPaneContext on the bridge, so a browser-opened pane has an agent context
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [7]
---

# agents.setPaneContext on the bridge, so a browser-opened pane has an agent context

Follow-up from ticket 7. `src/hooks/useTerminalLifecycle.ts` calls
`window.electronAPI.agents.setPaneContext(...)` after every successful
`pty.create` when `cwd` is set. It is not on `WS_HANDLERS`, so on the web it
rejects with `unavailable:web` — fire-and-forget, so silent — and a pane
opened from a browser never gets the project/workspace context the sidebar's
per-pane agent metadata reads.

- `electron/remote-control/ws-handlers.ts` — add `agents.setPaneContext`,
  calling the lifted body from `electron/ipc/agents.ts` (lift it the way the
  other entries were, if it is still inline in `ipcMain.handle`). It is a
  write: add it to `MUTATING` with the `paneId` as the audit target.
- `electron/remote-control/__tests__/ws-bridge.test.ts` — resolves for a
  `full` device and lands an audit line; absent for nothing else changes.
- `src/hooks/useTerminalLifecycle.ts` — give the call a `.catch` through
  `handleBridgeUnavailable` from `src/lib/bridge-unavailable-toast.ts` so any
  future table gap toasts once instead of surfacing as an unhandled rejection.

## Files to touch
- `electron/remote-control/ws-handlers.ts` — table entry + `MUTATING`
- `electron/ipc/agents.ts` — lift the body if needed
- `electron/remote-control/__tests__/ws-bridge.test.ts` — tests
- `src/hooks/useTerminalLifecycle.ts` — `.catch`
