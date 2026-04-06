---
title: Wire useTaskCommands to use useTaskDisplay
status: todo
priority: medium
assignee: haiku
blocked_by: [2]
---

# Wire useTaskCommands to use useTaskDisplay

Update `useTaskCommands.tsx` to use the shared `useTaskDisplay` hook instead of its own duplicated status mapping.

## What to do

1. Read `src/components/command-palette/useTaskCommands.tsx` fully.

2. Remove the local `taskAgentStatus()` function (lines 11-23, same pattern as TasksList/TasksView).

3. The command palette builds command objects from tasks. Since hooks can't be called in a loop during command construction, take a different approach: read the live pane data from the store directly (non-hook):

```typescript
const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
const paneTitle = useAppStore((s) => s.paneTitle);
```

Then for each task, compute title/status inline using the same logic as `useTaskDisplay` but without the hook wrapper (since we need it in a `.map()`). Import and use `cleanAgentTitle` from `../../utils/agent-title` and the `deriveStatus` helper.

**Alternative (simpler):** Export `deriveStatus` and `cleanLiveTitle` from `useTaskDisplay.ts` so they can be called as plain functions with store values passed in. Then use them in the `.map()`.

4. Update command labels to use the derived title instead of `task.name`.

## Files to touch
- `src/hooks/useTaskDisplay.ts` — export `deriveStatus` and `cleanLiveTitle` as named exports
- `src/components/command-palette/useTaskCommands.tsx` — remove local `taskAgentStatus`, use exported helpers
