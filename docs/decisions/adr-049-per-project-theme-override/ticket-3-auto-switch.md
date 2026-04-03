---
title: Auto-switch theme on project/workspace selection
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Auto-switch theme on project/workspace selection

When the user selects a project or workspace in the sidebar, apply the project's theme override (or revert to global if none set).

## Files to touch

- `src/components/Sidebar.tsx`
  - Import `useThemeStore` and get `applyProjectTheme` action
  - In the `onSelect` callback for project selection (around line 296): after `selectProject(idx)`, call `applyProjectTheme(project.themeName)`
  - In the `onSelectWorkspace` callback (around line 306): look up the parent project's `themeName` and call `applyProjectTheme(project.themeName)`

- `src/App.tsx` or wherever the initial project load happens
  - After projects load on startup, apply the selected project's theme override so the correct theme is shown from the start. Find where `loadProjects()` is called and after it resolves, read the selected project's `themeName` and call `applyProjectTheme`.
