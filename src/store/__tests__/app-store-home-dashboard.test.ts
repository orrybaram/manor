import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, selectCurrentLocation } from "../app-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";
import { HOME_PATH } from "../../lib/home-path";
import {
  queuedCommands,
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
} from "./fake-layout-server";

// window is provided by the setup file (src/store/__tests__/setup.ts)

const WS_PATH = "/test/workspace";

function makeLayout(prefix: string): WorkspaceLayout {
  const tab: Tab = {
    id: `${prefix}-tab`,
    title: "Terminal",
    rootNode: { type: "leaf", paneId: `${prefix}-pane` },
  };
  const panel: Panel = {
    id: `${prefix}-panel`,
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
  };
}

/**
 * Home active, with a stale layout keyed to it — the worst case: even with
 * something to act on, the central guard must keep every creation path a
 * no-op, and no command may reach the server (ADR-179 D1).
 */
function seedHome() {
  resetFakeLayoutServer();
  seedLayout(HOME_PATH, makeLayout("home"));
  seedLayout(WS_PATH, makeLayout("ws"));
  useAppStore.setState({
    activeWorkspacePath: HOME_PATH,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    workspaceLayouts: {
      [HOME_PATH]: makeLayout("home"),
      [WS_PATH]: makeLayout("ws"),
    },
    viewports: {},
    claims: {},
    paneContentType: {},
    paneUrl: {},
  });
}

describe("Home holds no tabs (ADR-197 §1)", () => {
  beforeEach(() => seedHome());

  const noOps: Array<[string, () => unknown]> = [
    ["addTab", () => useAppStore.getState().addTab()],
    ["addTerminalTab", () => useAppStore.getState().addTerminalTab("echo hi")],
    ["addBrowserTab", () => useAppStore.getState().addBrowserTab("https://example.com")],
    ["addDiffTab", () => useAppStore.getState().addDiffTab()],
    ["duplicateTab", () => useAppStore.getState().duplicateTab("home-tab")],
    ["openOrFocusDiff", () => useAppStore.getState().openOrFocusDiff()],
    ["openDiffInNewPanel", () => useAppStore.getState().openDiffInNewPanel()],
    ["splitPane", () => useAppStore.getState().splitPane("horizontal")],
    [
      "splitPaneAt",
      () => useAppStore.getState().splitPaneAt("home-pane", "horizontal", "second"),
    ],
    ["splitPanel", () => useAppStore.getState().splitPanel("horizontal")],
    ["reopenClosedPane", () => useAppStore.getState().reopenClosedPane()],
  ];

  for (const [name, run] of noOps) {
    it(`${name} sends nothing and leaves state unchanged`, () => {
      const before = useAppStore.getState();
      run();
      const after = useAppStore.getState();
      expect(sentCommands).toEqual([]);
      expect(queuedCommands).toEqual([]);
      expect(after.workspaceLayouts).toBe(before.workspaceLayouts);
      expect(after.paneContentType).toBe(before.paneContentType);
    });
  }

  it("the creators that return a tab return null", () => {
    expect(useAppStore.getState().addTab()).toBeNull();
    expect(useAppStore.getState().addTerminalTab("echo hi")).toBeNull();
    expect(useAppStore.getState().addBrowserTab("https://example.com")).toBeNull();
  });
});

describe("setActiveWorkspace(HOME_PATH)", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorkspacePath: WS_PATH,
      activeWorkspaceHostId: "local",
      activeSurface: "workspace",
      workspaceLayouts: { [WS_PATH]: makeLayout("ws") },
    });
  });

  it("makes Home active without creating a layout for it", () => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(HOME_PATH);
    expect(state.workspaceLayouts[HOME_PATH]).toBeUndefined();
    expect(state.workspaceLayouts[WS_PATH]).toBeDefined();
  });

  it("reports the home surface for navigation history", () => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "home",
    });
  });
});

/**
 * The server drops a legacy Home layout when it loads the file and ends its
 * sessions (`LayoutStore.load`, ADR-197 §2). Should one ever reach a
 * renderer anyway, Home still never adopts it.
 */
describe("a Home layout from the server is never adopted", () => {
  const OTHER = "/test/other";

  beforeEach(async () => {
    resetFakeLayoutServer();
    seedLayout(HOME_PATH, makeLayout("home"));
    seedLayout(OTHER, makeLayout("other"));
    useAppStore.setState({
      workspaceLayouts: {},
      serverLayouts: {},
      layoutVersions: {},
      viewports: {},
      claims: {},
      activeWorkspacePath: null,
      activeWorkspaceHostId: "local",
    });
    await useAppStore.getState().loadPersistedLayout();
  });

  it("does not restore a layout for Home", () => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    expect(useAppStore.getState().workspaceLayouts[HOME_PATH]).toBeUndefined();
  });

  it("still restores other workspaces", () => {
    useAppStore.getState().setActiveWorkspace(OTHER);
    expect(
      useAppStore.getState().workspaceLayouts[OTHER]?.panels["other-panel"]?.tabs,
    ).toHaveLength(1);
  });
});
