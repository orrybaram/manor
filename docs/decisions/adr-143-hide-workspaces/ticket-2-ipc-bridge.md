---
title: Wire setWorkspaceHidden through IPC + preload + types
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Wire setWorkspaceHidden through IPC + preload + types

Expose the new `ProjectManager.setWorkspaceHidden` method to the renderer,
mirroring `renameWorkspace` across all three bridge layers.

## Files to touch

- `electron/ipc/projects.ts` — add a handler next to `projects:renameWorkspace`
  (around line 93):
  ```ts
  ipcMain.handle(
    "projects:setWorkspaceHidden",
    (_event, projectId: string, workspacePath: string, hidden: boolean) => {
      projectManager.setWorkspaceHidden(projectId, workspacePath, hidden);
    },
  );
  ```

- `electron/preload.ts` — add a bridge method next to `renameWorkspace`
  (around line 96):
  ```ts
  setWorkspaceHidden: (
    projectId: string,
    workspacePath: string,
    hidden: boolean,
  ) =>
    ipcRenderer.invoke(
      "projects:setWorkspaceHidden",
      projectId,
      workspacePath,
      hidden,
    ),
  ```

- `src/electron.d.ts` — add the type in the `projects: { … }` block next to
  `renameWorkspace` (around line 288):
  ```ts
  setWorkspaceHidden: (
    projectId: string,
    workspacePath: string,
    hidden: boolean,
  ) => Promise<void>;
  ```
