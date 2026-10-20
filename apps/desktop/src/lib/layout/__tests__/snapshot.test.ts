import { describe, expect, it } from "vitest";
import { buildLayoutSnapshot } from "../snapshot";
import { emptyViewport, reconcileViewport, type WorkspaceViewport } from "../viewport";
import type { PaneNode } from "../pane-tree";
import type { Panel, Tab, WorkspaceLayout } from "../workspace-layout";

const WS_PATH = "/test/workspace";

function leaf(
  paneId: string,
  extra?: { contentType?: "terminal" | "browser" | "diff"; url?: string },
): PaneNode {
  return { type: "leaf", paneId, ...extra };
}

function split(first: PaneNode, second: PaneNode): PaneNode {
  return { type: "split", direction: "horizontal", ratio: 0.5, first, second };
}

function tab(id: string, rootNode: PaneNode): Tab {
  return { id, title: `Tab ${id}`, rootNode };
}

function panel(id: string, tabs: Tab[]): Panel {
  return { id, tabs, pinnedTabIds: [] };
}

function singlePanel(tabs: Tab[]): WorkspaceLayout {
  const p = panel("panel-1", tabs);
  return {
    panelTree: { type: "leaf", panelId: p.id },
    panels: { [p.id]: p },
  };
}

function viewportOf(
  layout: WorkspaceLayout,
  overrides: Partial<WorkspaceViewport> = {},
): WorkspaceViewport {
  return reconcileViewport(layout, { ...emptyViewport(), ...overrides });
}

describe("buildLayoutSnapshot", () => {
  it("names exactly one active tab and one focused pane across three tabs", () => {
    const layout = singlePanel([
      tab("t1", leaf("p1")),
      tab("t2", leaf("p2")),
      tab("t3", leaf("p3")),
    ]);
    const snapshot = buildLayoutSnapshot(
      WS_PATH,
      layout,
      viewportOf(layout, { selectedTabIds: { "panel-1": "t2" } }),
    );

    expect(snapshot.activeTabId).toBe("t2");
    expect(snapshot.focusedPaneId).toBe("p2");
    expect(snapshot.tabs.map((t) => t.tabId)).toEqual(["t1", "t2", "t3"]);
  });

  it("takes focus from the active panel's selected tab, not every panel", () => {
    const left = panel("panel-1", [tab("t1", split(leaf("p1"), leaf("p2")))]);
    const right = panel("panel-2", [tab("t2", leaf("p3"))]);
    const layout: WorkspaceLayout = {
      panelTree: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "leaf", panelId: left.id },
        second: { type: "leaf", panelId: right.id },
      },
      panels: { [left.id]: left, [right.id]: right },
    };
    const snapshot = buildLayoutSnapshot(
      WS_PATH,
      layout,
      viewportOf(layout, { activePanelId: right.id }),
    );

    expect(snapshot.activeTabId).toBe("t2");
    expect(snapshot.focusedPaneId).toBe("p3");
    expect(snapshot.tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
  });

  it("lists panes depth-first, left-to-right", () => {
    const layout = singlePanel([
      tab("t1", split(leaf("p1"), split(leaf("p2"), leaf("p3")))),
    ]);
    const snapshot = buildLayoutSnapshot(WS_PATH, layout, viewportOf(layout));
    expect(snapshot.tabs[0].panes.map((p) => p.paneId)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("resolves contentType and url from the tree's own leaf fields, defaulting to terminal", () => {
    const layout = singlePanel([
      tab(
        "t1",
        split(
          leaf("p1"),
          leaf("p2", { contentType: "browser", url: "https://example.com" }),
        ),
      ),
    ]);
    const snapshot = buildLayoutSnapshot(WS_PATH, layout, viewportOf(layout));

    expect(snapshot.tabs[0].panes).toEqual([
      { paneId: "p1", contentType: "terminal" },
      { paneId: "p2", contentType: "browser", url: "https://example.com" },
    ]);
  });

  it("keeps each tab's own focusedPaneId as per-tab state", () => {
    const layout = singlePanel([tab("t1", leaf("p1")), tab("t2", leaf("p2"))]);
    const snapshot = buildLayoutSnapshot(WS_PATH, layout, viewportOf(layout));
    expect(snapshot.tabs.map((t) => t.focusedPaneId)).toEqual(["p1", "p2"]);
    expect(snapshot.focusedPaneId).toBe("p1");
  });

  it("reports null focus fields, but still a per-tab default, with no viewport", () => {
    const layout = singlePanel([tab("t1", leaf("p1")), tab("t2", leaf("p2"))]);
    const snapshot = buildLayoutSnapshot(WS_PATH, layout, null);

    expect(snapshot.activeTabId).toBeNull();
    expect(snapshot.focusedPaneId).toBeNull();
    expect(snapshot.tabs.map((t) => t.focusedPaneId)).toEqual(["p1", "p2"]);
  });
});
