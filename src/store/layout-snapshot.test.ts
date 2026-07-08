import { describe, it, expect } from "vitest";
import { layoutSnapshot } from "./layout-snapshot";
import type { AppState, Panel, Tab, WorkspaceLayout } from "./app-store";

const WS_PATH = "/test/workspace";

function tab(id: string, paneIds: string[]): Tab {
  const [first, ...rest] = paneIds;
  return {
    id,
    title: `Tab ${id}`,
    rootNode: rest.reduce<Tab["rootNode"]>(
      (acc, paneId) => ({
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: acc,
        second: { type: "leaf", paneId },
      }),
      { type: "leaf", paneId: first },
    ),
    focusedPaneId: first,
  };
}

function panel(id: string, tabs: Tab[], selectedTabId = tabs[0].id): Panel {
  return { id, tabs, selectedTabId, pinnedTabIds: [] };
}

function state(
  layout: WorkspaceLayout,
  overrides: Partial<AppState> = {},
): AppState {
  return {
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout },
    paneContentType: {},
    paneUrl: {},
    ...overrides,
  } as AppState;
}

function singlePanel(tabs: Tab[], selectedTabId?: string): WorkspaceLayout {
  const p = panel("panel-1", tabs, selectedTabId);
  return {
    panelTree: { type: "leaf", panelId: p.id },
    panels: { [p.id]: p },
    activePanelId: p.id,
  };
}

describe("layoutSnapshot", () => {
  it("returns null when no workspace is active", () => {
    expect(layoutSnapshot(state(singlePanel([tab("t1", ["p1"])]), {
      activeWorkspacePath: null,
    }))).toBeNull();
  });

  it("returns null when the active workspace has no layout", () => {
    expect(
      layoutSnapshot(state(singlePanel([tab("t1", ["p1"])]), {
        workspaceLayouts: {},
      })),
    ).toBeNull();
  });

  // The bug this ADR fixes: three tabs in one panel used to emit three
  // `focused: true` panes and three `active: true` tabs.
  it("names exactly one active tab and one focused pane across three tabs", () => {
    const snapshot = layoutSnapshot(
      state(
        singlePanel(
          [tab("t1", ["p1"]), tab("t2", ["p2"]), tab("t3", ["p3"])],
          "t2",
        ),
      ),
    );

    expect(snapshot?.activeTabId).toBe("t2");
    expect(snapshot?.focusedPaneId).toBe("p2");
    expect(snapshot?.tabs.map((t) => t.tabId)).toEqual(["t1", "t2", "t3"]);
  });

  it("takes focus from the active panel's selected tab, not every panel", () => {
    const left = panel("panel-1", [tab("t1", ["p1", "p2"])]);
    const right = panel("panel-2", [tab("t2", ["p3"])]);
    const snapshot = layoutSnapshot(
      state({
        panelTree: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", panelId: left.id },
          second: { type: "leaf", panelId: right.id },
        },
        panels: { [left.id]: left, [right.id]: right },
        activePanelId: right.id,
      }),
    );

    expect(snapshot?.activeTabId).toBe("t2");
    expect(snapshot?.focusedPaneId).toBe("p3");
    // Tabs from every panel are still listed.
    expect(snapshot?.tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
  });

  it("lists panes depth-first, left-to-right", () => {
    const snapshot = layoutSnapshot(
      state(singlePanel([tab("t1", ["p1", "p2", "p3"])])),
    );
    expect(snapshot?.tabs[0].panes.map((p) => p.paneId)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("resolves contentType and url from the store maps, defaulting to terminal", () => {
    const snapshot = layoutSnapshot(
      state(singlePanel([tab("t1", ["p1", "p2"])]), {
        paneContentType: { p2: "browser" },
        paneUrl: { p1: "stale-should-be-ignored", p2: "https://example.com" },
      }),
    );

    expect(snapshot?.tabs[0].panes).toEqual([
      { paneId: "p1", contentType: "terminal" },
      { paneId: "p2", contentType: "browser", url: "https://example.com" },
    ]);
  });

  it("keeps each tab's own focusedPaneId as per-tab state", () => {
    const snapshot = layoutSnapshot(
      state(singlePanel([tab("t1", ["p1"]), tab("t2", ["p2"])], "t1")),
    );
    expect(snapshot?.tabs.map((t) => t.focusedPaneId)).toEqual(["p1", "p2"]);
    expect(snapshot?.focusedPaneId).toBe("p1");
  });
});
