---
title: Persist workspace hidden flag
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Persist workspace hidden flag

Add backend persistence for a per-workspace `hidden` boolean, mirroring the
existing `workspaceNames` (rename) pattern exactly.

## Files to touch

- `electron/persistence.ts`
  - Add `hidden?: boolean` to the **backend** `WorkspaceInfo` interface
    (currently fields: `path`, `branch`, `isMain`, `name`, `linkedIssues?`).
  - Add `workspaceHidden?: Record<string, boolean>` to the `PersistedProject`
    interface, next to `workspaceNames?`, `workspaceOrder?`, `workspaceIssues?`.
  - Add a new method on `ProjectManager`, modeled on `renameWorkspace`
    (around line 270):
    ```ts
    setWorkspaceHidden(
      projectId: string,
      workspacePath: string,
      hidden: boolean,
    ): void {
      const project = this.findProject(projectId);
      if (!project) return;
      if (!project.workspaceHidden) project.workspaceHidden = {};
      if (hidden) {
        project.workspaceHidden[workspacePath] = true;
      } else {
        delete project.workspaceHidden[workspacePath];
      }
      this.saveState();
    }
    ```
  - In `buildProjectInfo` (around line 300), read the map and populate the flag
    on each workspace, alongside `name` and `linkedIssues`:
    ```ts
    const hiddenMap = p.workspaceHidden ?? {};
    const workspaces = rawWorkspaces.map((ws) => ({
      ...ws,
      name: names[ws.path] ?? null,
      linkedIssues: issues[ws.path] ?? [],
      hidden: hiddenMap[ws.path] ?? false,
    }));
    ```

No migration needed — an absent `workspaceHidden` map means nothing is hidden.
