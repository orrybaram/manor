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

# ADR-083: Pre-warm Terminal Sessions for Instant New Task (v2)

## Context

Starting a new task in Manor has a noticeable cold-start delay. When a user presses Cmd+N:

1. `addTab()` generates a new paneId and creates layout state
2. React renders `TerminalPane` → `useTerminalLifecycle` runs
3. xterm.js Terminal created, addons loaded, opened to DOM
4. IPC `pty:create` → daemon forks subprocess → spawns shell
5. Shell initializes (.zshrc, etc.)
6. First prompt appears → startup command is injected

Steps 3-5 take 300-800ms combined. The goal is to eliminate this latency.

**Why v2**: The original ADR-083 proposed renaming prewarmed sessions via a `claimPrewarmed` protocol. This failed because:
- `Session.sessionId` is `readonly` and deeply embedded (env vars `MANOR_PANE_ID`, scrollback writer paths, agent detector identity)
- Renaming after spawn leaves stale `MANOR_PANE_ID` in the shell environment
- The `cd <cwd>` hack for CWD mismatch produces visible output in the terminal
- Too many new protocol types for something achievable with existing primitives

## Decision

**Pre-generate the paneId and use the existing warm-restore path.** No session renaming, no new daemon protocol types.

### How it works

1. **PrewarmManager** (new class in electron main) pre-generates a `paneId` and creates a normal daemon session using the existing `create` control request — but does NOT subscribe for stream events. The shell boots silently in the daemon.

2. **On Cmd+N**: Instead of generating a fresh paneId, `addTab()` uses the pre-generated one. React renders TerminalPane, `useTerminalLifecycle` calls `pty:create`, and `createOrAttach` finds the existing session via `getSnapshot` — the existing warm-restore path. The snapshot (with shell prompt already rendered) is written to xterm.js instantly.

3. **Replenish**: After consuming the prewarmed session, immediately start warming a new one.

### Architecture

**Daemon layer**: One small addition — a `prewarmed` boolean flag on `Session` so `listSessions()` can exclude prewarmed sessions from layout persistence reconciliation. No new control request types.

**Client layer** (`TerminalHostClient`): Add `createNoSubscribe()` — sends a `create` control request without subscribing on the stream socket. The session boots silently.

**Main process** (`PrewarmManager`):
- Tracks one prewarmed session: its paneId, cwd, and state (idle/warming/ready)
- `consume()`: returns the prewarmed paneId so the caller can pass it to `addTab()`. The daemon session is already alive — the renderer's `createOrAttach` will find it via warm-restore.
- After each consume, starts warming a new session
- Exposes the prewarmed paneId via IPC so the renderer can use it in `addTab()`

**App store** (`createTab`): Accept an optional `paneId` parameter so the pre-generated ID is used instead of `newPaneId()`.

**Renderer** (`useTerminalLifecycle`): The `pty:create` response gains a `prewarmed: boolean` field. When true, the startup command is written immediately (the shell is already initialized) instead of waiting for the first output event.

### Startup command timing

The current flow waits for the shell's first output (the prompt) via `onOutput` before writing the startup command. For prewarmed sessions, the shell prompt has already appeared before the renderer subscribes, so no new output would arrive. The `prewarmed` flag tells the renderer to write the command immediately.

### Resource management

- One idle shell process at a time — negligible overhead
- Prewarmed session uses the active workspace's CWD. On workspace switch, kill the stale session and warm a new one.
- On app quit, kill the prewarmed session (it has no pane to restore to)
- If daemon restarts between prewarm and consume, fallback to normal `createOrAttach` (no prewarmed session available)

## Consequences

**Better:**
- New Task feels instant — shell prompt appears immediately
- No daemon protocol changes beyond a simple flag
- Transparent to the renderer — same `pty:create` contract, just faster
- `MANOR_PANE_ID` is correct from the start (no renaming)

**Worse:**
- One extra idle shell process running at all times
- `createTab()` gains an optional parameter
- PrewarmManager must track workspace changes to keep CWD in sync

**Risks:**
- If daemon drops between prewarm and consume, graceful fallback to cold start
- Shell env in prewarmed session may diverge — mitigated by `updateEnv` during connect

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
