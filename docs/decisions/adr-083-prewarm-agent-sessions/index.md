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

# ADR-083: Pre-warm Agent Sessions for Instant New Task

## Context

Starting a new task in Manor has a noticeable cold-start delay. The current flow when a user presses Cmd+N:

1. `handleNewTask()` sets a pending startup command and calls `addSession()`
2. A new `Session` is created in the Zustand store (paneId generated)
3. React renders `TerminalPane` which triggers `useTerminalLifecycle`
4. `useTerminalConnection.create()` → IPC `pty:create` → daemon `createOrAttach()`
5. Daemon spawns a new PTY subprocess (forks `pty-subprocess.js`, starts shell)
6. After shell initializes (~500ms delay baked in), the pending startup command (`claude`) is written to the terminal
7. The agent CLI starts up, loads config, and becomes interactive

Steps 4-7 involve real I/O latency: forking a process, shell initialization, agent CLI startup. This makes the New Task experience feel sluggish compared to the instant tab-switching that warm restore provides.

## Decision

Keep one hidden, pre-warmed daemon session ready at all times. When the user starts a new task:

1. **Promote** the pre-warmed session — assign it to the new pane, skip PTY creation entirely
2. **Immediately warm another** session in the background to replace the consumed one

### Architecture

**Daemon layer** (`terminal-host`):
- Add a `prewarm(sessionId, cwd, cols, rows)` request type that creates a session and spawns the PTY but does NOT subscribe for stream events. This keeps the session alive but silent.
- Add a `claimPrewarmed(oldSessionId, newSessionId)` request that renames a prewarmed session's ID so it can be adopted by a pane. This avoids creating a new PTY — the existing one is reused.

**Electron main** (`main.ts`):
- New `PrewarmManager` class that:
  - On app startup (after daemon connects), creates one prewarmed session
  - Exposes `consume(paneId, cwd, cols, rows): Promise<string | null>` — claims the prewarmed session, renames it to the paneId, resizes/changes CWD if needed, and returns the snapshot. Returns null if no prewarmed session is available (fallback to normal create).
  - After consuming, immediately starts warming a new one
  - Tracks the prewarmed session ID and its state (warming / ready / consumed)
- Modify the `pty:create` IPC handler to try `prewarmManager.consume()` first, falling back to the existing `client.createOrAttach()` path

**Renderer** (no changes needed):
- The existing `useTerminalLifecycle` flow calls `pty:create` and receives `{ ok, snapshot }` — this contract stays the same. The renderer doesn't need to know whether the session was prewarmed or freshly created.

### Startup command optimization

The current flow writes the agent command to the terminal after a 500ms `setTimeout` to let the shell initialize. With pre-warming:
- The prewarmed session's shell is already initialized by the time the user triggers New Task
- The `consumePendingStartupCommand` path writes the command immediately (no delay needed)
- A `shellReady` flag on the daemon session can signal when the shell prompt has appeared, allowing the main process to write the startup command without the artificial delay

### Resource management

- Only one prewarmed session exists at a time — minimal resource overhead (one idle shell process)
- If the prewarmed session's CWD doesn't match the active workspace, resize + `cd` to the correct directory on claim
- On workspace switch, kill the stale prewarmed session and create a new one for the new workspace
- On app quit, the prewarmed session is killed (not detached) since it has no associated pane

## Consequences

**Better:**
- New Task feels instant — no waiting for PTY spawn or shell init
- The 500ms startup command delay can be eliminated for prewarmed sessions
- No changes to the renderer layer — fully transparent

**Worse:**
- One extra idle shell process running at all times (negligible resource cost)
- Slight complexity in daemon session management (rename/claim logic)
- CWD mismatch between prewarmed session and actual workspace requires a `cd` on claim

**Risks:**
- Shell environment in prewarmed session may diverge if env vars change between prewarm and claim — mitigated by the existing `updateEnv` mechanism that pushes fresh env vars on connect
- If daemon restarts between prewarm and claim, the prewarmed session is lost — handled by the null fallback path

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
