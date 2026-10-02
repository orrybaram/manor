import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, selectCurrentLocation } from "../app-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";
import { workspaceKey } from "../../lib/workspace-key";
import { resetFakeLayoutServer, seedLayout } from "./fake-layout-server";

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
  };
  const panel: Panel = {
    id: PANEL_ID,
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: PANEL_ID },
    panels: { [PANEL_ID]: panel },
  };
}

function seedTasksView() {
  const layout = makeLayout();
  resetFakeLayoutServer();
  seedLayout(WS_PATH, layout);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    workspaceLayouts: { [WS_PATH]: layout },
    viewports: {},
    claims: {},
  });
  useAppStore.getState().showTasksView();
}

describe("activeSurface (ADR-194)", () => {
  beforeEach(() => seedTasksView());

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
    expect(useAppStore.getState().activeSurface).toBe("tasks");

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

describe("showTasksView (ADR-198)", () => {
  beforeEach(() => seedTasksView());

  it("shows the tasks surface and keeps the workspace active", () => {
    const state = useAppStore.getState();
    expect(state.activeSurface).toBe("tasks");
    expect(state.activeWorkspacePath).toBe(WS_PATH);
  });

  it("selectCurrentLocation reports the tasks surface", () => {
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "tasks",
    });
  });
});

describe("showTasksView intent (ADR-208 §5)", () => {
  beforeEach(() => {
    seedTasksView();
    useAppStore.setState({ tasksIntent: null });
  });

  it("stores no intent when called bare", () => {
    useAppStore.getState().showTasksView();
    expect(useAppStore.getState().tasksIntent).toBeNull();
    expect(useAppStore.getState().consumeTasksIntent()).toBeNull();
  });

  it("stores the intent and shows the tasks surface", () => {
    useAppStore.setState({ activeSurface: "workspace" });
    useAppStore.getState().showTasksView({ search: "login", project: "p1" });
    const state = useAppStore.getState();
    expect(state.activeSurface).toBe("tasks");
    expect(state.tasksIntent).toEqual({ search: "login", project: "p1" });
  });

  it("replaces a pending intent while the view is already shown", () => {
    useAppStore.getState().showTasksView({ search: "a" });
    useAppStore.getState().showTasksView({ search: "b", project: null });
    expect(useAppStore.getState().tasksIntent).toEqual({
      search: "b",
      project: null,
    });
  });

  it("consumeTasksIntent returns the intent once, then clears it", () => {
    useAppStore.getState().showTasksView({ search: "login" });
    expect(useAppStore.getState().consumeTasksIntent()).toEqual({
      search: "login",
    });
    expect(useAppStore.getState().tasksIntent).toBeNull();
    expect(useAppStore.getState().consumeTasksIntent()).toBeNull();
  });

  it("is not part of the navigation location", () => {
    useAppStore.getState().showTasksView({ search: "login" });
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "tasks",
    });
  });
});
