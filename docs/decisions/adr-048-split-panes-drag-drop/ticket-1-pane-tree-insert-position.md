---
title: Add positional insert and move operations to pane-tree
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add positional insert and move operations to pane-tree

Add `insertSplitAt()` and `movePane()` functions to the pane tree module to support directional drop placement.

## Implementation

### `insertSplitAt`

Like `insertSplit` but accepts a `position: 'first' | 'second'` parameter:

```typescript
export function insertSplitAt(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
  position: "first" | "second",
): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId === targetPaneId) {
      const existing = node;
      const newLeaf: PaneNode = { type: "leaf", paneId: newPaneId };
      return {
        type: "split",
        direction,
        ratio: 0.5,
        first: position === "first" ? newLeaf : existing,
        second: position === "first" ? existing : newLeaf,
      };
    }
    return node;
  }
  return {
    ...node,
    first: insertSplitAt(node.first, targetPaneId, direction, newPaneId, position),
    second: insertSplitAt(node.second, targetPaneId, direction, newPaneId, position),
  };
}
```

### `movePane`

Combines remove + insert for moving a pane within a tree:

```typescript
export function movePane(
  node: PaneNode,
  sourcePaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
  position: "first" | "second",
): PaneNode | null {
  const afterRemove = removePane(node, sourcePaneId);
  if (!afterRemove) return null;
  return insertSplitAt(afterRemove, targetPaneId, direction, sourcePaneId, position);
}
```

## Files to touch
- `src/store/pane-tree.ts` — Add `insertSplitAt()` and `movePane()` functions, export them
