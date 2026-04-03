---
title: Define WorkspaceBackend interfaces and LocalBackend scaffold
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Define WorkspaceBackend interfaces and LocalBackend scaffold

Create the `electron/backend/` directory with the type definitions and a `LocalBackend` class that assembles the sub-backends.

## Implementation

### 1. Create `electron/backend/types.ts`

Define the full interface hierarchy as described in the ADR:

- `PtyBackend` — mirrors `TerminalHostClient`'s public API: `createOrAttach`, `write`, `resize`, `kill`, `detach`, `getSnapshot`, `listSessions`, `onEvent`, `updateEnv`
- `GitBackend` — `exec` (low-level), plus convenience: `stage`, `unstage`, `discard`, `commit`, `stash`, `getFullDiff`, `getLocalDiff`, `getStagedFiles`, `worktreeList`, `worktreeAdd`, `worktreeRemove`
- `ShellBackend` — `which`, `exec`
- `PortsBackend` — `scan`, `kill`
- `WorkspaceBackend` — aggregates the above with `connect()`/`disconnect()`

Re-export relevant types from `terminal-host/types.ts` (`SessionInfo`, `TerminalSnapshot`, `StreamEvent`, `AgentStatus`, etc.) so consumers import from `backend/types.ts`.

Also define `WorktreeInfo` to match what `git worktree list --porcelain` returns (used by `persistence.ts`).

Also define `ActivePort` here (currently in `ports.ts`) so the interface doesn't depend on the implementation.

### 2. Create `electron/backend/local-backend.ts`

```typescript
export class LocalBackend implements WorkspaceBackend {
  readonly pty: LocalPtyBackend
  readonly git: LocalGitBackend
  readonly shell: LocalShellBackend
  readonly ports: LocalPortsBackend

  constructor(client: TerminalHostClient) {
    this.pty = new LocalPtyBackend(client)
    this.git = new LocalGitBackend()
    this.shell = new LocalShellBackend()
    this.ports = new LocalPortsBackend()
  }

  async connect(): Promise<void> {
    // Local backend is always connected — ensure daemon is running
    await this.pty.ensureConnected()
  }

  async disconnect(): Promise<void> {
    // No-op for local
  }
}
```

### 3. Create stub files for sub-backends

Create empty class stubs that implement each sub-interface. These will be filled in by subsequent tickets:

- `electron/backend/local-pty.ts` — `LocalPtyBackend implements PtyBackend`
- `electron/backend/local-git.ts` — `LocalGitBackend implements GitBackend`
- `electron/backend/local-shell.ts` — `LocalShellBackend implements ShellBackend`
- `electron/backend/local-ports.ts` — `LocalPortsBackend implements PortsBackend`

Each stub should have the correct method signatures with `throw new Error("Not implemented")` bodies. This ensures the types compile and subsequent tickets can fill them in independently.

## Files to touch
- `electron/backend/types.ts` — NEW: all interface definitions
- `electron/backend/local-backend.ts` — NEW: LocalBackend assembler
- `electron/backend/local-pty.ts` — NEW: stub
- `electron/backend/local-git.ts` — NEW: stub
- `electron/backend/local-shell.ts` — NEW: stub
- `electron/backend/local-ports.ts` — NEW: stub
