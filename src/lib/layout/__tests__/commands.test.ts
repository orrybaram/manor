/**
 * The layout command reducer (ADR-179 D2). One describe per command type,
 * plus the four properties the whole design rests on: an unknown id is a
 * no-op, a close reports `killPanes`, a move reports `releasedPanes`, and the
 * reducer is deterministic and mints nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  type ClosedPane,
  type LayoutCommand,
  type LayoutState,
  MAX_CLOSED_STACK,
  applyLayoutCommand,
} from "../commands";
import { allPaneIds } from "../pane-tree";
import { allPanelIds } from "../panel-tree";
import type { Panel, Tab, WorkspaceLayout } from "../workspace-layout";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function leafTab(id: string, paneId: string, title = "Terminal"): Tab {
  return { id, title, rootNode: { type: "leaf", paneId } };
}

function splitTab(id: string, first: string, second: string): Tab {
  return {
    id,
    title: "Terminal",
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

/** One panel, one tab, one pane. */
function onePanel(
  tabs: Tab[] = [leafTab("tab-1", "pane-1")],
  pinnedTabIds: string[] = [],
): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": panel("panel-1", tabs, pinnedTabIds) },
  };
}

/** Two panels side by side; `panel-1` is active. */
function twoPanels(
  firstTabs: Tab[] = [leafTab("tab-1", "pane-1")],
  secondTabs: Tab[] = [leafTab("tab-2", "pane-2")],
): WorkspaceLayout {
  return {
    panelTree: {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", panelId: "panel-1" },
      second: { type: "leaf", panelId: "panel-2" },
    },
    panels: {
      "panel-1": panel("panel-1", firstTabs),
      "panel-2": panel("panel-2", secondTabs),
    },
  };
}

function stateOf(
  layout: WorkspaceLayout,
  closedStack: ClosedPane[] = [],
): LayoutState {
  return { layout, closedStack };
}

function panelOf(layout: WorkspaceLayout, id: string): Panel {
  const p = layout.panels[id];
  if (!p) throw new Error(`no panel ${id}`);
  return p;
}

function tabOf(layout: WorkspaceLayout, panelId: string, tabId: string): Tab {
  const tab = panelOf(layout, panelId).tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`no tab ${tabId}`);
  return tab;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

describe("new-tab", () => {
  it("appends the tab to the named panel and selects it", () => {
    const { layout } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "new-tab",
      tab: leafTab("tab-new", "pane-new"),
      panelId: "panel-2",
    });

    expect(panelOf(layout, "panel-2").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-new",
    ]);
    expect(panelOf(layout, "panel-1").tabs).toHaveLength(1);
  });

  it("hints the sender to select the tab it just opened", () => {
    const { effects } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "new-tab",
      tab: leafTab("tab-new", "pane-new"),
      panelId: "panel-2",
    });

    expect(effects.selectTab).toEqual({
      panelId: "panel-2",
      tabId: "tab-new",
    });
    expect(effects.focusPane).toEqual({
      tabId: "tab-new",
      paneId: "pane-new",
    });
  });

  it("hints nothing for a background tab", () => {
    const { effects } = applyLayoutCommand(stateOf(onePanel()), {
      type: "new-tab",
      tab: leafTab("tab-new", "pane-new"),
      panelId: "panel-1",
      select: false,
    });

    expect(effects.selectTab).toBeUndefined();
  });

  it("falls back to the active panel when none is named", () => {
    const { layout } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "new-tab",
      tab: leafTab("tab-new", "pane-new"),
    });

    expect(panelOf(layout, "panel-1").tabs).toHaveLength(2);
  });
});

describe("close-tab", () => {
  it("removes the tab and selects its neighbour", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "close-tab",
      tabId: "tab-1",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    // Viewport, so it comes back as a hint the sender applies to itself (D3).
    expect(effects.selectTab).toEqual({ panelId: "panel-1", tabId: "tab-2" });
    expect(effects.killPanes).toEqual(["pane-1"]);
  });

  it("reports every pane of a split tab as killed", () => {
    const start = onePanel([
      splitTab("tab-1", "pane-a", "pane-b"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { effects } = applyLayoutCommand(stateOf(start), {
      type: "close-tab",
      tabId: "tab-1",
    });

    expect(effects.killPanes.sort()).toEqual(["pane-a", "pane-b"]);
    expect(effects.releasedPanes).toEqual([]);
  });

  it("takes the panel with the last tab while another panel remains", () => {
    const { layout, effects } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "close-tab",
      tabId: "tab-1",
    });

    expect(layout.panels["panel-1"]).toBeUndefined();
    expect(allPanelIds(layout.panelTree)).toEqual(["panel-2"]);
    expect(effects.activatePanel).toBe("panel-2");
  });

  it("keeps the last panel of all, empty", () => {
    const { layout } = applyLayoutCommand(stateOf(onePanel()), {
      type: "close-tab",
      tabId: "tab-1",
    });

    expect(panelOf(layout, "panel-1").tabs).toEqual([]);
  });

  it("pushes an undo entry carrying the tab and the host's metadata", () => {
    const { closedStack } = applyLayoutCommand(
      stateOf(onePanel()),
      { type: "close-tab", tabId: "tab-1" },
      { "pane-1": { cwd: "/tmp", contentType: "browser" } },
    );

    expect(closedStack).toHaveLength(1);
    const entry = closedStack[0];
    expect(entry.kind).toBe("tab");
    if (entry.kind !== "tab") throw new Error("expected a tab entry");
    expect(entry.tab.id).toBe("tab-1");
    expect(entry.panelId).toBe("panel-1");
    expect(entry.paneMetadata["pane-1"]).toEqual({
      cwd: "/tmp",
      contentType: "browser",
    });
  });

  it("records where a removed panel sat, so reopen can rebuild it", () => {
    const { closedStack } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "close-tab",
      tabId: "tab-1",
    });

    const entry = closedStack[0];
    if (entry.kind !== "tab") throw new Error("expected a tab entry");
    expect(entry.panelSplitContext).toMatchObject({
      siblingId: "panel-2",
      direction: "vertical",
      position: "first",
    });
  });

  it("keeps the undo stack bounded", () => {
    const tabs = Array.from({ length: MAX_CLOSED_STACK + 3 }, (_, i) =>
      leafTab(`tab-${i}`, `pane-${i}`),
    );
    let state = stateOf(onePanel(tabs));
    for (const tab of tabs.slice(0, MAX_CLOSED_STACK + 2)) {
      state = applyLayoutCommand(state, { type: "close-tab", tabId: tab.id });
    }

    expect(state.closedStack).toHaveLength(MAX_CLOSED_STACK);
  });
});

describe("duplicate-tab", () => {
  it("adds the caller's clone beside the original and selects it", () => {
    const clone = splitTab("tab-clone", "pane-c1", "pane-c2");
    const { layout, effects } = applyLayoutCommand(stateOf(onePanel()), {
      type: "duplicate-tab",
      tabId: "tab-1",
      newTab: clone,
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "tab-clone",
    ]);
    expect(effects.selectTab).toEqual({
      panelId: "panel-1",
      tabId: "tab-clone",
    });
    expect(effects.killPanes).toEqual([]);
  });
});

describe("close-other-tabs", () => {
  it("closes every unpinned sibling and keeps the named tab", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
      leafTab("tab-3", "pane-3"),
    ]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "close-other-tabs",
      tabId: "tab-2",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(effects.killPanes.sort()).toEqual(["pane-1", "pane-3"]);
  });

  it("spares pinned tabs", () => {
    const start = onePanel(
      [
        leafTab("tab-1", "pane-1"),
        leafTab("tab-2", "pane-2"),
        leafTab("tab-3", "pane-3"),
      ],
      ["tab-3"],
    );
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "close-other-tabs",
      tabId: "tab-2",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-3",
    ]);
  });
});

describe("close-tabs-to-right", () => {
  it("closes only what comes after the named tab", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
      leafTab("tab-3", "pane-3"),
    ]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "close-tabs-to-right",
      tabId: "tab-2",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "tab-2",
    ]);
    expect(effects.killPanes).toEqual(["pane-3"]);
  });
});

describe("reorder-tabs", () => {
  it("applies a full permutation", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "reorder-tabs",
      panelId: "panel-1",
      tabIds: ["tab-2", "tab-1"],
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-1",
    ]);
  });

  it("refuses a partial order rather than dropping tabs", () => {
    const state = stateOf(
      onePanel([leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")]),
    );
    const { layout } = applyLayoutCommand(state, {
      type: "reorder-tabs",
      panelId: "panel-1",
      tabIds: ["tab-2"],
    });

    expect(layout).toBe(state.layout);
  });
});

describe("toggle-pin-tab", () => {
  it("pins a tab and moves it into the pinned block", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "toggle-pin-tab",
      tabId: "tab-2",
    });

    expect(panelOf(layout, "panel-1").pinnedTabIds).toEqual(["tab-2"]);
    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-1",
    ]);
  });

  it("unpins a pinned tab", () => {
    const start = onePanel(
      [leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")],
      ["tab-1"],
    );
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "toggle-pin-tab",
      tabId: "tab-1",
    });

    expect(panelOf(layout, "panel-1").pinnedTabIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

describe("split-pane", () => {
  it("splits the named pane and focuses the new one", () => {
    const { layout, effects } = applyLayoutCommand(stateOf(onePanel()), {
      type: "split-pane",
      paneId: "pane-1",
      direction: "horizontal",
      newPaneId: "pane-new",
    });

    const tab = tabOf(layout, "panel-1", "tab-1");
    expect(tab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-1" },
      second: { type: "leaf", paneId: "pane-new" },
    });
    expect(effects.focusPane).toEqual({
      tabId: "tab-1",
      paneId: "pane-new",
    });
  });

  it("reaches a pane in a non-active panel", () => {
    const { layout } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "split-pane",
      paneId: "pane-2",
      direction: "vertical",
      newPaneId: "pane-new",
    });

    expect(allPaneIds(tabOf(layout, "panel-2", "tab-2").rootNode)).toEqual([
      "pane-2",
      "pane-new",
    ]);
  });
});

describe("split-pane-at", () => {
  it("honours the drop position", () => {
    const { layout } = applyLayoutCommand(stateOf(onePanel()), {
      type: "split-pane-at",
      paneId: "pane-1",
      direction: "vertical",
      position: "first",
      newPaneId: "pane-new",
    });

    expect(allPaneIds(tabOf(layout, "panel-1", "tab-1").rootNode)).toEqual([
      "pane-new",
      "pane-1",
    ]);
  });

  it("writes contentType and url onto the new leaf", () => {
    const { layout } = applyLayoutCommand(stateOf(onePanel()), {
      type: "split-pane-at",
      paneId: "pane-1",
      direction: "horizontal",
      position: "second",
      newPaneId: "pane-new",
      contentType: "browser",
      url: "https://example.com",
    });

    const root = tabOf(layout, "panel-1", "tab-1").rootNode;
    if (root.type !== "split") throw new Error("expected a split");
    expect(root.second).toEqual({
      type: "leaf",
      paneId: "pane-new",
      contentType: "browser",
      url: "https://example.com",
    });
  });
});

describe("move-pane", () => {
  it("reshuffles two panes inside one tab", () => {
    const start = onePanel([splitTab("tab-1", "pane-a", "pane-b")]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "move-pane",
      sourcePaneId: "pane-a",
      targetPaneId: "pane-b",
      direction: "horizontal",
      position: "second",
    });

    expect(allPaneIds(tabOf(layout, "panel-1", "tab-1").rootNode)).toEqual([
      "pane-b",
      "pane-a",
    ]);
    expect(effects.releasedPanes).toEqual(["pane-a"]);
    expect(effects.killPanes).toEqual([]);
  });

  it("moves a pane into another panel's tab and leaves the pane alive", () => {
    const start = twoPanels(
      [splitTab("tab-1", "pane-a", "pane-b")],
      [leafTab("tab-2", "pane-2")],
    );
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "move-pane",
      sourcePaneId: "pane-a",
      targetPaneId: "pane-2",
      direction: "horizontal",
      position: "second",
    });

    expect(allPaneIds(tabOf(layout, "panel-2", "tab-2").rootNode)).toEqual([
      "pane-2",
      "pane-a",
    ]);
    expect(allPaneIds(tabOf(layout, "panel-1", "tab-1").rootNode)).toEqual([
      "pane-b",
    ]);
    expect(effects.releasedPanes).toEqual(["pane-a"]);
    expect(effects.killPanes).toEqual([]);
    expect(effects.activatePanel).toBe("panel-2");
  });

  it("seeds an emptied last panel with the sender's fallback tab", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    // Same panel, cross-tab: tab-1's only pane moves into tab-2.
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "move-pane",
      sourcePaneId: "pane-1",
      targetPaneId: "pane-2",
      direction: "horizontal",
      position: "second",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(allPaneIds(tabOf(layout, "panel-1", "tab-2").rootNode)).toEqual([
      "pane-2",
      "pane-1",
    ]);
  });
});

describe("move-tab-to-pane", () => {
  it("grafts a one-pane tab into the target tree and drops the tab", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "move-tab-to-pane",
      tabId: "tab-1",
      targetPaneId: "pane-2",
      direction: "vertical",
      position: "first",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(allPaneIds(tabOf(layout, "panel-1", "tab-2").rootNode)).toEqual([
      "pane-1",
      "pane-2",
    ]);
    expect(effects.releasedPanes).toEqual(["pane-1"]);
    expect(effects.killPanes).toEqual([]);
  });

  it("grafts a multi-pane tab as a whole subtree", () => {
    const start = onePanel([
      splitTab("tab-1", "pane-a", "pane-b"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "move-tab-to-pane",
      tabId: "tab-1",
      targetPaneId: "pane-2",
      direction: "horizontal",
      position: "second",
    });

    expect(allPaneIds(tabOf(layout, "panel-1", "tab-2").rootNode)).toEqual([
      "pane-2",
      "pane-a",
      "pane-b",
    ]);
  });
});

describe("extract-pane-to-tab", () => {
  it("pulls a pane out of its split into a tab of its own", () => {
    const start = onePanel([splitTab("tab-1", "pane-a", "pane-b")]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "extract-pane-to-tab",
      paneId: "pane-b",
      newTabId: "tab-new",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "tab-new",
    ]);
    expect(effects.selectTab).toEqual({
      panelId: "panel-1",
      tabId: "tab-new",
    });
    expect(allPaneIds(tabOf(layout, "panel-1", "tab-1").rootNode)).toEqual([
      "pane-a",
    ]);
    expect(effects.releasedPanes).toEqual(["pane-b"]);
    expect(effects.killPanes).toEqual([]);
  });

  it("moves a whole one-pane tab across panels", () => {
    const start = twoPanels(
      [leafTab("tab-1", "pane-1"), leafTab("tab-extra", "pane-extra")],
      [leafTab("tab-2", "pane-2")],
    );
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "extract-pane-to-tab",
      paneId: "pane-1",
      targetPanelId: "panel-2",
      newTabId: "tab-new",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-extra",
    ]);
    expect(panelOf(layout, "panel-2").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-1",
    ]);
  });
});

describe("close-pane", () => {
  it("collapses the split and reports the pane as killed", () => {
    const start = onePanel([splitTab("tab-1", "pane-a", "pane-b")]);
    const { layout, closedStack, effects } = applyLayoutCommand(
      stateOf(start),
      { type: "close-pane", paneId: "pane-a" },
    );

    expect(tabOf(layout, "panel-1", "tab-1").rootNode).toEqual({
      type: "leaf",
      paneId: "pane-b",
    });
    expect(effects.killPanes).toEqual(["pane-a"]);
    expect(effects.releasedPanes).toEqual([]);
    expect(closedStack[0]).toMatchObject({
      kind: "pane",
      paneId: "pane-a",
      tabId: "tab-1",
      panelId: "panel-1",
    });
  });

  it("carries the host's metadata into the undo entry", () => {
    const start = onePanel([splitTab("tab-1", "pane-a", "pane-b")]);
    const { closedStack } = applyLayoutCommand(
      stateOf(start),
      { type: "close-pane", paneId: "pane-a" },
      { "pane-a": { cwd: "/repo", title: "vim" } },
    );

    expect(closedStack[0]).toMatchObject({ cwd: "/repo", title: "vim" });
  });

  it("closes the whole tab when it was the last pane", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout, closedStack } = applyLayoutCommand(stateOf(start), {
      type: "close-pane",
      paneId: "pane-1",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(closedStack[0].kind).toBe("tab");
  });
});

describe("reopen-closed-pane", () => {
  it("does nothing with an empty stack", () => {
    const state = stateOf(onePanel());
    const next = applyLayoutCommand(state, {
      type: "reopen-closed-pane",
      newTabId: "tab-new",
    });

    expect(next.layout).toBe(state.layout);
    expect(next.closedStack).toBe(state.closedStack);
  });

  it("puts a closed tab back in its own panel and pops the stack", () => {
    const start = stateOf(
      onePanel([leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")]),
    );
    const closed = applyLayoutCommand(start, {
      type: "close-tab",
      tabId: "tab-1",
    });
    const reopened = applyLayoutCommand(closed, {
      type: "reopen-closed-pane",
      newTabId: "tab-new",
    });

    expect(panelOf(reopened.layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-1",
    ]);
    expect(reopened.closedStack).toEqual([]);
  });

  it("rebuilds the panel a closed tab took with it", () => {
    const start = stateOf(twoPanels());
    const closed = applyLayoutCommand(start, {
      type: "close-tab",
      tabId: "tab-1",
    });
    expect(closed.layout.panels["panel-1"]).toBeUndefined();

    const reopened = applyLayoutCommand(closed, {
      type: "reopen-closed-pane",
      newTabId: "tab-new",
    });

    expect(allPanelIds(reopened.layout.panelTree).sort()).toEqual([
      "panel-1",
      "panel-2",
    ]);
    expect(panelOf(reopened.layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-1",
    ]);
  });

  it("splits a closed pane back in beside the sender's anchor", () => {
    const start = stateOf(onePanel([splitTab("tab-1", "pane-a", "pane-b")]));
    const closed = applyLayoutCommand(start, {
      type: "close-pane",
      paneId: "pane-b",
    });
    const reopened = applyLayoutCommand(closed, {
      type: "reopen-closed-pane",
      newTabId: "tab-new",
      anchorPaneId: "pane-a",
    });

    const tab = tabOf(reopened.layout, "panel-1", "tab-1");
    expect(allPaneIds(tab.rootNode)).toEqual(["pane-a", "pane-b"]);
    expect(reopened.effects.focusPane).toEqual({
      tabId: "tab-1",
      paneId: "pane-b",
    });
  });

  it("gives a closed pane a new tab when its own tab is gone", () => {
    const start = stateOf(onePanel([splitTab("tab-1", "pane-a", "pane-b")]));
    const closed = applyLayoutCommand(
      start,
      { type: "close-pane", paneId: "pane-b" },
      { "pane-b": { title: "logs" } },
    );
    const withoutTab = applyLayoutCommand(closed, {
      type: "new-tab",
      tab: leafTab("tab-2", "pane-2"),
    });
    // Drop the original tab without touching the stack.
    const orphaned: LayoutState = {
      layout: {
        ...withoutTab.layout,
        panels: {
          "panel-1": {
            ...panelOf(withoutTab.layout, "panel-1"),
            tabs: [leafTab("tab-2", "pane-2")],
          },
        },
      },
      closedStack: withoutTab.closedStack,
    };

    const reopened = applyLayoutCommand(orphaned, {
      type: "reopen-closed-pane",
      newTabId: "tab-new",
    });

    const restored = tabOf(reopened.layout, "panel-1", "tab-new");
    expect(restored.title).toBe("logs");
    expect(restored.rootNode).toEqual({ type: "leaf", paneId: "pane-b" });
  });
});

describe("set-pane-content-type", () => {
  it("writes the type onto the leaf", () => {
    const { layout } = applyLayoutCommand(stateOf(onePanel()), {
      type: "set-pane-content-type",
      paneId: "pane-1",
      contentType: "browser",
      url: "https://example.com",
    });

    expect(tabOf(layout, "panel-1", "tab-1").rootNode).toEqual({
      type: "leaf",
      paneId: "pane-1",
      contentType: "browser",
      url: "https://example.com",
    });
  });

  it("clears the leaf for the implicit terminal type", () => {
    const browser = onePanel([
      {
        id: "tab-1",
        title: "Terminal",
        rootNode: {
          type: "leaf",
          paneId: "pane-1",
          contentType: "browser",
          url: "https://example.com",
        },
      },
    ]);
    const { layout } = applyLayoutCommand(stateOf(browser), {
      type: "set-pane-content-type",
      paneId: "pane-1",
      contentType: "terminal",
    });

    expect(tabOf(layout, "panel-1", "tab-1").rootNode).toEqual({
      type: "leaf",
      paneId: "pane-1",
    });
  });

  it("reaches a pane in a non-active panel", () => {
    const { layout } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "set-pane-content-type",
      paneId: "pane-2",
      contentType: "diff",
    });

    expect(tabOf(layout, "panel-2", "tab-2").rootNode).toMatchObject({
      contentType: "diff",
    });
  });
});

describe("update-split-ratio", () => {
  it("moves the divider of the split that owns the pane", () => {
    const start = onePanel([splitTab("tab-1", "pane-a", "pane-b")]);
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "update-split-ratio",
      firstPaneId: "pane-a",
      ratio: 0.7,
    });

    expect(tabOf(layout, "panel-1", "tab-1").rootNode).toMatchObject({
      ratio: 0.7,
    });
  });
});

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

describe("split-panel", () => {
  it("moves the named tab into a new panel and focuses it", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      leafTab("tab-2", "pane-2"),
    ]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "split-panel",
      panelId: "panel-1",
      direction: "horizontal",
      newPanelId: "panel-new",
      tabId: "tab-1",
    });

    expect(allPanelIds(layout.panelTree)).toEqual(["panel-1", "panel-new"]);
    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(panelOf(layout, "panel-new").tabs.map((t) => t.id)).toEqual([
      "tab-1",
    ]);
    expect(effects.activatePanel).toBe("panel-new");
  });

  it("leaves the emptied source panel with the sender's fallback tab", () => {
    const { layout } = applyLayoutCommand(stateOf(onePanel()), {
      type: "split-panel",
      panelId: "panel-1",
      direction: "horizontal",
      newPanelId: "panel-new",
      tabId: "tab-1",
      fallbackTab: leafTab("tab-fresh", "pane-fresh"),
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-fresh",
    ]);
  });
});

describe("close-panel", () => {
  it("removes the panel and kills every pane it held", () => {
    const start = twoPanels(
      [leafTab("tab-1", "pane-1")],
      [splitTab("tab-2", "pane-a", "pane-b")],
    );
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "close-panel",
      panelId: "panel-2",
    });

    expect(layout.panels["panel-2"]).toBeUndefined();
    expect(effects.killPanes.sort()).toEqual(["pane-a", "pane-b"]);
  });

  it("moves focus off a closed active panel", () => {
    const { effects } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "close-panel",
      panelId: "panel-1",
    });

    expect(effects.activatePanel).toBe("panel-2");
  });

  it("leaves an empty panel behind when it was the last one", () => {
    const { layout, effects } = applyLayoutCommand(stateOf(onePanel()), {
      type: "close-panel",
      panelId: "panel-1",
      fallbackPanelId: "panel-fresh",
    });

    expect(allPanelIds(layout.panelTree)).toEqual(["panel-fresh"]);
    expect(panelOf(layout, "panel-fresh").tabs).toEqual([]);
    expect(effects.killPanes).toEqual(["pane-1"]);
  });
});

describe("update-panel-ratio", () => {
  it("moves the divider between two panels", () => {
    const { layout } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "update-panel-ratio",
      firstPanelId: "panel-1",
      ratio: 0.25,
    });

    expect(layout.panelTree).toMatchObject({ ratio: 0.25 });
  });
});

describe("move-tab-to-panel", () => {
  it("moves the tab and keeps its panes alive", () => {
    const start = twoPanels(
      [leafTab("tab-1", "pane-1"), leafTab("tab-extra", "pane-extra")],
      [leafTab("tab-2", "pane-2")],
    );
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "move-tab-to-panel",
      tabId: "tab-1",
      targetPanelId: "panel-2",
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-extra",
    ]);
    expect(panelOf(layout, "panel-2").tabs.map((t) => t.id)).toEqual([
      "tab-2",
      "tab-1",
    ]);
    expect(effects.activatePanel).toBe("panel-2");
    expect(effects.killPanes).toEqual([]);
    expect(effects.releasedPanes).toEqual(["pane-1"]);
  });

  it("collapses a source panel it empties", () => {
    const { layout } = applyLayoutCommand(stateOf(twoPanels()), {
      type: "move-tab-to-panel",
      tabId: "tab-1",
      targetPanelId: "panel-2",
    });

    expect(layout.panels["panel-1"]).toBeUndefined();
    expect(allPanelIds(layout.panelTree)).toEqual(["panel-2"]);
  });
});

describe("split-panel-with-tab", () => {
  it("opens a new panel beside the target, holding the dragged tab", () => {
    const start = twoPanels(
      [leafTab("tab-1", "pane-1"), leafTab("tab-extra", "pane-extra")],
      [leafTab("tab-2", "pane-2")],
    );
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "split-panel-with-tab",
      tabId: "tab-1",
      targetPanelId: "panel-2",
      direction: "horizontal",
      newPanelId: "panel-new",
    });

    expect(panelOf(layout, "panel-new").tabs.map((t) => t.id)).toEqual([
      "tab-1",
    ]);
    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-extra",
    ]);
    expect(effects.activatePanel).toBe("panel-new");
    expect(effects.releasedPanes).toEqual(["pane-1"]);
  });
});

describe("merge-tab-into-tab", () => {
  it("grafts the source tab's tree into the target's, same panel", () => {
    const start = onePanel([
      leafTab("tab-1", "pane-1"),
      splitTab("tab-2", "pane-2", "pane-3"),
    ]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "merge-tab-into-tab",
      sourceTabId: "tab-2",
      targetTabId: "tab-1",
    });

    const panelAfter = panelOf(layout, "panel-1");
    expect(panelAfter.tabs.map((t) => t.id)).toEqual(["tab-1"]);
    expect(effects.selectTab).toEqual({ panelId: "panel-1", tabId: "tab-1" });
    const merged = tabOf(layout, "panel-1", "tab-1");
    expect(allPaneIds(merged.rootNode)).toEqual(["pane-1", "pane-2", "pane-3"]);
    expect(effects.focusPane).toEqual({ tabId: "tab-1", paneId: "pane-2" });
    // The panes moved; none of them died.
    expect(effects.killPanes).toEqual([]);
    expect(effects.releasedPanes).toEqual(["pane-2", "pane-3"]);
  });

  it("puts the source first when asked", () => {
    const start = onePanel([leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")]);
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "merge-tab-into-tab",
      sourceTabId: "tab-2",
      targetTabId: "tab-1",
      position: "first",
    });

    expect(allPaneIds(tabOf(layout, "panel-1", "tab-1").rootNode)).toEqual([
      "pane-2",
      "pane-1",
    ]);
  });

  it("collapses the source panel when the merge empties it", () => {
    const start = twoPanels();
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "merge-tab-into-tab",
      sourceTabId: "tab-1",
      targetTabId: "tab-2",
    });

    expect(Object.keys(layout.panels)).toEqual(["panel-2"]);
    expect(allPanelIds(layout.panelTree)).toEqual(["panel-2"]);
    expect(allPaneIds(tabOf(layout, "panel-2", "tab-2").rootNode)).toEqual([
      "pane-2",
      "pane-1",
    ]);
  });

  it("seeds the source panel with the fallback tab when it was the last one", () => {
    const start = onePanel([leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")]);
    // Both tabs live in the one panel, so emptying cannot happen here; the
    // fallback matters when the source panel is the last *and* is emptied.
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "merge-tab-into-tab",
      sourceTabId: "tab-2",
      targetTabId: "tab-1",
      fallbackTab: leafTab("tab-fresh", "pane-fresh"),
    });

    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual(["tab-1"]);
  });

  it("unpins the source tab it consumed", () => {
    const start = onePanel(
      [leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")],
      ["tab-2"],
    );
    const { layout } = applyLayoutCommand(stateOf(start), {
      type: "merge-tab-into-tab",
      sourceTabId: "tab-2",
      targetTabId: "tab-1",
    });

    expect(panelOf(layout, "panel-1").pinnedTabIds).toEqual([]);
  });

  it("merging a tab into itself is a no-op", () => {
    const state = stateOf(onePanel());
    const next = applyLayoutCommand(state, {
      type: "merge-tab-into-tab",
      sourceTabId: "tab-1",
      targetTabId: "tab-1",
    });

    expect(next.layout).toBe(state.layout);
  });
});

describe("split-panel-with-new-tab", () => {
  it("opens a new panel beside the source without moving its tabs", () => {
    const start = onePanel([leafTab("tab-1", "pane-1"), leafTab("tab-2", "pane-2")]);
    const { layout, effects } = applyLayoutCommand(stateOf(start), {
      type: "split-panel-with-new-tab",
      tab: leafTab("tab-diff", "pane-diff", "Diff"),
      direction: "horizontal",
      newPanelId: "panel-new",
      sourcePanelId: "panel-1",
    });

    // The reason this is not `new-tab` + `split-panel`: the source keeps both.
    expect(panelOf(layout, "panel-1").tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "tab-2",
    ]);
    expect(panelOf(layout, "panel-new").tabs.map((t) => t.id)).toEqual([
      "tab-diff",
    ]);
    expect(allPanelIds(layout.panelTree)).toEqual(["panel-1", "panel-new"]);
    expect(effects.killPanes).toEqual([]);
    expect(effects.releasedPanes).toEqual([]);
    expect(effects.activatePanel).toBe("panel-new");
    expect(effects.selectTab).toEqual({
      panelId: "panel-new",
      tabId: "tab-diff",
    });
  });
});

// ---------------------------------------------------------------------------
// Properties of the reducer itself
// ---------------------------------------------------------------------------

describe("an id that is not in the tree", () => {
  const unknown: LayoutCommand[] = [
    { type: "new-tab", tab: leafTab("t", "p"), panelId: "panel-nope" },
    { type: "close-tab", tabId: "tab-nope" },
    { type: "duplicate-tab", tabId: "tab-nope", newTab: leafTab("t", "p") },
    { type: "close-other-tabs", tabId: "tab-nope" },
    { type: "close-tabs-to-right", tabId: "tab-nope" },
    { type: "reorder-tabs", panelId: "panel-nope", tabIds: [] },
    { type: "toggle-pin-tab", tabId: "tab-nope" },
    {
      type: "split-pane",
      paneId: "pane-nope",
      direction: "horizontal",
      newPaneId: "pane-new",
    },
    {
      type: "split-pane-at",
      paneId: "pane-nope",
      direction: "horizontal",
      position: "second",
      newPaneId: "pane-new",
    },
    {
      type: "move-pane",
      sourcePaneId: "pane-nope",
      targetPaneId: "pane-1",
      direction: "horizontal",
      position: "second",
    },
    {
      type: "move-tab-to-pane",
      tabId: "tab-nope",
      targetPaneId: "pane-1",
      direction: "horizontal",
      position: "second",
    },
    { type: "extract-pane-to-tab", paneId: "pane-nope", newTabId: "tab-new" },
    { type: "close-pane", paneId: "pane-nope" },
    { type: "set-pane-content-type", paneId: "pane-nope", contentType: "diff" },
    {
      type: "split-panel",
      panelId: "panel-nope",
      direction: "horizontal",
      newPanelId: "panel-new",
    },
    { type: "close-panel", panelId: "panel-nope" },
    { type: "update-panel-ratio", firstPanelId: "panel-nope", ratio: 0.2 },
    { type: "move-tab-to-panel", tabId: "tab-nope", targetPanelId: "panel-1" },
    {
      type: "split-panel-with-tab",
      tabId: "tab-nope",
      targetPanelId: "panel-1",
      direction: "horizontal",
      newPanelId: "panel-new",
    },
    { type: "update-split-ratio", firstPaneId: "pane-nope", ratio: 0.2 },
    { type: "merge-tab-into-tab", sourceTabId: "tab-nope", targetTabId: "tab-1" },
    {
      type: "split-panel-with-new-tab",
      tab: leafTab("t", "p"),
      direction: "horizontal",
      newPanelId: "panel-new",
      sourcePanelId: "panel-nope",
    },
  ];

  it.each(unknown.map((c) => [c.type, c] as const))(
    "%s is a no-op, not a throw",
    (_type, command) => {
      const state = stateOf(onePanel(), []);
      const next = applyLayoutCommand(state, command);

      expect(next.layout).toBe(state.layout);
      expect(next.closedStack).toBe(state.closedStack);
      expect(next.effects).toEqual({ killPanes: [], releasedPanes: [] });
    },
  );
});

describe("purity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never mints an id of its own", () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    const commands: LayoutCommand[] = [
      { type: "new-tab", tab: leafTab("tab-new", "pane-new") },
      {
        type: "split-pane",
        paneId: "pane-new",
        direction: "horizontal",
        newPaneId: "pane-split",
      },
      { type: "extract-pane-to-tab", paneId: "pane-split", newTabId: "tab-x" },
      {
        type: "split-panel",
        panelId: "panel-1",
        direction: "horizontal",
        newPanelId: "panel-new",
      },
      { type: "close-panel", panelId: "panel-new" },
      { type: "close-tab", tabId: "tab-1" },
      { type: "reopen-closed-pane", newTabId: "tab-reopened" },
    ];

    let state = stateOf(onePanel());
    for (const command of commands) state = applyLayoutCommand(state, command);

    expect(randomUUID).not.toHaveBeenCalled();
  });

  it("leaves the input state untouched", () => {
    const state = stateOf(onePanel([splitTab("tab-1", "pane-a", "pane-b")]));
    const before = structuredClone(state);

    applyLayoutCommand(state, { type: "close-pane", paneId: "pane-a" });

    expect(state).toEqual(before);
  });

  it("is deterministic: the same input twice is deep-equal", () => {
    const command: LayoutCommand = {
      type: "split-pane-at",
      paneId: "pane-1",
      direction: "vertical",
      position: "first",
      newPaneId: "pane-new",
    };

    const first = applyLayoutCommand(stateOf(onePanel()), command);
    const second = applyLayoutCommand(stateOf(onePanel()), command);

    expect(first).toEqual(second);
  });
});
