---
title: Add hidden field + setWorkspaceHidden action to project store
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add hidden field + setWorkspaceHidden action to project store

Expose the hidden flag and a mutation action in the frontend Zustand store,
mirroring `renameWorkspace`.

## Files to touch

- `src/store/project-store.ts`
  - Add `hidden?: boolean` to the **frontend** `WorkspaceInfo` interface
    (around line 162, next to `name`, `diffStats?`, `pr?`, `linkedIssues?`).
  - Add `setWorkspaceHidden` to the `ProjectState` interface next to
    `renameWorkspace` (around line 264):
    ```ts
    setWorkspaceHidden: (
      projectId: string,
      workspacePath: string,
      hidden: boolean,
    ) => Promise<void>;
    ```
  - Implement the action in the store body (near the `renameWorkspace`
    implementation around line 599). `renameWorkspace` awaits the IPC call then
    optimistically patches local state with `set(...)` — copy that exact shape:
    ```ts
    setWorkspaceHidden: async (projectId, workspacePath, hidden) => {
      await window.electronAPI.projects.setWorkspaceHidden(
        projectId,
        workspacePath,
        hidden,
      );
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                workspaces: p.workspaces.map((ws) =>
                  ws.path === workspacePath ? { ...ws, hidden } : ws,
                ),
              }
            : p,
        ),
      }));
    },
    ```

## Files to reference
- `renameWorkspace` store impl (around line 599) — the optimistic `set` pattern
  above is copied from it.
