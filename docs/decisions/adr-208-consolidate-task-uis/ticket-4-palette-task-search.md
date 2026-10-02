---
title: Palette — tasks inline in search, shared detail, popover swap
status: done
priority: high
assignee: opus
blocked_by: [2, 3]
---

# Palette — tasks inline in search, shared detail, popover swap

ADR-208 §4 and §6. Comps: "Palette — tasks inline in search", "Palette — shared TaskDetail".

## Tasks category

- `useTasks` (`src/components/tasks/useTasks.ts`) gains `enabled?: boolean` (default true) threaded into its `useQueries`.
- New `src/components/command-palette/usePaletteTasks.ts`: when `search.trim()` is non-empty, `useTaskScope` + `useTasks({ enabled })` across both connected providers (call per provider, or extend `useTasks` to accept several — prefer the smaller change), `taskList(...)` with `search`, scoped to the palette scope project's entry key when the ADR-200 chip is set. Returns top 5 rows plus total match count.
- In `CommandPalette.tsx` add a `tasks` category after agents/workspaces, visible only when the query is non-empty. Rows: `TrackerRowIcon`, `displayId` (mono), title, linked workspace (branch icon) or project, status pill; selected row shows "Start ↵" / "Open ↵". Item `value` must include `displayId` + title + labels so `paletteFilter` scores them.
- **Enter** → tracker row: `useStartTask(onNewWorkspace)` then close; linked row: `openLinkedTask` then close.
- **→** on a highlighted task row, only when the input caret is at the end of the query → open detail.
- Trailing item "See all N matching tasks in Tasks view" → `useAppStore.getState().showTasksView({ search, project: scopeEntryKey })`, close palette.
- Root ⌘↵ keeps its ADR-200 meaning (widen scope).

## Detail view

- `PaletteView` gains `task-detail`; state `selectedTask: { ref: TaskRef; row?: TaskRow; linked?: LinkedTask } | null`. Esc → back to root with the query preserved.
- Render `TaskDetail` with `layout="card"`, `mode` by linked-ness, `onDone={handleClose}`, `onNewAgentWithPrompt`, inside the existing `.paletteWide` shell.

## LinkedIssuesPopover

- `src/components/statusbar/LinkedIssuesPopover/LinkedIssuesPopover.tsx`: the dialog renders `TaskDetail` (`mode="linked"`, `layout="card"`) with `taskRef = trackerFor(p).refFromLink(issue, project)` (provider via `ownsLink`). Context-menu Unlink / Close call the seam's `unlink` / `close` (keep its optimistic update + revert + toasts).
- Its own `["linked-issue-details", …]` list query may stay; switch to `detailQuery` per issue if trivial.

## Files to touch
- `src/components/tasks/useTasks.ts`
- `src/components/command-palette/usePaletteTasks.ts` (new)
- `src/components/command-palette/CommandPalette.tsx`, `CommandPalette.module.css`, `types.ts`
- `src/components/statusbar/LinkedIssuesPopover/LinkedIssuesPopover.tsx`
- `src/components/command-palette/__tests__/palette-agent-renders.test.ts` — add a case: typing shows the Tasks group (mock `useTasks`)
