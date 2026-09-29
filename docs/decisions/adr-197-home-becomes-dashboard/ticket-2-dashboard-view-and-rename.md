---
title: Dashboard view without launchers, rename Home to Dashboard in UI
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Dashboard view without launchers, rename Home to Dashboard in UI

ADR-197 §6. Internal identifiers (`HOME_PATH`, `isHomePath`, `HomeDashboard`, `HomeEmptyState`, `data-testid`s, file names, the `"home"` menu command id) stay unchanged. Only user-visible strings change.

## Changes
- `src/components/sidebar/HomeEmptyState.tsx`: remove the New Agent / Open Terminal / Command Palette action rows and the `onNewAgent` prop. Render `HomeDashboard` inside `EmptyStateShell` with no actions. Update the doc comment ("Shown when Home is active" — it's the Dashboard surface now).
- `src/components/sidebar/EmptyStateShell.tsx`: make `actions` optional; don't render the actions `Stack` when empty.
- `src/App.tsx`: stop passing `onNewAgent` to `HomeEmptyState`.
- Rename visible "Home" → "Dashboard":
  - `src/components/sidebar/Sidebar/Sidebar.tsx` ~:226 label (consider a dashboard icon, e.g. lucide `layout-dashboard`, instead of House — use the same deep-import style as other lucide icons).
  - `src/components/sidebar/SidebarRail/SidebarRail.tsx` ~:92–105 Tooltip label and aria-label (same icon change).
  - `src/components/statusbar/StatusBar/StatusBar.tsx` ~:167.
  - `electron/app-menu-template.ts` ~:200 View › "Home" → "Dashboard"; ~:350 agent label fallback "Home" → "Dashboard".
- Update e2e/unit tests that assert on the visible "Home" text (`electron/app-menu-template.test.ts`, `tests/e2e/app-menu.spec.ts`, `tests/e2e/keyboard-navigation.spec.ts` if they match on label text; test ids stay).

Follow `.claude/rules/ui-components.md`. Run typecheck and affected tests.

## Files to touch
- `src/components/sidebar/HomeEmptyState.tsx`
- `src/components/sidebar/EmptyStateShell.tsx`
- `src/App.tsx`
- `src/components/sidebar/Sidebar/Sidebar.tsx`
- `src/components/sidebar/SidebarRail/SidebarRail.tsx`
- `src/components/statusbar/StatusBar/StatusBar.tsx`
- `electron/app-menu-template.ts`
- related tests
