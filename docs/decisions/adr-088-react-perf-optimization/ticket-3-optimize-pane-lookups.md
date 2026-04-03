---
title: Add hasPaneId helper and replace allPaneIds().includes() pattern
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add hasPaneId helper and replace allPaneIds().includes() pattern

The current pattern `sessions.find(s => allPaneIds(s.rootNode).includes(paneId))` rebuilds the entire pane ID array for every session, then does a linear scan. This is O(sessions * panes). Replace with a `hasPaneId(node, paneId)` function that walks the tree and short-circuits on first match.

## Changes

### 1. Add `hasPaneId` to `src/store/pane-tree.ts`

```tsx
/** Check if a pane ID exists in the tree (short-circuits on match). */
export function hasPaneId(node: PaneNode, paneId: string): boolean {
  if (node.type === "leaf") return node.paneId === paneId;
  return hasPaneId(node.first, paneId) || hasPaneId(node.second, paneId);
}
```

### 2. Replace all 9 occurrences

In every file, replace:
```tsx
sessions.find((s) => allPaneIds(s.rootNode).includes(paneId))
```
with:
```tsx
sessions.find((s) => hasPaneId(s.rootNode, paneId))
```

And:
```tsx
sessions.some((session) => allPaneIds(session.rootNode).includes(task.paneId!))
```
with:
```tsx
sessions.some((session) => hasPaneId(session.rootNode, task.paneId!))
```

## Files to touch
- `src/store/pane-tree.ts` — add `hasPaneId` function
- `src/store/app-store.ts` — replace 6 occurrences (lines ~571, 610, 613, 726, 815, 888), add `hasPaneId` to import
- `src/App.tsx` — replace 1 occurrence (line ~387), add `hasPaneId` to import
- `src/store/task-store.ts` — replace 1 occurrence (line ~133), add `hasPaneId` to import
- `src/utils/task-navigation.ts` — replace 1 occurrence (line ~29), add `hasPaneId` to import
