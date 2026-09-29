import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, selectCurrentLocation } from "../app-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";
import { workspaceKey } from "../../lib/workspace-key";

// window is provided by the setup file (src/store/__tests__/setup.ts)

const WS_PATH = "/test/workspace";
const PANEL_ID = "panel-1";
const TAB_ID = "tab-1";
const PANE_ID = "pane-1";

function makeLayout(): WorkspaceLayout {
  const tab: Tab = {
    id: TAB_ID,
    title: "Terminal",
    rootNode: { type: "leaf", paneId: PANE_ID },
    focusedPaneId: PANE_ID,
  };
  const panel: Panel = {
    id: PANEL_ID,
    tabs: [tab],
    selectedTabId: TAB_ID,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: PANEL_ID },
    panels: { [PANEL_ID]: panel },
    activePanelId: PANEL_ID,
  };
}

function seedOverview() {
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    workspaceLayouts: { [WS_PATH]: makeLayout() },
    paneContentType: {},
    paneUrl: {},
    pendingPaneCommands: {},
  });
  useAppStore.getState().showProjectsOverview();
}

describe("activeSurface (ADR-194)", () => {
  beforeEach(() => seedOverview());

  it("showProjectsOverview shows the overview and keeps the workspace active", () => {
    const state = useAppStore.getState();
    expect(state.activeSurface).toBe("projects");
    expect(state.activeWorkspacePath).toBe(WS_PATH);
  });

  it("selectCurrentLocation reports the projects surface", () => {
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "projects",
    });
  });

  it("setActiveWorkspace resets it to the workspace", () => {
    useAppStore.getState().setActiveWorkspace(WS_PATH);
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("setActiveWorkspace resets it for a workspace without a layout yet", () => {
    useAppStore.getState().setActiveWorkspace("/test/other");
    const state = useAppStore.getState();
    expect(state.activeSurface).toBe("workspace");
    expect(state.activeWorkspacePath).toBe("/test/other");
  });

  it("addTab resets it", () => {
    useAppStore.getState().addTab();
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("addBrowserTab resets it, unless the tab opens in the background", () => {
    useAppStore
      .getState()
      .addBrowserTab("https://example.com", { background: true });
    expect(useAppStore.getState().activeSurface).toBe("projects");

    useAppStore.getState().addBrowserTab("https://example.com");
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("navigateToContext resets it", () => {
    useAppStore.getState().navigateToContext({
      workspaceKey: workspaceKey("local", WS_PATH),
      tabId: TAB_ID,
      paneId: PANE_ID,
    });
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("splitPane resets it", () => {
    useAppStore.getState().splitPane("horizontal");
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });
});

describe("showTasksView (ADR-197)", () => {
  beforeEach(() => seedOverview());

  it("shows the tasks surface and keeps the workspace active", () => {
    useAppStore.getState().showTasksView();
    const state = useAppStore.getState();
    expect(state.activeSurface).toBe("tasks");
    expect(state.activeWorkspacePath).toBe(WS_PATH);
  });

  it("selectCurrentLocation reports the tasks surface", () => {
    useAppStore.getState().showTasksView();
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "tasks",
    });
  });
});
