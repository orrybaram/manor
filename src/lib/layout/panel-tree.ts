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

export function allPanelIds(node: PanelNode): string[] {
  if (node.type === "leaf") return [node.panelId];
  return [...allPanelIds(node.first), ...allPanelIds(node.second)];
}

export function hasPanelId(node: PanelNode, id: string): boolean {
  if (node.type === "leaf") return node.panelId === id;
  return hasPanelId(node.first, id) || hasPanelId(node.second, id);
}

export function insertPanelSplit(
  node: PanelNode,
  targetPanelId: string,
  direction: SplitDirection,
  newPanelId: string,
  position: "first" | "second" = "second",
  ratio = 0.5,
): PanelNode {
  if (node.type === "leaf") {
    if (node.panelId === targetPanelId) {
      const newLeaf: PanelNode = { type: "leaf", panelId: newPanelId };
      return {
        type: "split",
        direction,
        ratio,
        first: position === "first" ? newLeaf : node,
        second: position === "first" ? node : newLeaf,
      };
    }
    return node;
  }
  const newFirst = insertPanelSplit(node.first, targetPanelId, direction, newPanelId, position, ratio);
  if (newFirst !== node.first) return { ...node, first: newFirst };
  const newSecond = insertPanelSplit(node.second, targetPanelId, direction, newPanelId, position, ratio);
  if (newSecond !== node.second) return { ...node, second: newSecond };
  return node;
}

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

/** Only updates when firstPanelId is a direct leaf first-child of a split. */
export function updatePanelRatio(
  node: PanelNode,
  firstPanelId: string,
  ratio: number,
): PanelNode {
  if (node.type === "leaf") return node;
  if (node.first.type === "leaf" && node.first.panelId === firstPanelId) {
    return { ...node, ratio };
  }
  const newFirst = updatePanelRatio(node.first, firstPanelId, ratio);
  if (newFirst !== node.first) return { ...node, first: newFirst };
  const newSecond = updatePanelRatio(node.second, firstPanelId, ratio);
  if (newSecond !== node.second) return { ...node, second: newSecond };
  return node;
}

function firstLeafPanelId(node: PanelNode): string {
  if (node.type === "leaf") return node.panelId;
  return firstLeafPanelId(node.first);
}

function lastLeafPanelId(node: PanelNode): string {
  if (node.type === "leaf") return node.panelId;
  return lastLeafPanelId(node.second);
}

/** Find the parent split context for a panel: sibling, direction, ratio, and position. */
export function findPanelSplitContext(
  node: PanelNode,
  panelId: string,
): { siblingId: string; direction: SplitDirection; ratio: number; position: "first" | "second" } | null {
  if (node.type === "leaf") return null;
  if (node.first.type === "leaf" && node.first.panelId === panelId) {
    return { siblingId: firstLeafPanelId(node.second), direction: node.direction, ratio: node.ratio, position: "first" };
  }
  if (node.second.type === "leaf" && node.second.panelId === panelId) {
    return { siblingId: lastLeafPanelId(node.first), direction: node.direction, ratio: node.ratio, position: "second" };
  }
  return findPanelSplitContext(node.first, panelId) ?? findPanelSplitContext(node.second, panelId);
}

export function nextPanelId(
  node: PanelNode,
  currentId: string,
): string | null {
  const ids = allPanelIds(node);
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0] ?? null;
  return ids[(idx + 1) % ids.length];
}

export function prevPanelId(
  node: PanelNode,
  currentId: string,
): string | null {
  const ids = allPanelIds(node);
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0] ?? null;
  return ids[(idx - 1 + ids.length) % ids.length];
}
