---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-055: Kill Port from Ports View

## Context

The ports view in the sidebar displays active listening ports associated with workspaces. Users can open ports in browser tabs or the default browser via the context menu, but there's no way to kill/stop a process listening on a port. This is a common need when a dev server gets stuck, a port conflict occurs, or a user simply wants to stop a running service without switching to the terminal.

The `ActivePort` model already carries the `pid` field, which is all we need to terminate the process.

## Decision

Add a "Kill Port" option to the PortBadge context menu that sends `SIGTERM` to the process via a new IPC handler.

### Implementation layers:

1. **IPC handler** (`electron/main.ts`): Add `ports:killPort` handler that takes a `pid` and sends `SIGTERM` via `process.kill(pid, 'SIGTERM')`, then triggers an immediate re-scan so the UI updates.

2. **Preload bridge** (`electron/preload.ts`): Expose `ports.killPort(pid)` to the renderer.

3. **Type definition** (`src/electron.d.ts`): Add `killPort(pid: number): Promise<void>` to the `ports` section of `ElectronAPI`.

4. **UI** (`src/components/PortBadge.tsx`): Add a "Kill Port" context menu item with a separator above it. On select, call `window.electronAPI.ports.killPort(port.pid)`.

We use `SIGTERM` (not `SIGKILL`) to give the process a chance to clean up gracefully. The immediate re-scan after kill ensures the port disappears from the UI promptly.

## Consequences

- **Better**: Users can stop runaway or stuck dev servers directly from the ports panel without needing to find the terminal or use `kill` manually.
- **Risk**: Killing a process by PID could theoretically hit a recycled PID, but this is extremely unlikely given the 3-second scan interval keeping PIDs fresh.
- **Tradeoff**: We only send SIGTERM, not SIGKILL. A misbehaving process could ignore it. This is intentional — users can escalate manually if needed.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
