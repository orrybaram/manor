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

# ADR-004: React Performance Optimization

## Context

A comprehensive audit of the Manor frontend against the Vercel React Best Practices identified several performance issues across re-render optimization, store subscription granularity, and component memoization. The most impactful issues are:

1. **Wide Zustand selectors** in `useSessionTitle` and `CommandPalette` subscribe to entire `paneCwd` and `paneTitle` maps. Any pane's title or CWD change re-renders every session tab and the command palette, even when those components don't display the changed pane's data.

2. **Missing `React.memo`** on `ProjectItem` (557 lines) and `SessionButton` — these components re-render on every parent state change despite receiving stable props.

3. **Inline callback props** on `CommandPalette` in `App.tsx` are recreated every render, defeating any memoization.

4. **Sequential startup loading** in `Sidebar.tsx` chains `loadPersistedLayout` → `loadProjects` sequentially when they could partially overlap.

5. **Multiple array iterations** in `CommandPalette`'s `recentCommands` memo chains `.filter()` → `.map()` → `.filter()` where a single pass would suffice.

## Decision

Apply targeted fixes in priority order, following the Vercel React Best Practices ruleset:

### 1. Narrow Zustand store selectors (HIGH — `rerender-derived-state`)
- In `useSessionTitle` (`SessionButton.tsx`): replace `useAppStore(s => s.paneCwd)` and `useAppStore(s => s.paneTitle)` with selectors scoped to the specific pane ID (`s.paneCwd[focusedPaneId]`, `s.paneTitle[focusedPaneId]`). Restructure the hook to first resolve the focused pane ID, then subscribe narrowly.
- In `CommandPalette.tsx`: the `recentCommands` memo accesses `paneTitle` and `paneCwd` maps. Replace the wide subscriptions with a derived selector that only extracts the titles/cwds for pane IDs present in recent views.

### 2. Add `React.memo` to hot-path components (HIGH — `rerender-memo`)
- Wrap `SessionButton` in `React.memo` — it renders once per tab and receives identity-stable callbacks from `TabBar`.
- Wrap `ProjectItem` in `React.memo` — it's a large component (557 lines) rendered per-project in the sidebar.

### 3. Hoist inline callbacks in App.tsx (MEDIUM — `rerender-memo-with-default-value`)
- Extract the `onNewWorkspace` inline callback passed to `CommandPalette` into a `useCallback` with appropriate dependencies.

### 4. Parallelize startup loading (MEDIUM — `async-parallel`)
- In `Sidebar.tsx`, run `loadPersistedLayout()` and `loadProjects()` with `Promise.all()`, then activate the workspace after both complete. The activation step (`setActiveWorkspace`) depends on both, but the two loads are independent of each other.

### 5. Combine array iterations in recentCommands (LOW — `js-combine-iterations`)
- Replace the `.filter().map().filter()` chain in the `recentCommands` memo with a single `reduce` or loop that builds the result array in one pass.

## Consequences

**Positive:**
- Tab bar stops re-rendering all tabs when any single pane's title/CWD changes — significant reduction in render work for users with many tabs.
- Sidebar project list stops re-rendering unchanged projects.
- Startup time marginally improved by parallelizing layout + project loading.
- No API changes; all fixes are internal refactors.

**Risks:**
- Narrowed Zustand selectors need careful testing — if a selector is too narrow, components may not update when they should (e.g., when focused pane changes within a session).
- `React.memo` on `ProjectItem` requires that all callback props from `Sidebar` are referentially stable; need to verify this or wrap them in `useCallback`.

**No change:**
- `lucide-react` barrel imports: Vite 7 tree-shakes these effectively; no action needed unless bundle analysis shows otherwise.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
