import { describe, it, expect } from "vitest";
import { panelTreeContains, type PanelNode } from "../panel-tree";

describe("panelTreeContains", () => {
  const tree: PanelNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", panelId: "p1" },
    second: {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", panelId: "p2" },
      second: { type: "leaf", panelId: "p3" },
    },
  };

  it("finds a leaf at any depth", () => {
    expect(panelTreeContains(tree, "p1")).toBe(true);
    expect(panelTreeContains(tree, "p3")).toBe(true);
  });

  it("scopes to the subtree it is given", () => {
    if (tree.type !== "split") throw new Error("fixture is a split");
    expect(panelTreeContains(tree.first, "p2")).toBe(false);
    expect(panelTreeContains(tree.second, "p2")).toBe(true);
  });

  it("matches a lone leaf only by its own id", () => {
    const leaf: PanelNode = { type: "leaf", panelId: "p1" };
    expect(panelTreeContains(leaf, "p1")).toBe(true);
    expect(panelTreeContains(leaf, "p2")).toBe(false);
  });

  it("is false for an absent id", () => {
    expect(panelTreeContains(tree, null)).toBe(false);
    expect(panelTreeContains(tree, undefined)).toBe(false);
    expect(panelTreeContains(tree, "")).toBe(false);
    expect(panelTreeContains(tree, "zzz")).toBe(false);
  });
});
