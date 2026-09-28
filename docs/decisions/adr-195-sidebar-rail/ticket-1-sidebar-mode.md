---
title: Replace sidebarVisible with a persisted sidebarMode
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Replace sidebarVisible with a persisted sidebarMode

See ADR-195 §1 (`docs/decisions/adr-195-sidebar-rail/index.md`).

In `src/store/project-store.ts`:
- Remove `sidebarVisible` and `toggleSidebar`. Add `sidebarMode: "full" | "rail" | "hidden"` (export a `SidebarMode` type) and a non-persisted `lastVisibleSidebarMode: "full" | "rail"`.
- Load from localStorage key `manor:sidebarMode` with the same try/catch pattern as `loadSidebarWidth`, defaulting to `"full"` and rejecting unknown values. `lastVisibleSidebarMode` starts as the loaded mode, or `"full"` if that's `hidden`.
- Actions:
  - `setSidebarMode(mode)` sets it, persists it (try/catch), and updates `lastVisibleSidebarMode` when mode isn't `hidden`.
  - `toggleSidebarRail()`: `full` → `rail`, `rail` → `full`, `hidden` → `full`.
  - `toggleSidebarHidden()`: `hidden` → `lastVisibleSidebarMode`, otherwise `hidden`.

Migrate every caller:
- `src/App.tsx`: render `<Sidebar>` only when `sidebarMode === "full" && hasProjects`. Leave a clear spot for the rail, which ticket 3 fills in. Don't render anything for `rail` yet.
- `src/components/tabbar/TabBar/TabBar.tsx`: apply `.noSidebar` when mode is `hidden` or when mode is `rail` (the rail doesn't exist yet; ticket 3 swaps this for `.railSidebar`).
- `src/DetachedApp.tsx`: `useProjectStore.setState({ sidebarMode: "hidden" })`. Use plain setState, not the persisting action. Update the comment.
- `src/lib/menu-handlers.ts`: `ensureSidebarVisible` sets `full` when mode isn't `full` (the flows need `ProjectItem`). Map `"toggle-sidebar"` to `toggleSidebarRail` and add `"hide-sidebar"` → `toggleSidebarHidden`.
- `src/lib/keybinding-defs.ts`: relabel `toggle-sidebar` to "Collapse Sidebar" and keep its id and `⌘\`. Add `hide-sidebar`, "Hide Sidebar", `metaCombo("\\", true)`, category `app`. Add it to `src/lib/keybinding-commands.ts` wherever `toggle-sidebar` is listed.
- `src/components/command-palette/useCommands.tsx`: `toggle-sidebar` calls `toggleSidebarRail`, and a new `hide-sidebar` command calls `toggleSidebarHidden`. `focus-sidebar`: if mode is `hidden`, call `setSidebarMode(lastVisibleSidebarMode)`, then `focusRegionWhenReady("sidebar")`.
- Grep the whole repo (including `electron/` app menus) for `sidebarVisible`, `toggleSidebar` and `toggle-sidebar`, and migrate anything left.

Tests:
- Update `src/lib/__tests__/menu-handlers.test.ts`.
- Add store tests for the three actions and for loading persisted values, including an invalid one. Put them in `src/store/__tests__/`, following the existing files there.

## Files to touch
- `src/store/project-store.ts` — mode state, persistence, actions
- `src/App.tsx` — render by mode
- `src/components/tabbar/TabBar/TabBar.tsx` — inset by mode
- `src/DetachedApp.tsx` — hidden mode
- `src/lib/menu-handlers.ts` — ensureSidebarVisible, handlers
- `src/lib/keybinding-defs.ts`, `src/lib/keybinding-commands.ts` — relabel, new hide-sidebar
- `src/components/command-palette/useCommands.tsx` — commands
- `src/lib/__tests__/menu-handlers.test.ts`, `src/store/__tests__/sidebar-mode.test.ts` — tests
