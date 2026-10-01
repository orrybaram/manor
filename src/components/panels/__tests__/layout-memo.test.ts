// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { workspaceKey } from "../../../lib/workspace-key";

// Stand-ins for the children of each component under test, counting renders.
const renders = { leafPanel: 0, tabBar: 0, leafPane: 0 };
vi.mock("../LeafPanel", () => ({
  LeafPanel: () => {
    renders.leafPanel++;
    return null;
  },
}));
vi.mock("../../tabbar/TabBar/TabBar", () => ({
  TabBar: () => {
    renders.tabBar++;
    return null;
  },
}));
vi.mock("../../workspace-panes/LeafPane", () => ({
  LeafPane: () => {
    renders.leafPane++;
    return null;
  },
}));

const { PanelLayout } = await import("../PanelLayout");
const { LeafPanel } = await vi.importActual<typeof import("../LeafPanel")>("../LeafPanel");
const { PaneLayout } = await import("../../workspace-panes/PaneLayout/PaneLayout");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = workspaceKey("local", "/ws/a");
const onNewAgent = () => {};
const paneNode = { type: "leaf", paneId: "p1" } as const;

// Each case renders a component twice with equal props, as an unrelated
// parent re-render would, and expects its children not to re-render.
const panelNode = { type: "leaf", panelId: "panel-1" } as const;
const cases: [string, () => ReactElement][] = [
  ["PanelLayout", () => createElement(PanelLayout, { node: panelNode, workspaceKey: KEY, onNewAgent })],
  ["LeafPanel", () => createElement(LeafPanel, { panelId: "panel-1", workspaceKey: KEY, onNewAgent })],
  ["PaneLayout", () => createElement(PaneLayout, { node: paneNode, workspaceKey: KEY })],
];

describe("layout components are memoized", () => {
  let root: Root;

  beforeEach(() => {
    renders.leafPanel = 0;
    renders.tabBar = 0;
    renders.leafPane = 0;
    useAppStore.setState({
      workspaceLayouts: {
        [KEY]: {
          panelTree: panelNode,
          panels: {
            "panel-1": {
              id: "panel-1",
              tabs: [{ id: "t1", title: "T", rootNode: paneNode }],
              pinnedTabIds: [],
            },
          },
        },
      },
      // What this window is looking at is viewport, not layout (ADR-179 D3).
      viewports: {
        [KEY]: {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "t1" },
          focusedPaneIds: { t1: "p1" },
        },
      },
    });
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => act(() => root.unmount()));

  it.each(cases)("%s skips re-rendering for unchanged props", (_name, element) => {
    act(() => root.render(element()));
    const first = { ...renders };
    expect(first.leafPanel + first.tabBar + first.leafPane).toBeGreaterThan(0);

    act(() => root.render(element()));
    expect(renders).toEqual(first);
  });
});
