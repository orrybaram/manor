---
title: Parallelize startup loading in Sidebar
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Parallelize startup loading in Sidebar

In `Sidebar.tsx` (lines 49-60), `loadPersistedLayout` and `loadProjects` are chained sequentially:

```ts
loadPersistedLayout().then(() => {
  loadProjects().then(() => {
    // activate workspace
  });
});
```

These two operations are independent — `loadPersistedLayout` fetches cached layout from Electron, `loadProjects` fetches the project list. Only the final workspace activation step depends on both.

## Implementation

Replace the sequential chain with `Promise.all`:

```ts
useEffect(() => {
  Promise.all([loadPersistedLayout(), loadProjects()]).then(() => {
    const { projects, selectedProjectIndex } = useProjectStore.getState();
    const project = projects[selectedProjectIndex];
    if (project) {
      const ws =
        project.workspaces[project.selectedWorkspaceIndex] ??
        project.workspaces[0];
      if (ws) setActiveWorkspace(ws.path);
    }
  });
}, [loadProjects, loadPersistedLayout, setActiveWorkspace]);
```

## Files to touch
- `src/components/Sidebar.tsx` — change sequential `.then()` chain to `Promise.all()`
