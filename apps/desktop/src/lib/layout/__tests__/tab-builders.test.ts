/**
 * The tab builders both senders share, and the Source Control lookup that
 * must find its pane wherever it is.
 */
import { describe, it, expect } from "vitest";
import {
  cloneTabWithFreshIds,
  createBrowserTab,
  createSourceControlTab,
  findSourceControlPane,
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
    second: { type: "leaf", paneId: "pane-scm", contentType: "file", startsOn: "scm" },
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

describe("createSourceControlTab", () => {
  it("is one empty file leaf on Source Control, with fresh ids", () => {
    const a = createSourceControlTab();
    const b = createSourceControlTab();
    expect(a.rootNode).toEqual({
      type: "leaf",
      paneId: expect.any(String),
      contentType: "file",
      startsOn: "scm",
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("cloneTabWithFreshIds", () => {
  it("mints a fresh id for the tab and every pane, keeping the shape", () => {
    const { tab, idMap } = cloneTabWithFreshIds(splitTab);
    expect(tab.id).not.toBe(splitTab.id);
    expect(tab.title).toBe(splitTab.title);
    expect(Object.keys(idMap).sort()).toEqual(["pane-1", "pane-scm"]);
    expect(allPaneIds(tab.rootNode)).toEqual([idMap["pane-1"], idMap["pane-scm"]]);
  });
});

describe("findSourceControlPane", () => {
  it("finds a Source Control pane below a tab's root", () => {
    expect(findSourceControlPane(layoutOf(splitTab))).toEqual({
      paneId: "pane-scm",
      tabId: "tab-split",
    });
  });

  it("still finds it once a file is open there", () => {
    const opened: Tab = {
      id: "t",
      title: "a.ts",
      rootNode: { type: "leaf", paneId: "p", contentType: "file", filePath: "a.ts", startsOn: "scm" },
    };
    expect(findSourceControlPane(layoutOf(opened))).toEqual({ paneId: "p", tabId: "t" });
  });

  it("answers null when no pane is one, a plain file pane with a file open included", () => {
    const tab: Tab = { id: "t", title: "T", rootNode: { type: "leaf", paneId: "p" } };
    const file: Tab = {
      id: "f",
      title: "F",
      rootNode: { type: "leaf", paneId: "q", contentType: "file", filePath: "a.ts" },
    };
    expect(findSourceControlPane(layoutOf(tab, file))).toBeNull();
  });
});

describe("layoutPaneIds", () => {
  it("holds every pane of every tab", () => {
    const other: Tab = { id: "t", title: "T", rootNode: { type: "leaf", paneId: "p" } };
    expect([...layoutPaneIds(layoutOf(splitTab, other))]).toEqual([
      "pane-1",
      "pane-scm",
      "p",
    ]);
  });
});
