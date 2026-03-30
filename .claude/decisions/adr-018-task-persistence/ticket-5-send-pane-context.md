---
title: Send pane context to main process on PTY creation
status: done
priority: high
assignee: haiku
blocked_by: [3]
---

# Send pane context to main process on PTY creation

After creating a PTY, the renderer must tell the main process which project/workspace owns the pane so task creation can associate the correct project.

## Files to touch

- `src/hooks/useTerminalLifecycle.ts` — After the `electronAPI.pty.create()` call succeeds, call `electronAPI.tasks.setPaneContext(paneId, { projectId, projectName, workspacePath })`. The workspace path is available from the hook's context (it receives `workspacePath` or can derive it from the app store's `activeWorkspacePath`). The project info can be resolved by finding the project whose workspaces include that path.

## Implementation notes

- Look at how `useTerminalLifecycle.ts` currently calls `pty.create` and where it gets the `cwd`/workspace context
- The project store has the full project list — find the project whose `workspaces` array includes the current workspace path
- If no matching project found (e.g., orphaned workspace), pass null for projectId/projectName
- This is a fire-and-forget call — don't await it or block PTY creation
