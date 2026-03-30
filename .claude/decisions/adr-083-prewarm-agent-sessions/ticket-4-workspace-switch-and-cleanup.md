---
title: Handle workspace switches and app lifecycle
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Handle workspace switches and app lifecycle

Ensure the prewarmed session stays in sync with the active workspace and is properly cleaned up.

## Implementation

### Workspace switch
When the user switches workspaces, the prewarmed session's CWD may be stale. In `main.ts`:

- Listen for workspace-change IPC events (or derive from pane context updates)
- Call `prewarmManager.updateCwd(newWorkspacePath)` which kills the stale session and warms a new one

### App quit
In the existing `before-quit` handler:
- Call `prewarmManager.dispose()` to kill the prewarmed session
- This prevents orphaned shell processes in the daemon

### Daemon disconnect/reconnect
If the daemon connection drops and reconnects:
- The prewarmed session is lost (daemon may have restarted)
- Reset PrewarmManager state to `idle` and re-warm after reconnection

### listSessions filtering
Prewarmed sessions should not appear in layout persistence or UI reconciliation:
- The `prewarmed` flag in the daemon already excludes them from `listSessions`
- Verify that `layout-persistence.ts` reconciliation doesn't try to restore prewarmed sessions

## Files to touch
- `electron/main.ts` — Add workspace-change listener, update before-quit handler, handle reconnection
- `electron/prewarm-manager.ts` — Add `reset()` method for reconnection scenarios
- `electron/terminal-host/terminal-host.ts` — Verify `listSessions` excludes prewarmed sessions
