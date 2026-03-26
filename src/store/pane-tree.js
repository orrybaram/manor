"use strict";
/** Binary tree model for pane layout — mirrors ManorCore's PaneNode. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.allPaneIds = allPaneIds;
exports.insertSplit = insertSplit;
exports.removePane = removePane;
exports.insertSplitAt = insertSplitAt;
exports.movePane = movePane;
exports.insertSubtreeAt = insertSubtreeAt;
exports.updateRatio = updateRatio;
exports.nextPaneId = nextPaneId;
exports.prevPaneId = prevPaneId;
/** Collect every paneId in the tree. */
function allPaneIds(node) {
    if (node.type === "leaf")
        return [node.paneId];
    return [...allPaneIds(node.first), ...allPaneIds(node.second)];
}
/** Insert a split at the given paneId, pushing the existing pane into `first`. */
function insertSplit(node, targetPaneId, direction, newPaneId) {
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
function removePane(node, targetPaneId) {
    if (node.type === "leaf") {
        return node.paneId === targetPaneId ? null : node;
    }
    const first = removePane(node.first, targetPaneId);
    const second = removePane(node.second, targetPaneId);
    if (first === null && second === null)
        return null;
    if (first === null)
        return second;
    if (second === null)
        return first;
    return { ...node, first, second };
}
/** Insert a split at the given paneId with explicit position control for the new pane. */
function insertSplitAt(node, targetPaneId, direction, newPaneId, position) {
    if (node.type === "leaf") {
        if (node.paneId === targetPaneId) {
            const existing = node;
            const newLeaf = { type: "leaf", paneId: newPaneId };
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
/** Move a pane within the tree by removing it and reinserting at the target position. */
function movePane(node, sourcePaneId, targetPaneId, direction, position) {
    // When source and target are direct leaf siblings, swap in-place
    const swapped = swapSiblings(node, sourcePaneId, targetPaneId, direction, position);
    if (swapped)
        return swapped;
    const afterRemove = removePane(node, sourcePaneId);
    if (!afterRemove)
        return null;
    return insertSplitAt(afterRemove, targetPaneId, direction, sourcePaneId, position);
}
/**
 * If source and target are direct leaf children of the same split, swap them.
 * When the drop direction matches the split direction, always swap positions
 * (the user's intent is to reorder, not to nest). When the direction differs,
 * use the drop position to place the source in the new orientation.
 */
function swapSiblings(node, sourcePaneId, targetPaneId, direction, position) {
    if (node.type === "leaf")
        return null;
    if (node.first.type === "leaf" && node.second.type === "leaf") {
        const firstId = node.first.paneId;
        const secondId = node.second.paneId;
        if ((firstId === sourcePaneId && secondId === targetPaneId) ||
            (firstId === targetPaneId && secondId === sourcePaneId)) {
            if (direction === node.direction) {
                // Same direction: always swap positions
                return { ...node, first: node.second, second: node.first };
            }
            // Different direction: respect position for the new orientation
            const sourceLeaf = { type: "leaf", paneId: sourcePaneId };
            const targetLeaf = { type: "leaf", paneId: targetPaneId };
            return {
                ...node,
                direction,
                first: position === "first" ? sourceLeaf : targetLeaf,
                second: position === "second" ? sourceLeaf : targetLeaf,
            };
        }
    }
    // Recurse into children
    const fromFirst = swapSiblings(node.first, sourcePaneId, targetPaneId, direction, position);
    if (fromFirst)
        return { ...node, first: fromFirst };
    const fromSecond = swapSiblings(node.second, sourcePaneId, targetPaneId, direction, position);
    if (fromSecond)
        return { ...node, second: fromSecond };
    return null;
}
/** Insert an entire subtree at the given paneId with explicit position control. */
function insertSubtreeAt(node, targetPaneId, direction, subtree, position) {
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
        first: insertSubtreeAt(node.first, targetPaneId, direction, subtree, position),
        second: insertSubtreeAt(node.second, targetPaneId, direction, subtree, position),
    };
}
/** Update the split ratio at the split that directly contains targetPaneId as first child. */
function updateRatio(node, splitFirstPaneId, ratio) {
    if (node.type === "leaf")
        return node;
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
function nextPaneId(node, currentPaneId) {
    const ids = allPaneIds(node);
    const idx = ids.indexOf(currentPaneId);
    if (idx === -1)
        return ids[0] ?? null;
    return ids[(idx + 1) % ids.length];
}
/** Find the previous pane id before the given one (for focus cycling). */
function prevPaneId(node, currentPaneId) {
    const ids = allPaneIds(node);
    const idx = ids.indexOf(currentPaneId);
    if (idx === -1)
        return ids[0] ?? null;
    return ids[(idx - 1 + ids.length) % ids.length];
}
