import { describe, it, expect } from "vitest";
import {
  allPaneIds,
  insertSplit,
  removePane,
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
