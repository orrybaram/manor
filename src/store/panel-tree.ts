/** Binary tree model for panel layout (editor groups). */

import type { SplitDirection } from "./pane-tree";

export type PanelNode =
  | { type: "leaf"; panelId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: PanelNode;
      second: PanelNode;
    };

/** Collect every panelId in the tree. */
export function allPanelIds(node: PanelNode): string[] {
  if (node.type === "leaf") return [node.panelId];
  return [...allPanelIds(node.first), ...allPanelIds(node.second)];
}

/** Check if a panel ID exists in the tree (short-circuits on match). */
export function hasPanelId(node: PanelNode, id: string): boolean {
  if (node.type === "leaf") return node.panelId === id;
  return hasPanelId(node.first, id) || hasPanelId(node.second, id);
}

/** Insert a split at the given panelId, pushing the existing panel into `first`. */
export function insertPanelSplit(
  node: PanelNode,
  targetPanelId: string,
  direction: SplitDirection,
  newPanelId: string,
): PanelNode {
  if (node.type === "leaf") {
    if (node.panelId === targetPanelId) {
      return {
        type: "split",
        direction,
        ratio: 0.5,
        first: node,
        second: { type: "leaf", panelId: newPanelId },
      };
    }
    return node;
  }
  return {
    ...node,
    first: insertPanelSplit(node.first, targetPanelId, direction, newPanelId),
    second: insertPanelSplit(node.second, targetPanelId, direction, newPanelId),
  };
}

/** Remove a panel, collapsing its parent split. Returns null if tree is empty. */
export function removePanel(
  node: PanelNode,
  panelId: string,
): PanelNode | null {
  if (node.type === "leaf") {
    return node.panelId === panelId ? null : node;
  }
  const first = removePanel(node.first, panelId);
  const second = removePanel(node.second, panelId);
  if (first === null && second === null) return null;
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

/** Update the split ratio at the split that directly contains targetPanelId as first child. */
export function updatePanelRatio(
  node: PanelNode,
  firstPanelId: string,
  ratio: number,
): PanelNode {
  if (node.type === "leaf") return node;
  if (node.first.type === "leaf" && node.first.panelId === firstPanelId) {
    return { ...node, ratio };
  }
  return {
    ...node,
    first: updatePanelRatio(node.first, firstPanelId, ratio),
    second: updatePanelRatio(node.second, firstPanelId, ratio),
  };
}

/** Find the next panel id after the given one (for focus cycling). */
export function nextPanelId(
  node: PanelNode,
  currentId: string,
): string | null {
  const ids = allPanelIds(node);
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0] ?? null;
  return ids[(idx + 1) % ids.length];
}

/** Find the previous panel id before the given one (for focus cycling). */
export function prevPanelId(
  node: PanelNode,
  currentId: string,
): string | null {
  const ids = allPanelIds(node);
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0] ?? null;
  return ids[(idx - 1 + ids.length) % ids.length];
}
