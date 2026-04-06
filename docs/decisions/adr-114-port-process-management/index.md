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

# ADR-114: Port & Process Management via Command Palette

## Context

Manor spawns a complex tree of processes at runtime:

1. **Electron main process** — hosts 3 internal HTTP servers (AgentHookServer, WebviewServer, PortlessManager)
2. **Terminal-Host Daemon** — detached Node.js process that survives app restarts, listening on a Unix domain socket
3. **pty-subprocess (per terminal pane)** — forked from the daemon, each owns a PTY
4. **Shell processes** — the actual zsh/bash inside each PTY
5. **User processes** — dev servers, agents (Claude Code, etc.), and their children

When Manor crashes, updates, or doesn't shut down cleanly, orphaned daemons, pty-subprocesses, and shell processes linger. Users currently have to open Activity Monitor and manually hunt down processes. There's no way to see what Manor is running or kill it all from within the app.

The existing port scanner (`electron/ports.ts` + `electron/backend/local-ports.ts`) already detects listening TCP ports via `lsof` and associates them with workspaces, but this data is only shown in the sidebar port badges. There's no unified view of Manor's own processes alongside user ports.

## Decision

Add a **"Processes" sub-view** inside the command palette, accessible via a "Processes" drill-in item in the root command list. This follows the same navigation pattern as the existing Linear and GitHub issue sub-views (breadcrumb + back button + list).

### Architecture

**Backend (Electron main process):**

- Add a new IPC channel `processes:list` that aggregates:
  - **Daemon info**: PID from `~/.manor/daemons/{version}/terminal-host.pid`, alive check via `process.kill(pid, 0)`
  - **Sessions**: from `backend.pty.listSessions()` — each session maps to a pty-subprocess
  - **Listening ports**: from the existing port scanner (already running)
  - **Internal servers**: hook port, webview port, portless port (from `process.env`)
- Add a new IPC channel `processes:killAll` that:
  1. Kills all sessions via the daemon (`kill` control message for each)
  2. Kills the daemon process itself (SIGTERM to PID from pidfile)
  3. Kills any remaining listening ports associated with workspaces
- Add a new IPC channel `processes:killSession` to kill a single daemon session
- Add a new IPC channel `processes:killDaemon` to kill just the daemon

**Frontend (React):**

- New `PaletteView` value: `"processes"`
- New component `ProcessesView.tsx` in `src/components/command-palette/` that renders:
  - **Manor Internal** section: daemon PID + status, internal server ports
  - **Sessions** section: each pty-subprocess with its shell, CWD, and child processes
  - **Ports** section: listening ports grouped by workspace (reuses existing port data)
  - A footer with "Kill All Manor Processes" action
- Each item has a kill action (X button or keyboard shortcut)
- A "Processes" command item in the root palette view with `ChevronRight` suffix to navigate to the sub-view

### Data shape

```typescript
interface ManorProcessInfo {
  daemon: {
    pid: number | null;
    alive: boolean;
    socketPath: string;
    version: string;
  };
  internalServers: Array<{
    name: string;         // "Agent Hook", "Webview", "Portless"
    port: number | null;
  }>;
  sessions: Array<{
    sessionId: string;
    alive: boolean;
    cwd: string | null;
  }>;
  ports: ActivePort[];    // reuse existing type
}
```

## Consequences

**Benefits:**
- Users can see exactly what Manor is running without Activity Monitor
- One-click "kill all" for stuck processes
- Per-session and per-port kill for surgical cleanup
- Follows existing command palette sub-view patterns — no new UI paradigms

**Tradeoffs:**
- The `processes:list` IPC handler adds a small amount of work on each open (daemon PID check + listSessions call), but this is lightweight and on-demand only
- Kill-all is destructive — all terminal sessions and their children will be terminated

**Risks:**
- Killing the daemon while sessions are running will orphan pty-subprocesses momentarily (the daemon's shutdown handler calls `disposeAll`, but a SIGTERM from outside follows a different path). Mitigation: kill sessions first, then daemon.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
