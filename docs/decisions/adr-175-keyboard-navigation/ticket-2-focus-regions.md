---
title: Focus regions, F6 cycling, focus-sidebar/focus-tabbar commands
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Focus regions, F6 cycling, focus-sidebar/focus-tabbar commands

1. New `src/lib/focus-regions.ts`:
   - `type FocusRegion = "sidebar" | "tabbar" | "pane" | "statusbar"`.
   - `REGION_ATTR = "data-focus-region"`.
   - `currentRegion()`, `isNavRegionFocused()` (active element inside a region
     other than `pane`), `focusRegion(region)`, `cycleRegion(delta)`.
   - Target per region: sidebar → `[data-sidebar-row][tabindex="0"]` or the
     active workspace row, else first row; tabbar → `[role="tab"][aria-selected="true"]`;
     pane → `useAppStore.getState().refocusActivePane()`; statusbar → first
     focusable. Skip regions not in the DOM / hidden / with no target.
2. Put `data-focus-region` on the roots: sidebar (`Sidebar.tsx`), tab bar
   (`TabBar.tsx`), pane area (workspace panes container), status bar.
   **In popout windows too** where those exist.
3. Keybindings (`src/lib/keybinding-defs.ts`): add `focus-next-region` (F6,
   no modifier), `focus-prev-region` (Shift+F6), `focus-sidebar`
   (Meta+Shift+E), `focus-tabbar` (Meta+Shift+Y). Check no default conflicts
   (defs and `electron/app-menu-template.ts`). Category: a navigation one that
   exists or "workspace".
4. `src/lib/keybinding-commands.ts` `dispatchKeybinding`: allow F1–F12 with no
   modifier. Keep ignoring other unmodified keys.
5. Handlers in `src/lib/menu-handlers.ts`: `focus-sidebar` opens the sidebar
   if hidden (store toggle) then focuses after a frame; others call
   `focus-regions`. Add palette entries in `useCommands.tsx` ("Focus
   Sidebar", "Focus Tab Bar"). Add menu items under View in
   `electron/app-menu-template.ts` if the menu mirrors keybindings.
6. `src/hooks/useTerminalHotkeys.ts`: F6/Shift+F6 must reach window (verify
   the bound-combo passthrough covers function keys).
7. `src/hooks/useTerminalLifecycle.ts`: replace `isSidebarRowFocused()` with
   `isNavRegionFocused()` so focusing tabs/status bar isn't undone.
   Keep `sidebar-row.ts` exporting `isSidebarRowFocused` if still used elsewhere.
8. Docs: add the new shortcuts wherever shortcuts are documented (grep
   README/docs for "⌘⇧G" or "Open Diff").
9. Unit tests (vitest) for `cycleRegion` ordering/skip logic and the
   dispatcher F-key allowance, next to existing tests for these modules.

## Files to touch
- `src/lib/focus-regions.ts` (new) + test
- `src/lib/keybinding-defs.ts`, `src/lib/keybinding-commands.ts`, `src/lib/menu-handlers.ts`
- `src/hooks/useTerminalHotkeys.ts`, `src/hooks/useTerminalLifecycle.ts`
- `src/components/sidebar/Sidebar.tsx`, `src/components/tabbar/TabBar.tsx`, status bar component, pane container
- `src/components/command-palette/useCommands.tsx`
- `electron/app-menu-template.ts`, docs
