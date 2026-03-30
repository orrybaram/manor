---
title: Add breadcrumbs component and wire into App
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add Breadcrumbs Component and Wire into App

Create a `Breadcrumbs` component that displays `ProjectName > WorkspaceName` at the top of the main content area.

## Implementation

1. Create `src/components/Breadcrumbs.tsx`:
   - Use `useProjectStore` to get `projects`
   - Use `useAppStore` to get `activeWorkspacePath`
   - Find the project whose `workspaces` array contains a workspace with `path === activeWorkspacePath`
   - Display `project.name > workspace.name` (fall back to workspace branch if name is null)
   - Return null if no active workspace or project found

2. Create `src/components/Breadcrumbs.module.css`:
   - Compact bar (around 24px height) with dim text
   - Include `-webkit-app-region: drag` so it works as a window drag region
   - Use existing CSS variables (`--text-dim`, `--font-mono`, etc.)

3. Update `src/App.tsx`:
   - Import and render `<Breadcrumbs />` inside `.main-content`, before the TabBar/drag-region

## Files to touch
- `src/components/Breadcrumbs.tsx` — new component
- `src/components/Breadcrumbs.module.css` — new styles
- `src/App.tsx` — render Breadcrumbs at top of `.main-content`
