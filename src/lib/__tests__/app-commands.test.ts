import { describe, it, expect, beforeEach } from "vitest";
import { appCommandHandlers } from "../app-commands";
import {
  useAppStore,
  selectSelectedTabId,
} from "../../store/app-store";
import { emptyViewport, reconcileViewport } from "../layout/viewport";
import { useProjectStore } from "../../store/project-store";
import type { ProjectInfo } from "../../store/project-store";
import type { WorkspaceLayout, Tab, Panel } from "../../store/app-store";
import { hasPaneId } from "../../lib/layout/pane-tree";
import {
  resetFakeLayoutServer,
  seedLayout,
} from "../../store/__tests__/fake-layout-server";

const WS_PATH = "/test/workspace";
const OTHER_WS_PATH = "/test/other";

function makeLayout(tab: Tab): WorkspaceLayout {
  const panel: Panel = {
    id: "panel-1",
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
  };
}

function singlePaneTab(): Tab {
  return {
    id: "tab-1",
    title: "Terminal",
    rootNode: { type: "leaf", paneId: "pane-1" },
  };
}

function tabWithId(id: string, paneId: string): Tab {
  return {
    id,
    title: "Terminal",
    rootNode: { type: "leaf", paneId },
  };
}

/** A single-panel layout with an arbitrary number of tabs, for tab commands. */
function makeLayoutWithTabs(tabs: Tab[]): WorkspaceLayout {
  const panel: Panel = {
    id: "panel-1",
    tabs,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
  };
}

function twoPaneTab(): Tab {
  return {
    id: "tab-1",
    title: "Terminal",
    rootNode: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-1" },
      second: { type: "leaf", paneId: "pane-2" },
    },
  };
}

function setupStore(layout: WorkspaceLayout, activePath: string = WS_PATH) {
  // These handlers are viewport-only now (ADR-179 D5) and never send a
  // `LayoutCommand`, but `setupStore` still seeds the fake server so a test
  // that reads `workspaceLayouts` sees the same layout either way.
  resetFakeLayoutServer();
  seedLayout(WS_PATH, layout);
  useAppStore.setState({
    activeWorkspacePath: activePath,
    workspaceLayouts: { [WS_PATH]: layout },
    viewports: { [WS_PATH]: reconcileViewport(layout, emptyViewport()) },
    layoutVersions: {},
    serverLayouts: {},
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
  });
}

/** The tab currently holding `paneId`, across every panel of the active workspace. */
function tabHolding(paneId: string): Tab | undefined {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
  for (const panel of Object.values(layout?.panels ?? {})) {
    const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (tab) return tab;
  }
  return undefined;
}

/** This renderer's focused pane for the tab holding `paneId` (ADR-179 D3). */
function focusOfTabHolding(paneId: string): string | null {
  const tab = tabHolding(paneId);
  return tab
    ? useAppStore.getState().viewports[WS_PATH]?.focusedPaneIds[tab.id] ?? null
    : null;
}

/** This renderer's selected tab in a panel of the active workspace. */
function selectedTabId(panelId = "panel-1"): string | null {
  return selectSelectedTabId(useAppStore.getState(), panelId);
}

const run = (cmd: string, args: Record<string, unknown> = {}) =>
  appCommandHandlers[cmd](args);

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectIndex: 0 });
  setupStore(makeLayout(singlePaneTab()));
});

describe("focus-pane", () => {
  it("focuses an existing pane", () => {
    setupStore(makeLayout(twoPaneTab()));

    expect(run("focus-pane", { paneId: "pane-1" })).toEqual({ ok: true });
    expect(focusOfTabHolding("pane-1")).toBe("pane-1");
  });

  it("throws on an unknown paneId", () => {
    expect(() => run("focus-pane", { paneId: "pane-nope" })).toThrow(
      /Unknown paneId/,
    );
  });

  it("throws when paneId is missing", () => {
    expect(() => run("focus-pane", {})).toThrow(/Missing required string/);
  });
});

describe("select-tab", () => {
  it("selects an existing tab in the active panel", () => {
    setupStore(
      makeLayoutWithTabs([
        tabWithId("tab-1", "pane-1"),
        tabWithId("tab-2", "pane-2"),
      ]),
    );

    expect(run("select-tab", { tabId: "tab-2" })).toEqual({ tabId: "tab-2" });
    expect(selectedTabId()).toBe("tab-2");
  });

  it("throws on an unknown tabId", () => {
    setupStore(makeLayoutWithTabs([tabWithId("tab-1", "pane-1")]));

    expect(() => run("select-tab", { tabId: "tab-nope" })).toThrow(
      /Unknown tabId: tab-nope/,
    );
  });

  it("throws when tabId is missing", () => {
    expect(() => run("select-tab", {})).toThrow(/Missing required string/);
  });
});

describe("next-tab / prev-tab", () => {
  it("selects the next tab, wrapping around", () => {
    setupStore(
      makeLayoutWithTabs([
        tabWithId("tab-1", "pane-1"),
        tabWithId("tab-2", "pane-2"),
      ]),
    );
    // The selection is this renderer's, so it is set the way a user would
    // set it rather than baked into the layout (ADR-179 D3).
    useAppStore.getState().selectTab("tab-2");

    expect(run("next-tab")).toEqual({ tabId: "tab-1" });
  });

  it("selects the previous tab", () => {
    setupStore(
      makeLayoutWithTabs([
        tabWithId("tab-1", "pane-1"),
        tabWithId("tab-2", "pane-2"),
      ]),
    );
    useAppStore.getState().selectTab("tab-2");

    expect(run("prev-tab")).toEqual({ tabId: "tab-1" });
  });

  it("throws when there is no active workspace", () => {
    useAppStore.setState({ activeWorkspacePath: null });
    expect(() => run("next-tab")).toThrow(/No active workspace/);
    expect(() => run("prev-tab")).toThrow(/No active workspace/);
  });
});

describe("focus-next-pane / focus-prev-pane", () => {
  it("cycles focus forward and back through the panes in the active tab", () => {
    setupStore(makeLayout(twoPaneTab()));
    useAppStore.getState().focusPane("pane-2");

    expect(run("focus-next-pane")).toEqual({ paneId: "pane-1" });
    expect(run("focus-prev-pane")).toEqual({ paneId: "pane-2" });
  });
});

describe("set-active-workspace", () => {
  it("switches to a known workspace", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "manor",
          path: "/repo",
          workspaces: [{ path: OTHER_WS_PATH }],
        },
      ] as unknown as ProjectInfo[],
      selectedProjectIndex: 0,
    });

    expect(
      run("set-active-workspace", { workspacePath: OTHER_WS_PATH }),
    ).toEqual({ workspacePath: OTHER_WS_PATH });
    expect(useAppStore.getState().activeWorkspacePath).toBe(OTHER_WS_PATH);
  });

  it("throws on an unknown workspace", () => {
    expect(() =>
      run("set-active-workspace", { workspacePath: "/nope" }),
    ).toThrow(/Unknown workspace: \/nope/);
  });
});

describe("dispatch table", () => {
  /**
   * Viewport and nothing else (ADR-179 D5). `start-agent` was the last
   * non-viewport entry and left for `electron/routes/agents.ts` in ticket 11,
   * once the launch line it had to seed had a server-side home — see
   * `agents-launch.test.ts` for what it does there.
   */
  it("exposes exactly the viewport commands (ADR-179 D5)", () => {
    expect(Object.keys(appCommandHandlers).sort()).toEqual([
      "focus-next-pane",
      "focus-pane",
      "focus-prev-pane",
      "next-tab",
      "prev-tab",
      "select-tab",
      "set-active-workspace",
    ]);
  });

  it("does not expose the fire-and-forget legacy command", () => {
    expect(appCommandHandlers["run-setup-script"]).toBeUndefined();
  });
});
