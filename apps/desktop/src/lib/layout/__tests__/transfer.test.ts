/**
 * `sendTab` / `receiveTab`: the two halves of a move between workspaces.
 * Sending kills nothing and leaves the reopen stack alone; receiving keeps
 * the tab whole, pinned state included.
 */
import { describe, it, expect } from "vitest";
import {
  type ClosedPane,
  type LayoutState,
  receiveTab,
  sendTab,
} from "../commands";
import type { Panel, Tab, WorkspaceLayout } from "../workspace-layout";

function leafTab(id: string, paneId: string): Tab {
  return { id, title: "Terminal", rootNode: { type: "leaf", paneId } };
}

function splitTab(id: string, first: string, second: string): Tab {
  return {
    id,
    title: "Build",
    rootNode: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: first },
      second: { type: "leaf", paneId: second },
    },
  };
}

function panel(id: string, tabs: Tab[], pinnedTabIds: string[] = []): Panel {
  return { id, tabs, pinnedTabIds };
}

function onePanel(tabs: Tab[], pinnedTabIds: string[] = []): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": panel("panel-1", tabs, pinnedTabIds) },
  };
}

const CLOSED: ClosedPane[] = [
  { kind: "tab", tab: leafTab("tab-old", "pane-old"), panelId: "panel-1" },
];

function stateOf(layout: WorkspaceLayout): LayoutState {
  return { layout, closedStack: CLOSED };
}

describe("sendTab", () => {
  it("sends a whole tab, split tree and title intact, killing nothing", () => {
    const tab = splitTab("tab-1", "pane-1", "pane-2");
    const state = stateOf(onePanel([tab, leafTab("tab-2", "pane-3")]));

    const out = sendTab(state, { tabId: "tab-1" }, "tab-new")!;

    expect(out.sent).toEqual({ tab, pinned: false, focusPaneId: "pane-1" });
    expect(out.result.killPanes).toEqual([]);
    expect(out.result.closedStack).toBe(CLOSED);
    expect(out.result.layout.panels["panel-1"].tabs.map((t) => t.id)).toEqual(["tab-2"]);
  });

  it("sends one pane of a split in a new tab, leaving the rest behind", () => {
    const state = stateOf(onePanel([splitTab("tab-1", "pane-1", "pane-2")]));

    const out = sendTab(state, { paneId: "pane-2" }, "tab-new")!;

    expect(out.sent.tab).toEqual({
      id: "tab-new",
      title: "Terminal",
      rootNode: { type: "leaf", paneId: "pane-2" },
    });
    expect(out.sent.focusPaneId).toBe("pane-2");
    const left = out.result.layout.panels["panel-1"].tabs;
    expect(left.map((t) => t.id)).toEqual(["tab-1"]);
    expect(left[0].rootNode).toEqual({ type: "leaf", paneId: "pane-1" });
    expect(out.result.killPanes).toEqual([]);
  });

  it("sends a tab's only pane with its tab, pinned state and all", () => {
    const state = stateOf(
      onePanel([leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")], ["tab-1"]),
    );

    const out = sendTab(state, { paneId: "pane-1" }, "tab-new")!;

    expect(out.sent).toEqual({
      tab: leafTab("tab-1", "pane-1"),
      pinned: true,
      focusPaneId: "pane-1",
    });
    expect(out.result.layout.panels["panel-1"].pinnedTabIds).toEqual([]);
  });

  it("leaves the last panel behind, empty, when its last tab goes", () => {
    const state = stateOf(onePanel([leafTab("tab-1", "pane-1")]));

    const out = sendTab(state, { tabId: "tab-1" }, "tab-new")!;

    expect(out.result.layout.panels["panel-1"].tabs).toEqual([]);
  });

  it("is null for a pane or tab the workspace does not hold", () => {
    const state = stateOf(onePanel([leafTab("tab-1", "pane-1")]));
    expect(sendTab(state, { paneId: "pane-nope" }, "tab-new")).toBeNull();
    expect(sendTab(state, { tabId: "tab-nope" }, "tab-new")).toBeNull();
  });
});

describe("receiveTab", () => {
  const target = (): LayoutState => ({
    layout: {
      panelTree: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", panelId: "panel-a" },
        second: { type: "leaf", panelId: "panel-b" },
      },
      panels: {
        "panel-a": panel("panel-a", [leafTab("tab-a", "pane-a")]),
        "panel-b": panel(
          "panel-b",
          [leafTab("tab-p", "pane-p"), leafTab("tab-b", "pane-b")],
          ["tab-p"],
        ),
      },
    },
    closedStack: [],
  });
  const sent = {
    tab: splitTab("tab-1", "pane-1", "pane-2"),
    pinned: false,
    focusPaneId: "pane-2",
  };

  it("adds the tab at the end of the named panel and hints at the moved pane", () => {
    const out = receiveTab(target(), sent, "panel-b")!;

    expect(out.layout.panels["panel-b"].tabs.map((t) => t.id)).toEqual([
      "tab-p",
      "tab-b",
      "tab-1",
    ]);
    expect(out.layout.panels["panel-b"].tabs[2]).toBe(sent.tab);
    expect(out.hint).toEqual({
      selectTab: { panelId: "panel-b", tabId: "tab-1" },
      focusPane: { tabId: "tab-1", paneId: "pane-2" },
      activatePanel: "panel-b",
    });
    expect(out.killPanes).toEqual([]);
  });

  it("falls back to the first panel when it names none, or one the layout lacks", () => {
    expect(receiveTab(target(), sent)!.hint?.selectTab?.panelId).toBe("panel-a");
    expect(receiveTab(target(), sent, "panel-gone")!.hint?.selectTab?.panelId).toBe(
      "panel-a",
    );
  });

  it("keeps a pinned tab pinned, at the end of the pinned block", () => {
    const out = receiveTab(target(), { ...sent, pinned: true }, "panel-b")!;

    expect(out.layout.panels["panel-b"].tabs.map((t) => t.id)).toEqual([
      "tab-p",
      "tab-1",
      "tab-b",
    ]);
    expect(out.layout.panels["panel-b"].pinnedTabIds).toEqual(["tab-p", "tab-1"]);
  });

  it("refuses a tab the layout already holds", () => {
    const state = target();
    expect(
      receiveTab(state, { ...sent, tab: leafTab("tab-a", "pane-x") }, "panel-a"),
    ).toBeNull();
  });
});
