import { describe, it, expect } from "vitest";
import {
  allPaneIds,
  clonePaneTree,
  insertSplit,
  removePane,
  movePane,
  nextPaneId,
  updateRatio,
  type PaneNode,
} from "./pane-tree";

describe("allPaneIds", () => {
  it("returns single id for leaf", () => {
    const leaf: PaneNode = { type: "leaf", paneId: "a" };
    expect(allPaneIds(leaf)).toEqual(["a"]);
  });

  it("returns all ids for a split tree", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    expect(allPaneIds(tree)).toEqual(["a", "b"]);
  });

  it("returns ids in depth-first order", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "a" },
        second: { type: "leaf", paneId: "b" },
      },
      second: { type: "leaf", paneId: "c" },
    };
    expect(allPaneIds(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("insertSplit", () => {
  it("splits a leaf into a split node", () => {
    const leaf: PaneNode = { type: "leaf", paneId: "a" };
    const result = insertSplit(leaf, "a", "horizontal", "b");

    expect(result).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    });
  });

  it("does not split a non-matching leaf", () => {
    const leaf: PaneNode = { type: "leaf", paneId: "a" };
    const result = insertSplit(leaf, "x", "horizontal", "b");
    expect(result).toBe(leaf);
  });

  it("splits a nested target", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    const result = insertSplit(tree, "b", "vertical", "c");
    expect(allPaneIds(result)).toEqual(["a", "b", "c"]);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.second.type).toBe("split");
    }
  });
});

describe("removePane", () => {
  it("returns null when removing the only leaf", () => {
    const leaf: PaneNode = { type: "leaf", paneId: "a" };
    expect(removePane(leaf, "a")).toBeNull();
  });

  it("does not remove a non-matching leaf", () => {
    const leaf: PaneNode = { type: "leaf", paneId: "a" };
    expect(removePane(leaf, "x")).toBe(leaf);
  });

  it("collapses parent split when removing one child", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    const result = removePane(tree, "a");
    expect(result).toEqual({ type: "leaf", paneId: "b" });
  });

  it("collapses correctly in a deeper tree", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "b" },
        second: { type: "leaf", paneId: "c" },
      },
    };
    const result = removePane(tree, "b");
    expect(result).not.toBeNull();
    expect(allPaneIds(result!)).toEqual(["a", "c"]);
  });
});

describe("nextPaneId", () => {
  it("cycles to the next pane", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    expect(nextPaneId(tree, "a")).toBe("b");
    expect(nextPaneId(tree, "b")).toBe("a");
  });

  it("returns first pane when current not found", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    expect(nextPaneId(tree, "x")).toBe("a");
  });

  it("returns same pane for a single leaf", () => {
    const leaf: PaneNode = { type: "leaf", paneId: "a" };
    expect(nextPaneId(leaf, "a")).toBe("a");
  });
});

describe("updateRatio", () => {
  it("updates ratio of the split containing the target as first child", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    const result = updateRatio(tree, "a", 0.7);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.ratio).toBe(0.7);
    }
  });

  it("does not update ratio when target is not the direct first child", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    // "b" is not the first child
    const result = updateRatio(tree, "b", 0.7);
    if (result.type === "split") {
      expect(result.ratio).toBe(0.5);
    }
  });
});

describe("movePane", () => {
  it("swaps direct siblings when dropping in the same direction", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.6,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    // Drag "a" to the left side of "b" (same direction, position first)
    // Should still swap, not be a no-op
    const result = movePane(tree, "a", "b", "horizontal", "first");
    expect(result).not.toBeNull();
    expect(allPaneIds(result!)).toEqual(["b", "a"]);
    // Should preserve the original ratio
    if (result!.type === "split") {
      expect(result!.ratio).toBe(0.6);
    }
  });

  it("swaps direct siblings when dropping on the opposite side", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    // Drag "a" to the right side of "b" (same direction, position second)
    const result = movePane(tree, "a", "b", "horizontal", "second");
    expect(result).not.toBeNull();
    expect(allPaneIds(result!)).toEqual(["b", "a"]);
  });

  it("changes direction when siblings are dropped in a different orientation", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    // Drag "a" to the top of "b" (vertical, first) — changes to vertical, a on top
    const result = movePane(tree, "a", "b", "vertical", "first");
    expect(result).not.toBeNull();
    if (result!.type === "split") {
      expect(result!.direction).toBe("vertical");
      expect(allPaneIds(result!)).toEqual(["a", "b"]);
    }
  });

  it("falls back to remove+insert for non-sibling panes", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "a" },
        second: { type: "leaf", paneId: "b" },
      },
      second: { type: "leaf", paneId: "c" },
    };
    // Drag "a" to "c" — not siblings, uses general path
    const result = movePane(tree, "a", "c", "horizontal", "second");
    expect(result).not.toBeNull();
    expect(allPaneIds(result!)).toContain("a");
    expect(allPaneIds(result!)).toContain("b");
    expect(allPaneIds(result!)).toContain("c");
  });

  it("swaps nested siblings correctly", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "a" },
        second: { type: "leaf", paneId: "b" },
      },
      second: { type: "leaf", paneId: "c" },
    };
    // Drag "a" to "b" — they are siblings in the inner split
    const result = movePane(tree, "a", "b", "vertical", "first");
    expect(result).not.toBeNull();
    // Inner split should be swapped: b first, a second
    if (result!.type === "split" && result!.first.type === "split") {
      expect(allPaneIds(result!.first)).toEqual(["b", "a"]);
    }
    // Outer structure unchanged
    expect(allPaneIds(result!)).toEqual(["b", "a", "c"]);
  });
});

describe("clonePaneTree", () => {
  it("assigns a fresh paneId to a single leaf and records the mapping", () => {
    const leaf: PaneNode = {
      type: "leaf",
      paneId: "a",
      contentType: "browser",
      url: "https://example.com",
    };
    let n = 0;
    const { tree, idMap } = clonePaneTree(leaf, () => `new-${n++}`);
    expect(tree).toEqual({
      type: "leaf",
      paneId: "new-0",
      contentType: "browser",
      url: "https://example.com",
    });
    expect(idMap).toEqual({ a: "new-0" });
  });

  it("clones a nested split tree, preserving structure and direction", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.4,
      first: { type: "leaf", paneId: "a" },
      second: {
        type: "split",
        direction: "vertical",
        ratio: 0.7,
        first: { type: "leaf", paneId: "b" },
        second: { type: "leaf", paneId: "c" },
      },
    };
    let n = 0;
    const { tree: cloned, idMap } = clonePaneTree(tree, () => `x${n++}`);
    expect(allPaneIds(cloned)).toEqual(["x0", "x1", "x2"]);
    expect(idMap).toEqual({ a: "x0", b: "x1", c: "x2" });
    // Splits retain direction and ratio.
    if (cloned.type !== "split") throw new Error("expected split");
    expect(cloned.direction).toBe("horizontal");
    expect(cloned.ratio).toBe(0.4);
  });

  it("does not mutate the source tree", () => {
    const tree: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    };
    const snapshot = JSON.stringify(tree);
    clonePaneTree(tree, () => "mint");
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});
