import { describe, it, expect } from "vitest";
import { layoutWithoutDiffPanes } from "../retired-diff-pane";
import type { PaneNode } from "../pane-tree";
import { type Tab, createSinglePanelLayout } from "../workspace-layout";

/** A leaf as a host server on an older bundle still sends it. */
const diffLeaf = (paneId: string) =>
  ({ type: "leaf", paneId, contentType: "diff" }) as unknown as PaneNode;

const terminalTab: Tab = { id: "t1", title: "zsh", rootNode: { type: "leaf", paneId: "p1" } };

describe("layoutWithoutDiffPanes", () => {
  it("turns a diff leaf, however deep, into an empty file pane on Source Control", () => {
    const tab: Tab = {
      id: "t2",
      title: "Diff",
      rootNode: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "p2", contentType: "browser", url: "http://x" },
        second: {
          type: "split",
          direction: "horizontal",
          ratio: 0.3,
          first: diffLeaf("p3"),
          second: { type: "leaf", paneId: "p4" },
        },
      },
    };
    const layout = createSinglePanelLayout("panel-1", [terminalTab, tab], ["t1"]);

    const next = layoutWithoutDiffPanes(layout);

    const [migrated] = next.panels["panel-1"].tabs.slice(1);
    expect(migrated.rootNode).toEqual({
      ...tab.rootNode,
      second: {
        type: "split",
        direction: "horizontal",
        ratio: 0.3,
        first: { type: "leaf", paneId: "p3", contentType: "file", startsOn: "scm" },
        second: { type: "leaf", paneId: "p4" },
      },
    });
    // Untouched tabs and the panel's other fields keep their identity.
    expect(next.panels["panel-1"].tabs[0]).toBe(terminalTab);
    expect(next.panels["panel-1"].pinnedTabIds).toEqual(["t1"]);
    expect(next.panelTree).toBe(layout.panelTree);
  });

  it("answers the same layout when it has no diff leaf", () => {
    const layout = createSinglePanelLayout("panel-1", [terminalTab], []);
    expect(layoutWithoutDiffPanes(layout)).toBe(layout);
  });

  it("is idempotent", () => {
    const layout = createSinglePanelLayout(
      "panel-1",
      [{ id: "t", title: "Diff", rootNode: diffLeaf("p") }],
      [],
    );
    const once = layoutWithoutDiffPanes(layout);
    expect(layoutWithoutDiffPanes(once)).toBe(once);
  });
});
