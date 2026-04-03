---
title: Add openOrFocusDiff store action and command palette entry
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add openOrFocusDiff store action and command palette entry

## Implementation

### 1. Add `openOrFocusDiff` action to `src/store/app-store.ts`

Add a new action that:
- Gets the active workspace sessions
- Iterates through all sessions, using `allPaneIds()` from `pane-tree.ts` to get pane IDs
- Checks `state.paneContentType[paneId]` for `"diff"`
- If found: sets `selectedSessionId` to that session and `focusedPaneId` to the diff pane
- If not found: delegates to the existing `addDiffSession()` logic

Add `openOrFocusDiff: () => void` to the `AppActions` interface.

### 2. Add command to `src/components/command-palette/useCommands.tsx`

- Add `openOrFocusDiff` to `UseCommandsParams` interface
- Add a command item with id `"open-diff"`, label `"Open Diff"`, keywords `["git", "changes", "diff", "staged"]`
- Wire the action through: call `openOrFocusDiff()` then `onClose()`

### 3. Wire through `CommandPalette.tsx`

- Pull `openOrFocusDiff` from `useAppStore` at the top of the component
- Pass it to `useCommands()`

## Files to touch
- `src/store/app-store.ts` — add `openOrFocusDiff` action
- `src/components/command-palette/useCommands.tsx` — add command item and param
- `src/components/command-palette/CommandPalette.tsx` — wire new store action to useCommands
