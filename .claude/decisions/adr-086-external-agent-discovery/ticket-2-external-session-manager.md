---
title: Create ExternalSessionManager class
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Create ExternalSessionManager class

New module that manages external agent sessions — those discovered via hooks or polling that don't belong to any Manor pane.

## Responsibilities

1. **Hook event routing**: Receive hook events where `paneId` starts with `"external:"` and track them
2. **Session enrichment**: Read `~/.claude/sessions/{pid}.json` to get `cwd`, `sessionId`, `startedAt`
3. **Source app detection**: Read `~/.claude/ide/{pid}.lock` if it exists to get `ideName`; fall back to inspecting the process via `ps` to determine the parent app
4. **PID liveness polling**: Every 10 seconds, validate tracked PIDs are alive. Mark dead sessions as completed.
5. **Startup scan**: On initialization, scan `~/.claude/sessions/*.json` for live external sessions
6. **TaskInfo creation**: Create tasks via `TaskManager` with `external: true` and `paneId: null`

## Files to touch
- `electron/external-sessions.ts` — New file, the ExternalSessionManager class
- `electron/task-persistence.ts` — Add `external: boolean` field to `TaskInfo` (default `false`), add `sourceApp: string | null` field
