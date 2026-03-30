---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-049: Per-Project Theme Override

## Context

Manor currently has a single global theme stored in `~/Library/Application Support/Manor/settings.json`. When switching between projects, the UI always looks the same. Users who work across multiple projects want to visually distinguish them at a glance by assigning different themes per project, reducing context-switching friction and the chance of accidentally working in the wrong project.

The existing infrastructure already supports per-project settings (color, agent command, worktree config, etc.) via `ProjectUpdatableFields` and the `projects:update` IPC channel. The theme system loads Ghostty themes and applies them as CSS variables on `document.documentElement`.

## Decision

Add a `themeName` field to the project model. When a project with a theme override is selected, apply that theme instead of the global one. When no override is set (`null`), fall back to the global theme.

### Implementation approach

**Data layer:**
- Add `themeName: string | null` to `ProjectInfo`, `PersistedProject`, and `ProjectUpdatableFields` in both `electron/persistence.ts` and `src/store/project-store.ts`
- Default to `null` (use global theme)

**Theme resolution:**
- Add a new method `ThemeManager.getThemeByName(name: string): Theme` that resolves any theme name (including `__ghostty__`, `__default__`, or a Ghostty theme name) to a `Theme` object. Extract this from the existing `getTheme()` method.
- Add a new IPC handler `theme:getForProject(projectId)` that checks the project's `themeName` and resolves it, falling back to the global theme if `null`

**Theme application on project switch:**
- In `theme-store.ts`, add an `applyProjectTheme(projectThemeName: string | null)` action that:
  - If `projectThemeName` is non-null, loads that theme via `window.electronAPI.theme.preview(name)` and applies CSS vars
  - If `null`, reloads the global theme
- Call this from the sidebar's `selectProject` and `selectWorkspace` handlers

**Settings UI:**
- In `ProjectSettingsPage.tsx`, add a theme override selector below the color picker. Reuse the existing `ThemeSection` pattern (searchable list with color previews). Add a "Use global theme" option at the top to clear the override.

### Files to change

| File | Change |
|------|--------|
| `electron/persistence.ts` | Add `themeName` to `PersistedProject`, `ProjectInfo`, `ProjectUpdatableFields`, `buildProjectInfo` |
| `src/store/project-store.ts` | Add `themeName` to `ProjectInfo`, `ProjectUpdatableFields` |
| `src/electron.d.ts` | No changes needed (uses existing `projects:update` IPC) |
| `src/store/theme-store.ts` | Add `applyProjectTheme(name: string | null)` action, export `applyCssVars` |
| `src/components/Sidebar.tsx` | Call `applyProjectTheme` on project/workspace selection |
| `src/components/ProjectSettingsPage.tsx` | Add theme override selector UI |
| `electron/theme.ts` | Extract `getThemeByName()` from `getTheme()` for reuse |

## Consequences

**Benefits:**
- Visual differentiation between projects reduces context-switching errors
- Follows existing per-project settings pattern — minimal new infrastructure
- Graceful fallback to global theme when no override is set

**Tradeoffs:**
- Theme switches on project change may cause a brief visual flash. This is acceptable since project switching already triggers a full workspace change.
- The theme override UI in project settings adds UI complexity, but reuses existing patterns from `ThemeSection`.

**Risks:**
- None significant. The feature is purely additive and the fallback behavior ensures no regression for users who don't set overrides.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
