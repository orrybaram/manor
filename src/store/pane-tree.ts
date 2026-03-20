/** Binary tree model for pane layout — mirrors ManorCore's PaneNode. */

export type SplitDirection = "horizontal" | "vertical";

export type PaneNode =
  | { type: "leaf"; paneId: string }
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
