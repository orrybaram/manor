---
title: Store and use agentCommand in task metadata
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Store and use agentCommand in task metadata

Add `agentCommand` field to task metadata and use it when resuming sessions.

## Files to touch

- `electron/task-persistence.ts` — Add `agentCommand: string | null` to `TaskInfo` interface
- `src/electron.d.ts` — Add `agentCommand: string | null` to renderer-side `TaskInfo` interface, and add `agentCommand` to `setPaneContext` context type
- `electron/main.ts` — Expand `paneContextMap` type to include `agentCommand`, pass it through to `createTask`
- `src/hooks/useTerminalLifecycle.ts` — Include `project?.agentCommand ?? null` in `setPaneContext` call
- `src/App.tsx` — In `handleResumeTask`, prefer `task.agentCommand` over project lookup. Use: `task.agentCommand?.split(" ")[0] ?? taskProject?.agentCommand?.split(" ")[0] ?? "claude"`
