import { describe, expect, it } from "vitest";
import { topLeftPanelId, type PanelNode } from "../panel-tree";

const leaf = (panelId: string): PanelNode => ({ type: "leaf", panelId });

describe("topLeftPanelId", () => {
  it("returns a lone leaf", () => {
    expect(topLeftPanelId(leaf("a"))).toBe("a");
  });

  it("follows first through nested splits", () => {
    const tree: PanelNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: leaf("top-left"),
        second: leaf("bottom-left"),
      },
      second: leaf("right"),
    };
    expect(topLeftPanelId(tree)).toBe("top-left");
  });

  it("ignores the second branch even when it is deeper", () => {
    const tree: PanelNode = {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("top"),
      second: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: leaf("b1"),
        second: leaf("b2"),
      },
    };
    expect(topLeftPanelId(tree)).toBe("top");
  });
});
