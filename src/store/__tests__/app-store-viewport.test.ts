/**
 * The viewport slice (ADR-179 D3).
 *
 * The tab set is the server's; the selection is this renderer's. These are
 * the four claims that makes: a viewport action writes nothing shared, it is
 * persisted per renderer, a renderer with no viewport of its own is handed
 * the host's default, and a command's selection hint lands only on the
 * renderer that sent the command.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  useAppStore,
  getPersistedActiveWorkspacePath,
  selectActivePanelId,
  selectFocusedPaneId,
  selectSelectedTabId,
} from "../app-store";
import type { Panel, Tab, WorkspaceLayout } from "../app-store";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import {
  broadcastLayout,
  reportedViewports,
  resetFakeLayoutServer,
  savedViewportFile,
  seedDefaultViewport,
  seedLayout,
  seedViewportFile,
  sentCommands,
} from "./fake-layout-server";

const WS_PATH = "/test/workspace";

function tab(id: string, paneId: string): Tab {
  return { id, title: id, rootNode: { type: "leaf", paneId } };
}

function panel(id: string, tabs: Tab[]): Panel {
  return { id, tabs, pinnedTabIds: [] };
}

function layoutOf(tabs: Tab[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": panel("panel-1", tabs) },
  };
}

const TWO_TABS = () => layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]);

function setup(layout: WorkspaceLayout = TWO_TABS()) {
  resetFakeLayoutServer();
  seedLayout(WS_PATH, layout);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout },
    viewports: { [WS_PATH]: reconcileViewport(layout, emptyViewport()) },
    layoutVersions: {},
    serverLayouts: {},
    layoutLoaded: false,
  });
}

function selectedTabId(): string | null {
  return selectSelectedTabId(useAppStore.getState(), "panel-1");
}

beforeEach(() => {
  // Fake timers throughout: the viewport save is debounced, and a pending
  // real timer would survive into the next test and swallow its save.
  vi.useFakeTimers();
  setup();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("viewport actions write nothing shared", () => {
  it("selectTab sends no command", () => {
    useAppStore.getState().selectTab("tab-2");

    expect(sentCommands).toHaveLength(0);
    expect(selectedTabId()).toBe("tab-2");
  });

  it("setFocusedPane and setActivePanel send no command either", () => {
    useAppStore.getState().focusPane("pane-2");
    useAppStore.getState().focusPanel("panel-1");

    expect(sentCommands).toHaveLength(0);
    expect(selectFocusedPaneId(useAppStore.getState(), "tab-2")).toBe("pane-2");
    expect(selectActivePanelId(useAppStore.getState())).toBe("panel-1");
  });

  it("keeps one viewport per workspace", () => {
    const other = layoutOf([tab("tab-9", "pane-9")]);
    seedLayout("/other", other);
    useAppStore.getState().selectTab("tab-2");
    broadcastLayout("/other", other);
    useAppStore.getState().setActiveWorkspace("/other");

    expect(selectSelectedTabId(useAppStore.getState(), "panel-1")).toBe(
      "tab-9",
    );
    useAppStore.getState().setActiveWorkspace(WS_PATH);
    expect(selectedTabId()).toBe("tab-2");
  });
});

describe("selection hints", () => {
  it("are applied when the origin is this renderer", () => {
    // `new-tab` implies "select it"; the fake server sends the hint back
    // tagged with this renderer's id, exactly as the real one does.
    const created = useAppStore.getState().addTab()!;

    expect(selectedTabId()).toBe(created.tabId);
  });

  it("are ignored when the origin is another renderer", () => {
    useAppStore.getState().selectTab("tab-2");

    broadcastLayout(
      WS_PATH,
      layoutOf([
        tab("tab-1", "pane-1"),
        tab("tab-2", "pane-2"),
        tab("tab-3", "pane-3"),
      ]),
      50,
      undefined,
      {
        origin: { kind: "bridge", id: "somebody-elses-phone" },
        hint: { selectTab: { panelId: "panel-1", tabId: "tab-3" } },
      },
    );

    expect(selectedTabId()).toBe("tab-2");
  });

  it("never leave the selection pointing at nothing", () => {
    useAppStore.getState().selectTab("tab-2");

    // Another renderer closed the tab this one was showing.
    broadcastLayout(WS_PATH, layoutOf([tab("tab-1", "pane-1")]), 50, undefined, {
      origin: { kind: "bridge", id: "somebody-elses-phone" },
    });

    expect(selectedTabId()).toBe("tab-1");
  });
});

describe("persistence, per renderer", () => {
  it("writes the whole viewport file after a change, debounced", async () => {
    useAppStore.getState().selectTab("tab-2");
    expect(savedViewportFile()).toBeNull();

    await vi.advanceTimersByTimeAsync(400);

    expect(savedViewportFile()).toEqual({
      version: 1,
      activeWorkspacePath: WS_PATH,
      workspaces: {
        [WS_PATH]: {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-2" },
          focusedPaneIds: { "tab-1": "pane-1", "tab-2": "pane-2" },
        },
      },
    });
  });

  it("reports the change to the host as the workspace's default", () => {
    useAppStore.getState().selectTab("tab-2");

    const last = reportedViewports[reportedViewports.length - 1];
    expect(last.workspacePath).toBe(WS_PATH);
    expect(last.rendererId).toBe("test-renderer");
    expect(last.viewport.selectedTabIds).toEqual({ "panel-1": "tab-2" });
  });

  it("boots on its own file when it has one", async () => {
    const layout = TWO_TABS();
    resetFakeLayoutServer();
    seedLayout(WS_PATH, layout);
    seedViewportFile({
      version: 1,
      activeWorkspacePath: WS_PATH,
      workspaces: {
        [WS_PATH]: {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-2" },
          focusedPaneIds: {},
        },
      },
    });
    useAppStore.setState({ viewports: {}, workspaceLayouts: {} });

    await useAppStore.getState().loadPersistedLayout();

    expect(useAppStore.getState().viewports[WS_PATH].selectedTabIds).toEqual({
      "panel-1": "tab-2",
    });
    expect(getPersistedActiveWorkspacePath()).toBe(WS_PATH);
  });

  it("boots on the host's default viewport when it has none", async () => {
    const layout = TWO_TABS();
    resetFakeLayoutServer();
    seedLayout(WS_PATH, layout);
    seedDefaultViewport(WS_PATH, {
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": "tab-2" },
      focusedPaneIds: {},
    });
    useAppStore.setState({ viewports: {}, workspaceLayouts: {} });

    await useAppStore.getState().loadPersistedLayout();

    expect(useAppStore.getState().viewports[WS_PATH].selectedTabIds).toEqual({
      "panel-1": "tab-2",
    });
  });

  it("reconciles whatever it loaded against the layout it was handed", async () => {
    resetFakeLayoutServer();
    seedLayout(WS_PATH, layoutOf([tab("tab-1", "pane-1")]));
    seedViewportFile({
      version: 1,
      activeWorkspacePath: WS_PATH,
      // A tab that was closed by another renderer while this one was shut.
      workspaces: {
        [WS_PATH]: {
          activePanelId: "panel-gone",
          selectedTabIds: { "panel-1": "tab-gone" },
          focusedPaneIds: { "tab-gone": "pane-gone" },
        },
      },
    });
    useAppStore.setState({ viewports: {}, workspaceLayouts: {} });

    await useAppStore.getState().loadPersistedLayout();

    expect(useAppStore.getState().viewports[WS_PATH]).toEqual({
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": "tab-1" },
      focusedPaneIds: { "tab-1": "pane-1" },
    });
  });
});
