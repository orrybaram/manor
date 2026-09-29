---
title: Tasks app surface and sidebar row
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Tasks app surface and sidebar row

ADR-198 §1–§2.

- `src/store/app-store.ts`: `AppSurface` gains `"tasks"`; add
  `showTasksView()` exactly like `showProjectsOverview()` (L929);
  `selectCurrentLocation` (L651) maps `"tasks"` to
  `{kind:"surface", surface:"tasks"}`.
- `src/store/navigation-history-store.ts`: extend the Location surface union.
- `src/hooks/useNavigationHistory.ts` `applyLocation`: replay `"tasks"` via
  `showTasksView()`.
- `src/components/sidebar/Sidebar/Sidebar.tsx` + `.module.css`: a **Tasks** row
  between Home and Projects, same markup/classes pattern as the Home row
  (`data-sidebar-row`, `aria-current`, `handleSidebarRowKeyDown`), `ListTodo`
  icon from `lucide-react/dist/esm/icons/list-todo`, active when
  `activeSurface === "tasks"`. Home row must not be active while tasks is
  shown (same as projects). Right side: dimmed 11px `GitHubIcon`/`LinearIcon`
  (from `src/components/command-palette/`) for connected providers (GitHub via
  the same availability check GitHubNudge/useIssuesShortcut uses; Linear via
  its connected state) — keep it cheap, no per-render IPC.
- `src/App.tsx`: read `activeSurface === "tasks"`; treat like
  `showProjectsOverview` for hiding workspace layouts and render
  `<TasksView onNewWorkspace={handleNewWorkspace} onOpenPaletteView={...} />`
  in the empty-surface slot. Until ticket 3 lands, create a placeholder
  `src/components/tasks/TasksView.tsx` exporting `TasksView` (props
  `onNewWorkspace`, `onOpenPaletteView`) rendering a heading "Tasks".
- Add a store test in `src/store/__tests__/app-store-active-surface.test.ts`
  for `showTasksView`.

## Files to touch
- `src/store/app-store.ts`, `src/store/navigation-history-store.ts`,
  `src/hooks/useNavigationHistory.ts`
- `src/components/sidebar/Sidebar/Sidebar.tsx`, `Sidebar.module.css`
- `src/App.tsx`
- `src/components/tasks/TasksView.tsx` (placeholder)
- `src/store/__tests__/app-store-active-surface.test.ts`
