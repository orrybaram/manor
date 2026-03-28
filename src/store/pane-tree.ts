/** Binary tree model for pane layout — mirrors ManorCore's PaneNode. */

export type SplitDirection = "horizontal" | "vertical";

export type PaneNode =
  | {
      type: "leaf";
      paneId: string;
      contentType?: "terminal" | "browser";
      url?: string;
    }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

/** Collect every paneId in the tree. */
export function allPaneIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.paneId];
  return [...allPaneIds(node.first), ...allPaneIds(node.second)];
}

/** Insert a split at the given paneId, pushing the existing pane into `first`. */
export function insertSplit(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId === targetPaneId) {
      return {
        type: "split",
        direction,
        ratio: 0.5,
        first: node,
        second: { type: "leaf", paneId: newPaneId },
      };
    }
    return node;
  }
  return {
    ...node,
    first: insertSplit(node.first, targetPaneId, direction, newPaneId),
    second: insertSplit(node.second, targetPaneId, direction, newPaneId),
  };
}

/** Remove a pane, collapsing its parent split. Returns null if tree is empty. */
export function removePane(
  node: PaneNode,
  targetPaneId: string,
): PaneNode | null {
  if (node.type === "leaf") {
    return node.paneId === targetPaneId ? null : node;
  }
  const first = removePane(node.first, targetPaneId);
  const second = removePane(node.second, targetPaneId);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

/** Insert a split at the given paneId with explicit position control for the new pane. */
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
    first: insertSplitAt(
      node.first,
      targetPaneId,
      direction,
      newPaneId,
      position,
    ),
    second: insertSplitAt(
      node.second,
      targetPaneId,
      direction,
      newPaneId,
      position,
    ),
  };
}

/** Move a pane within the tree by removing it and reinserting at the target position. */
export function movePane(
  node: PaneNode,
  sourcePaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
  position: "first" | "second",
): PaneNode | null {
  // When source and target are direct leaf siblings, swap in-place
  const swapped = swapSiblings(
    node,
    sourcePaneId,
    targetPaneId,
    direction,
    position,
  );
  if (swapped) return swapped;

  const afterRemove = removePane(node, sourcePaneId);
  if (!afterRemove) return null;
  return insertSplitAt(
    afterRemove,
    targetPaneId,
    direction,
    sourcePaneId,
    position,
  );
}

/**
 * If source and target are direct leaf children of the same split, swap them.
 * When the drop direction matches the split direction, always swap positions
 * (the user's intent is to reorder, not to nest). When the direction differs,
 * use the drop position to place the source in the new orientation.
 */
function swapSiblings(
  node: PaneNode,
  sourcePaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
  position: "first" | "second",
): PaneNode | null {
  if (node.type === "leaf") return null;

  if (node.first.type === "leaf" && node.second.type === "leaf") {
    const firstId = node.first.paneId;
    const secondId = node.second.paneId;
    if (
      (firstId === sourcePaneId && secondId === targetPaneId) ||
      (firstId === targetPaneId && secondId === sourcePaneId)
    ) {
      if (direction === node.direction) {
        // Same direction: always swap positions
        return { ...node, first: node.second, second: node.first };
      }
      // Different direction: respect position for the new orientation
      const sourceLeaf: PaneNode = { type: "leaf", paneId: sourcePaneId };
      const targetLeaf: PaneNode = { type: "leaf", paneId: targetPaneId };
      return {
        ...node,
        direction,
        first: position === "first" ? sourceLeaf : targetLeaf,
        second: position === "second" ? sourceLeaf : targetLeaf,
      };
    }
  }

  // Recurse into children
  const fromFirst = swapSiblings(
    node.first,
    sourcePaneId,
    targetPaneId,
    direction,
    position,
  );
  if (fromFirst) return { ...node, first: fromFirst };

  const fromSecond = swapSiblings(
    node.second,
    sourcePaneId,
    targetPaneId,
    direction,
    position,
  );
  if (fromSecond) return { ...node, second: fromSecond };

  return null;
}

/** Insert an entire subtree at the given paneId with explicit position control. */
export function insertSubtreeAt(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  subtree: PaneNode,
  position: "first" | "second",
): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId === targetPaneId) {
      return {
        type: "split",
        direction,
        ratio: 0.5,
        first: position === "first" ? subtree : node,
        second: position === "first" ? node : subtree,
      };
    }
    return node;
  }
  return {
    ...node,
    first: insertSubtreeAt(
      node.first,
      targetPaneId,
      direction,
      subtree,
      position,
    ),
    second: insertSubtreeAt(
      node.second,
      targetPaneId,
      direction,
      subtree,
      position,
    ),
  };
}

/** Update the split ratio at the split that directly contains targetPaneId as first child. */
export function updateRatio(
  node: PaneNode,
  splitFirstPaneId: string,
  ratio: number,
): PaneNode {
  if (node.type === "leaf") return node;
  // Check if the first child's leftmost pane matches
  const firstIds = allPaneIds(node.first);
  if (firstIds.includes(splitFirstPaneId)) {
    // If this split directly contains the target as first child
    if (node.first.type === "leaf" && node.first.paneId === splitFirstPaneId) {
      return { ...node, ratio };
    }
  }
  return {
    ...node,
    first: updateRatio(node.first, splitFirstPaneId, ratio),
    second: updateRatio(node.second, splitFirstPaneId, ratio),
  };
}

/** Find the next pane id after the given one (for focus cycling). */
export function nextPaneId(
  node: PaneNode,
  currentPaneId: string,
): string | null {
  const ids = allPaneIds(node);
  const idx = ids.indexOf(currentPaneId);
  if (idx === -1) return ids[0] ?? null;
  return ids[(idx + 1) % ids.length];
}

/** Find the previous pane id before the given one (for focus cycling). */
export function prevPaneId(
  node: PaneNode,
  currentPaneId: string,
): string | null {
  const ids = allPaneIds(node);
  const idx = ids.indexOf(currentPaneId);
  if (idx === -1) return ids[0] ?? null;
  return ids[(idx - 1 + ids.length) % ids.length];
}
