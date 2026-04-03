---
title: Decompose CommandPalette command definitions
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Decompose CommandPalette command definitions

`CommandPalette/CommandPalette.tsx` is 510 lines. The bulk is two large `useMemo` blocks that build command arrays. Extract them into custom hooks.

## New files

### `src/components/CommandPalette/useCommands.ts`
- Extract the `commands` useMemo (lines ~162-320) into a `useCommands(params)` hook
- Params: all the store actions and callbacks it currently closes over
- Returns: `CommandItem[]`

### `src/components/CommandPalette/useWorkspaceCommands.ts`
- Extract the `workspaceCommands` useMemo (lines ~115-160) and `workspaceGroups` useMemo (lines ~322-336) into a `useWorkspaceCommands(params)` hook
- Returns: `{ workspaceGroups: Map<string, CommandItem[]> }`

### `src/components/CommandPalette/CommandPalette.tsx`
- Import and use the two new hooks
- Should shrink to ~300 lines (mostly rendering)

## Files to touch
- `src/components/CommandPalette/CommandPalette.tsx` — extract command hooks
- `src/components/CommandPalette/useCommands.ts` — create
- `src/components/CommandPalette/useWorkspaceCommands.ts` — create
