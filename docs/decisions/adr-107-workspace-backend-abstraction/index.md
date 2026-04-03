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

# ADR-107: Workspace Backend Abstraction

## Context

Manor is currently a fully local desktop app. Every system interaction — PTY sessions, git CLI calls, port scanning, filesystem access — is hardcoded to the local machine via `node-pty`, `execFile("git", ...)`, `lsof`, and Node `fs.*` calls scattered across `electron/main.ts`, `electron/persistence.ts`, `electron/ports.ts`, `electron/branch-watcher.ts`, `electron/diff-watcher.ts`, and the `electron/terminal-host/` daemon.

The long-term vision is to support cloud-based workspaces where a user's code lives on a remote VM and Manor connects to it from the desktop app, a web app, or a mobile app. Before any remote infrastructure can be built, the local system calls need to be behind a clean abstraction boundary so a `RemoteBackend` can be swapped in later without touching the renderer or IPC layer.

This ADR covers **Phase 1 only**: extracting the `WorkspaceBackend` interface and implementing a `LocalBackend` that wraps the existing code. No networking, no auth, no VM provisioning.

## Decision

Introduce a `WorkspaceBackend` interface in `electron/backend/` that encapsulates all operations that would run "on the VM" in cloud mode. Ship a `LocalBackend` implementation that wraps the existing code with zero behavior changes.

### What goes behind the abstraction

| Category | Operations | Current location |
|----------|-----------|-----------------|
| **PTY** | create, write, resize, close, detach, subscribe, snapshot, list | `terminal-host/client.ts` via `main.ts` IPC handlers |
| **Git** | stage, unstage, discard, commit, stash, diff, merge, worktree CRUD | `main.ts` (lines 656-835), `persistence.ts`, `diff-watcher.ts` |
| **Shell** | discover agents (`which`), execute commands | `main.ts` (lines 1039-1061) |
| **Ports** | scan listening ports, kill process | `ports.ts` |
| **Branch/Diff watchers** | poll `.git/HEAD`, run `git diff --shortstat` | `branch-watcher.ts`, `diff-watcher.ts` |

### What stays local (NOT abstracted)

These are client-side concerns that always run on the user's machine:

- Window state, zoom, bounds (`main.ts` window management)
- Clipboard, dialogs, `shell.openExternal` (Electron APIs)
- Theme/preferences/keybindings (UI config persisted in `~/.manor/`)
- Layout persistence (client-side workspace memory)
- Auto-updater
- Webview management and MCP server
- Sound/notifications
- Linear/GitHub API calls (use API tokens stored locally, can move later)
- Agent hook server (local HTTP server for agent lifecycle events)

### Interface shape

The backend is organized into namespaced sub-interfaces for clarity:

```typescript
// electron/backend/types.ts

interface PtyBackend {
  createOrAttach(sessionId: string, cwd: string, cols: number, rows: number): Promise<CreateResult>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  kill(sessionId: string): Promise<void>
  detach(sessionId: string): Promise<void>
  getSnapshot(sessionId: string): Promise<TerminalSnapshot>
  listSessions(): Promise<SessionInfo[]>
  onEvent(handler: (event: StreamEvent) => void): void
  updateEnv(env: Record<string, string>): Promise<void>
}

interface GitBackend {
  exec(cwd: string, args: string[], opts?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }>
  // Convenience methods built on exec:
  stage(cwd: string, files: string[]): Promise<void>
  unstage(cwd: string, files: string[]): Promise<void>
  discard(cwd: string, files: string[]): Promise<void>
  commit(cwd: string, message: string, flags?: string[]): Promise<void>
  stash(cwd: string, files: string[]): Promise<void>
  getFullDiff(cwd: string, defaultBranch: string): Promise<string | null>
  getLocalDiff(cwd: string): Promise<string | null>
  getStagedFiles(cwd: string): Promise<string[]>
  worktreeList(cwd: string): Promise<WorktreeInfo[]>
  worktreeAdd(cwd: string, path: string, branch: string, base?: string): Promise<void>
  worktreeRemove(cwd: string, path: string): Promise<void>
}

interface ShellBackend {
  which(binary: string): Promise<string | null>
  exec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>
}

interface PortsBackend {
  scan(uid: number): Promise<ActivePort[]>
  kill(pid: number): Promise<void>
}

interface WorkspaceBackend {
  readonly pty: PtyBackend
  readonly git: GitBackend
  readonly shell: ShellBackend
  readonly ports: PortsBackend
  connect(): Promise<void>
  disconnect(): Promise<void>
}
```

### Backend ownership

- The Electron main process owns the backend instance.
- IPC handlers become thin pass-throughs: `ipcMain.handle("git:stage", (_, wsPath, files) => backend.git.stage(wsPath, files))`.
- The renderer never knows whether it's local or remote — all IPC channel signatures stay the same.
- For now, one global backend instance. In the future, this becomes per-workspace to support mixed local/remote projects.

### File structure

```
electron/
  backend/
    types.ts              # WorkspaceBackend interface + sub-interfaces
    local-backend.ts      # LocalBackend class (delegates to existing managers)
    local-pty.ts          # LocalPtyBackend wrapping TerminalHostClient
    local-git.ts          # LocalGitBackend wrapping execFile("git", ...)
    local-shell.ts        # LocalShellBackend wrapping execFile/which
    local-ports.ts        # LocalPortsBackend wrapping PortScanner
```

## Consequences

**Benefits:**
- Creates a clean seam for future `RemoteBackend` implementation without touching renderer code
- Consolidates scattered `execFile("git", ...)` calls into one place
- Makes the system boundary explicit and testable — backend implementations can be mocked
- No behavior changes for users — purely internal refactor

**Risks:**
- Adding an indirection layer increases code to maintain
- Must be careful not to change behavior during the migration — every IPC handler should produce identical results
- The `PortScanner` currently takes a `BrowserWindow` for event pushing; the abstraction needs to decouple this (use callbacks instead)
- `BranchWatcher` and `DiffWatcher` also push events via `webContents.send` — these need the same callback decoupling

**What this does NOT include:**
- No `RemoteBackend` implementation
- No networking/WebSocket code
- No auth or VM provisioning
- No changes to the renderer or IPC channel signatures
- No changes to layout persistence, preferences, themes, or other client-local systems

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
