---
title: Wire backend selection and clean up direct references
status: todo
priority: medium
assignee: sonnet
blocked_by: [2, 3, 4]
---

# Wire backend selection and clean up direct references

Finalize the backend wiring: ensure all system calls go through the backend, remove direct references to `TerminalHostClient` from IPC handlers, and add a backend provider for future extensibility.

## Implementation

### 1. Clean up `main.ts`

After tickets 2-4, the `backend` variable is used by all IPC handlers. Audit `main.ts` for any remaining direct references to:

- `client` (the `TerminalHostClient` instance) — should only be used inside `LocalBackend`/`LocalPtyBackend`
- Raw `execFile("git", ...)` — should all go through `backend.git`
- Raw `execFile` for port/shell ops — should go through `backend.shell` or `backend.ports`

The `client` variable may still be needed for initial construction (`new LocalBackend(client)`), but no IPC handler should reference it directly.

### 2. Create `electron/backend/index.ts` barrel export

```typescript
export { LocalBackend } from "./local-backend"
export type { WorkspaceBackend, PtyBackend, GitBackend, ShellBackend, PortsBackend } from "./types"
```

### 3. Add backend type to project config (preparatory)

In `electron/persistence.ts`, add an optional `backendType?: "local" | "remote"` field to the project/workspace type. Default to `"local"`. This field is unused for now but signals intent for the future.

### 4. Final audit

Grep the `electron/` directory for:
- `execFile("git"` — should only appear inside `local-git.ts`
- `execFileSync("git"` — should only appear inside `local-git.ts` (or flagged as needing async conversion)
- Direct `TerminalHostClient` method calls outside of `local-pty.ts` — should be none in IPC handlers
- `lsof` — should only appear inside `local-ports.ts`

Document any remaining direct calls that couldn't be migrated (e.g., sync calls in startup paths) as TODO comments.

## Files to touch
- `electron/main.ts` — Remove remaining direct `client`/`execFile` references from IPC handlers
- `electron/backend/index.ts` — NEW: barrel export
- `electron/persistence.ts` — Add optional `backendType` field to project type
