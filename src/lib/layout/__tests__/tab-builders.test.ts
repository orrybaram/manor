/**
 * The tab builders both senders share (ADR-182 D8), and the diff lookup that
 * must find a diff pane wherever it is.
 */
import { describe, it, expect } from "vitest";
import {
  cloneTabWithFreshIds,
  createBrowserTab,
  createDiffTab,
  findDiffPane,
} from "../tab-builders";
import { allPaneIds } from "../pane-tree";
import {
  type Tab,
  type WorkspaceLayout,
  createSinglePanelLayout,
  layoutPaneIds,
} from "../workspace-layout";

const splitTab: Tab = {
  id: "tab-split",
  title: "Work",
  rootNode: {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", paneId: "pane-1" },
    second: { type: "leaf", paneId: "pane-diff", contentType: "diff" },
  },
};

function layoutOf(...tabs: Tab[]): WorkspaceLayout {
  return createSinglePanelLayout("panel-1", tabs, []);
}

describe("createBrowserTab", () => {
  it("titles the tab from the url's host", () => {
    const tab = createBrowserTab("https://example.com/path");
    expect(tab.title).toBe("example.com");
    expect(tab.rootNode).toMatchObject({ contentType: "browser", url: "https://example.com/path" });
  });

  it("falls back to the url itself when it does not parse", () => {
    expect(createBrowserTab("not a url").title).toBe("not a url");
  });
});

describe("createDiffTab", () => {
  it("is one diff leaf with fresh ids", () => {
    const a = createDiffTab();
    const b = createDiffTab();
    expect(a.rootNode).toMatchObject({ type: "leaf", contentType: "diff" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("cloneTabWithFreshIds", () => {
  it("mints a fresh id for the tab and every pane, keeping the shape", () => {
    const { tab, idMap } = cloneTabWithFreshIds(splitTab);
    expect(tab.id).not.toBe(splitTab.id);
    expect(tab.title).toBe(splitTab.title);
    expect(Object.keys(idMap).sort()).toEqual(["pane-1", "pane-diff"]);
    expect(allPaneIds(tab.rootNode)).toEqual([idMap["pane-1"], idMap["pane-diff"]]);
  });
});

describe("findDiffPane", () => {
  it("finds a diff pane below a tab's root", () => {
    expect(findDiffPane(layoutOf(splitTab))).toEqual({
      paneId: "pane-diff",
      tabId: "tab-split",
    });
  });

  it("answers null when no pane is a diff", () => {
    const tab: Tab = { id: "t", title: "T", rootNode: { type: "leaf", paneId: "p" } };
    expect(findDiffPane(layoutOf(tab))).toBeNull();
  });
});

describe("layoutPaneIds", () => {
  it("holds every pane of every tab", () => {
    const other: Tab = { id: "t", title: "T", rootNode: { type: "leaf", paneId: "p" } };
    expect([...layoutPaneIds(layoutOf(splitTab, other))]).toEqual([
      "pane-1",
      "pane-diff",
      "p",
    ]);
  });
});
