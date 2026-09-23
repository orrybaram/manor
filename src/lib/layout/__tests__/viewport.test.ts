/**
 * The viewport's two jobs (ADR-179 D3).
 *
 * `reconcileViewport` keeps a per-renderer selection pointing at a layout
 * somebody else owns; `applyHint` is how a command's implied selection reaches
 * the renderer that sent it — and only that one.
 */

import { describe, expect, it } from "vitest";
import {
  applyHint,
  emptyViewport,
  focusedPaneOf,
  reconcileViewport,
  selectedTabOf,
  type WorkspaceViewport,
} from "../viewport";
import type { PaneNode } from "../pane-tree";
import type { Visibility } from "../visible-tabs";
import type { Tab, WorkspaceLayout } from "../workspace-layout";

function leaf(paneId: string): PaneNode {
  return { type: "leaf", paneId };
}

function split(first: PaneNode, second: PaneNode): PaneNode {
  return { type: "split", direction: "horizontal", ratio: 0.5, first, second };
}

function tab(id: string, rootNode: PaneNode): Tab {
  return { id, title: id, rootNode };
}

/** One panel holding `tab-1` (one pane) and `tab-2` (two panes). */
function singlePanel(): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [
          tab("tab-1", leaf("pane-1")),
          tab("tab-2", split(leaf("pane-2"), leaf("pane-3"))),
        ],
        pinnedTabIds: [],
      },
    },
  };
}

/** `panel-1` (tab-1) beside `panel-2` (tab-9). */
function twoPanels(): WorkspaceLayout {
  return {
    panelTree: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", panelId: "panel-1" },
      second: { type: "leaf", panelId: "panel-2" },
    },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [tab("tab-1", leaf("pane-1"))],
        pinnedTabIds: [],
      },
      "panel-2": {
        id: "panel-2",
        tabs: [tab("tab-9", leaf("pane-9"))],
        pinnedTabIds: [],
      },
    },
  };
}

describe("reconcileViewport", () => {
  it("fills every gap: first panel, first tab, first pane", () => {
    const viewport = reconcileViewport(singlePanel(), emptyViewport());

    expect(viewport.activePanelId).toBe("panel-1");
    expect(viewport.selectedTabIds).toEqual({ "panel-1": "tab-1" });
    expect(viewport.focusedPaneIds).toEqual({
      "tab-1": "pane-1",
      "tab-2": "pane-2",
    });
  });

  it("keeps a selection the layout still has", () => {
    const chosen: WorkspaceViewport = {
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": "tab-2" },
      focusedPaneIds: { "tab-2": "pane-3" },
    };

    const viewport = reconcileViewport(singlePanel(), chosen);

    expect(viewport.selectedTabIds["panel-1"]).toBe("tab-2");
    expect(viewport.focusedPaneIds["tab-2"]).toBe("pane-3");
  });

  it("returns the same object when nothing needed repairing", () => {
    const layout = singlePanel();
    const once = reconcileViewport(layout, emptyViewport());

    expect(reconcileViewport(layout, once)).toBe(once);
  });

  it("drops a selected tab the layout no longer has", () => {
    const viewport = reconcileViewport(singlePanel(), {
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": "tab-gone" },
      focusedPaneIds: {},
    });

    expect(viewport.selectedTabIds["panel-1"]).toBe("tab-1");
  });

  it("drops a focused pane the tab no longer has", () => {
    const viewport = reconcileViewport(singlePanel(), {
      activePanelId: "panel-1",
      selectedTabIds: {},
      focusedPaneIds: { "tab-2": "pane-gone" },
    });

    expect(viewport.focusedPaneIds["tab-2"]).toBe("pane-2");
  });

  it("drops entries for panels and tabs that are gone entirely", () => {
    const viewport = reconcileViewport(singlePanel(), {
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": "tab-1", "panel-gone": "tab-x" },
      focusedPaneIds: { "tab-1": "pane-1", "tab-gone": "pane-x" },
    });

    expect(viewport.selectedTabIds).toEqual({ "panel-1": "tab-1" });
    expect(viewport.focusedPaneIds).toEqual({
      "tab-1": "pane-1",
      "tab-2": "pane-2",
    });
  });

  it("moves the active panel to the leftmost one when its panel closed", () => {
    const viewport = reconcileViewport(twoPanels(), {
      activePanelId: "panel-gone",
      selectedTabIds: {},
      focusedPaneIds: {},
    });

    expect(viewport.activePanelId).toBe("panel-1");
  });

  it("leaves the active panel alone when it is still there", () => {
    const viewport = reconcileViewport(twoPanels(), {
      activePanelId: "panel-2",
      selectedTabIds: {},
      focusedPaneIds: {},
    });

    expect(viewport.activePanelId).toBe("panel-2");
  });

  it("says null for a workspace with no panels at all", () => {
    const empty: WorkspaceLayout = {
      panelTree: { type: "leaf", panelId: "panel-1" },
      panels: {},
    };

    expect(reconcileViewport(empty, emptyViewport()).activePanelId).toBeNull();
  });

  it("gives an empty panel no selected tab rather than a dangling one", () => {
    const layout: WorkspaceLayout = {
      panelTree: { type: "leaf", panelId: "panel-1" },
      panels: { "panel-1": { id: "panel-1", tabs: [], pinnedTabIds: [] } },
    };

    const viewport = reconcileViewport(layout, {
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": "tab-1" },
      focusedPaneIds: {},
    });

    expect(viewport.selectedTabIds).toEqual({});
    expect(viewport.activePanelId).toBe("panel-1");
  });
});

describe("applyHint", () => {
  const layout = singlePanel();

  it("selects the hinted tab and activates its panel", () => {
    const viewport = applyHint(layout, reconcileViewport(layout, emptyViewport()), {
      selectTab: { panelId: "panel-1", tabId: "tab-2" },
    });

    expect(viewport.selectedTabIds["panel-1"]).toBe("tab-2");
    expect(viewport.activePanelId).toBe("panel-1");
  });

  it("focuses the hinted pane", () => {
    const viewport = applyHint(layout, reconcileViewport(layout, emptyViewport()), {
      focusPane: { tabId: "tab-2", paneId: "pane-3" },
    });

    expect(viewport.focusedPaneIds["tab-2"]).toBe("pane-3");
  });

  it("activates a panel without touching any selection", () => {
    const start = reconcileViewport(twoPanels(), emptyViewport());
    const viewport = applyHint(twoPanels(), start, {
      activatePanel: "panel-2",
    });

    expect(viewport.activePanelId).toBe("panel-2");
    expect(viewport.selectedTabIds).toEqual(start.selectedTabIds);
  });

  it("reconciles a hint naming a tab that is already gone", () => {
    const start = reconcileViewport(layout, emptyViewport());
    const viewport = applyHint(layout, start, {
      selectTab: { panelId: "panel-1", tabId: "tab-gone" },
    });

    expect(viewport.selectedTabIds["panel-1"]).toBe("tab-1");
  });

  it("is the identity for an empty hint", () => {
    const start = reconcileViewport(layout, emptyViewport());

    expect(applyHint(layout, start, {})).toBe(start);
  });
});

describe("reconcileViewport with claims (D4)", () => {
  /** What the primary window sees with `tabIds` held by other windows. */
  function claimed(...tabIds: string[]): Visibility {
    return {
      claims: tabIds.map((tabId) => ({ windowId: "7", tabId })),
      platform: "electron",
      ownClaim: null,
    };
  }

  /** What a detached window holding `tabId` sees. */
  function holding(tabId: string): Visibility {
    return { claims: [], platform: "electron", ownClaim: tabId };
  }

  it("does not select a tab another window has popped out", () => {
    const layout = singlePanel();
    const viewport = reconcileViewport(
      layout,
      emptyViewport(),
      claimed("tab-1"),
    );

    expect(viewport.selectedTabIds["panel-1"]).toBe("tab-2");
  });

  it("moves off a selected tab the moment it is claimed", () => {
    const layout = singlePanel();
    const before = reconcileViewport(layout, emptyViewport());
    expect(before.selectedTabIds["panel-1"]).toBe("tab-1");

    const after = reconcileViewport(layout, before, claimed("tab-1"));
    expect(after.selectedTabIds["panel-1"]).toBe("tab-2");
  });

  it("leaves a panel with nothing showing rather than showing a claim", () => {
    const layout = singlePanel();
    const viewport = reconcileViewport(
      layout,
      emptyViewport(),
      claimed("tab-1", "tab-2"),
    );

    expect(viewport.selectedTabIds["panel-1"]).toBeUndefined();
  });

  it("ignores every claim in a browser", () => {
    const viewport = reconcileViewport(singlePanel(), emptyViewport(), {
      ...claimed("tab-1"),
      platform: "web",
    });

    expect(viewport.selectedTabIds["panel-1"]).toBe("tab-1");
  });

  it("shows a claiming window its one tab, and the panel holding it", () => {
    const layout = twoPanels();
    const viewport = reconcileViewport(
      layout,
      emptyViewport(),
      holding("tab-9"),
    );

    expect(viewport.activePanelId).toBe("panel-2");
    expect(viewport.selectedTabIds["panel-2"]).toBe("tab-9");
    expect(viewport.selectedTabIds["panel-1"]).toBeUndefined();
  });

  it("selects nothing once the claimed tab has left the layout", () => {
    const viewport = reconcileViewport(
      singlePanel(),
      emptyViewport(),
      holding("tab-gone"),
    );

    expect(viewport.selectedTabIds["panel-1"]).toBeUndefined();
  });

  it("is the identity when a claim already points where it should", () => {
    const layout = singlePanel();
    const settled = reconcileViewport(layout, emptyViewport(), holding("tab-2"));

    expect(reconcileViewport(layout, settled, holding("tab-2"))).toBe(settled);
  });
});

describe("selectedTabOf / focusedPaneOf", () => {
  it("read straight out of the maps", () => {
    const viewport = reconcileViewport(singlePanel(), emptyViewport());

    expect(selectedTabOf(viewport, "panel-1")).toBe("tab-1");
    expect(focusedPaneOf(viewport, "tab-2")).toBe("pane-2");
  });

  it("answer null rather than undefined for anything unknown", () => {
    const viewport = emptyViewport();

    expect(selectedTabOf(viewport, "panel-1")).toBeNull();
    expect(selectedTabOf(undefined, "panel-1")).toBeNull();
    expect(focusedPaneOf(viewport, null)).toBeNull();
  });
});
