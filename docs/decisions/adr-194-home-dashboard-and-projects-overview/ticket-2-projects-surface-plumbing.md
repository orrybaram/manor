---
title: Projects overview surface, sidebar row and routing
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Projects overview surface, sidebar row and routing

ADR-194 §2. This ticket adds the plumbing only. Render a minimal
`ProjectsOverview` (heading "Projects" plus the existing `ManorLogo`); ticket 3
fills it in.

## Store
- `src/store/app-store.ts`:
  - add `activeSurface: "workspace" | "projects"` (default `"workspace"`) and
    `showProjectsOverview()`.
  - reset it to `"workspace"` in `setActiveWorkspace`, `addTab`,
    `addBrowserTab` and `navigateToContext`. Check for other tab-creating
    actions (split, new agent tab) and reset there too.
  - `selectCurrentLocation` returns `{ kind: "surface", surface: "projects" }`
    when the overview is active.
  - Don't persist it.
- `src/store/navigation-history-store.ts`: widen `Location` with
  `surface: "projects"`.
- `src/hooks/useNavigationHistory.ts`: `applyLocation` calls
  `showProjectsOverview()` for it.

## Sidebar
- `src/components/sidebar/Sidebar/Sidebar.tsx` (~362-401):
  - turn the Projects `sectionHeader` into a row styled like `.homeRow`:
    `data-testid="projects-row"`, `data-sidebar-row=""`, `tabIndex={-1}`,
    `aria-current` when `activeSurface === "projects"`, a click that calls
    `showProjectsOverview`, and `handleSidebarRowKeyDown` with `activate`.
  - keep the ContextMenu wrapper ("Add Project").
  - `homeActive` becomes false while the overview is shown, and project/group
    `isSelected` too.
- `Sidebar.module.css`: add a `.projectsRow` / `.projectsRowActive` that
  mirrors `.homeRow` (margin-inline 8px, same type treatment).

## App
- `src/App.tsx` (~655-690):
  - when `activeSurface === "projects"` or `!hasProjects`, render
    `<ProjectsOverview …/>` in the empty-surface area and hide the active
    `PanelLayout`. The wizard still takes precedence.
  - for now, leave `WelcomeEmptyState` in place for the zero-project case
    inside `ProjectsOverview`'s place, or render `ProjectsOverview` only when
    `activeSurface === "projects"`. Ticket 3 swaps the onboarding over.
- `src/components/projects-overview/ProjectsOverview.tsx` plus
  `ProjectsOverview.module.css`: new, minimal. The props it will need are
  `onAddLocal`, `onAddRemote`, `onDropFolder`, so wire them now.

## AddProjectDialog
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`:
  - add `initialMode?: "local" | "remote"`.
  - apply it when `open` goes from false to true, using a render-time ref guard
    (pattern: `CommandPalette` ~136-157), because `reset()` forces "local".
- App: `handleAddProject(mode?)` stores the mode next to
  `addProjectDialogOpen`.

## Menus / keyboard
- `src/lib/menu-handlers.ts`: `orderedWorkspaceKeys` / `stepWorkspace` are
  unchanged (the overview isn't a workspace).
- `src/hooks/useMenuContextSync.ts`: treat the overview like Home for
  enablement if anything breaks. Otherwise leave it alone.

## Tests
- `tests/e2e/keyboard-navigation.spec.ts`: the row order is now Home →
  Projects → projects. Update the ↑/↓/Home/End expectations and add one case:
  Enter on `projects-row` shows the overview.
- `src/lib/__tests__/` or `src/store/__tests__/`: a unit test that
  `setActiveWorkspace` resets `activeSurface`.

## Files to touch
- `src/store/app-store.ts`
- `src/store/navigation-history-store.ts`
- `src/hooks/useNavigationHistory.ts`
- `src/components/sidebar/Sidebar/Sidebar.tsx`
- `src/components/sidebar/Sidebar/Sidebar.module.css`
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`
- `src/components/projects-overview/ProjectsOverview.tsx` — new
- `src/components/projects-overview/ProjectsOverview.module.css` — new
- `src/App.tsx`
- `tests/e2e/keyboard-navigation.spec.ts`
