---
title: Tasks view detail drawer and showTasksView intent
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Tasks view detail drawer and showTasksView intent

ADR-208 §3 and §5. Comp: "Tasks view A — detail drawer".

## Drawer

- `TasksView` holds `openKey: string | null` (row `key`). Drawer is a 440px right panel inside the page, beside the table (table flexes).
- `TaskTableRow` gains `onOpen?: () => void` and `selected?: boolean`. When `onOpen` is set the title becomes a `Button variant="ghost"`-styled trigger that calls it; the ID chip stays a `Link` to the tracker. Home's Up next (`UpNextPanel`, `compact`) keeps current behaviour.
- While open: hide Assignees and Priority columns (header + rows + skeleton); highlight the selected row; ↑/↓ and j/k move `openKey` within the current page (ignore when focus is in an input); Esc closes. Closing returns focus to the row's title.
- Tracker rows → `TaskDetail` with `taskRef = tracker.refOf(row)`, `row`, `mode="default"`, `layout="drawer"`.
- Linked rows (`LinkedTask`) → resolve the project from `projectId` in `useProjectStore`, `taskRef = tracker.refFromLink(...)` (provider from `row.provider`), `mode="linked"`, `linkedTo={row.workspaceName}`, `projectId`, `workspacePath`. Also keep an "Open workspace" action — pass through via the existing `openLinkedTask`.
- If the open row disappears (filter/page change) close the drawer.
- Drawer header: prev/next `Button`s, ID, open-in-tracker `Link`, close `Button` (all with `aria-label`, `Tooltip`).
- Remove the unused `onOpenPaletteView` prop from `TasksView` and its call site in `App.tsx`. Pass `onNewAgentWithPrompt` from App if available (same handler the palette gets).

## showTasksView intent

- `src/store/app-store.ts`: `showTasksView(intent?: { search?: string; project?: string | null })`; store a one-shot `tasksIntent` alongside `activeSurface`. Add `consumeTasksIntent()` (returns and clears).
- `TasksView`: on mount and when `tasksIntent` changes, consume it → `setSearch`, `prefs.setProject(project)` (entry key; `null` = all), `setPage(1)`.
- Update `src/store/__tests__/app-store-active-surface.test.ts` for the intent.

## Files to touch
- `src/components/tasks/TasksView.tsx`, `TasksView.module.css`
- `src/components/tasks/TaskTableRow.tsx`
- `src/store/app-store.ts`, `src/store/__tests__/app-store-active-surface.test.ts`
- `src/App.tsx` — drop `onOpenPaletteView` on `TasksView`, pass `onNewAgentWithPrompt`
