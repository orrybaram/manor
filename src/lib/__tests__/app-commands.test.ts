import { describe, it, expect, beforeEach, vi } from "vitest";
import { appCommandHandlers } from "../app-commands";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import type { ProjectInfo } from "../../store/project-store";
import type { WorkspaceLayout, Tab, Panel } from "../../store/app-store";
import { hasPaneId } from "../../store/pane-tree";

const WS_PATH = "/test/workspace";
const OTHER_WS_PATH = "/test/other";

function makeLayout(tab: Tab): WorkspaceLayout {
  const panel: Panel = {
    id: "panel-1",
    tabs: [tab],
    selectedTabId: tab.id,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
    activePanelId: panel.id,
  };
}

function singlePaneTab(): Tab {
  return {
    id: "tab-1",
    title: "Terminal",
    rootNode: { type: "leaf", paneId: "pane-1" },
    focusedPaneId: "pane-1",
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
    focusedPaneId: "pane-2",
  };
}

function setupStore(layout: WorkspaceLayout, activePath: string = WS_PATH) {
  useAppStore.setState({
    activeWorkspacePath: activePath,
    workspaceLayouts: { [WS_PATH]: layout },
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    closedPaneIds: new Set(),
    closedPaneStack: [],
    pendingStartupCommands: {},
    pendingPaneCommands: {},
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

const run = (cmd: string, args: Record<string, unknown> = {}) =>
  appCommandHandlers[cmd](args);

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectIndex: 0 });
  setupStore(makeLayout(singlePaneTab()));
});

describe("list-panes", () => {
  it("returns the layout snapshot", () => {
    setupStore(makeLayout(twoPaneTab()));
    useAppStore.setState({
      paneContentType: { "pane-2": "browser" },
      paneUrl: { "pane-2": "https://example.com" },
    });

    expect(run("list-panes")).toEqual({
      workspacePath: WS_PATH,
      activeTabId: "tab-1",
      focusedPaneId: "pane-2",
      tabs: [
        {
          tabId: "tab-1",
          title: "Terminal",
          focusedPaneId: "pane-2",
          panes: [
            { paneId: "pane-1", contentType: "terminal" },
            {
              paneId: "pane-2",
              contentType: "browser",
              url: "https://example.com",
            },
          ],
        },
      ],
    });
  });

  it("throws when no workspace is active", () => {
    useAppStore.setState({ activeWorkspacePath: null });
    expect(() => run("list-panes")).toThrow(/No active workspace/);
  });
});

describe("split-pane", () => {
  it("defaults the target to the active tab's focused pane", () => {
    setupStore(makeLayout(twoPaneTab()));

    const result = run("split-pane", { direction: "vertical" }) as {
      paneId: string;
    };

    // pane-2 is focused, so the new pane is its sibling in a vertical split.
    const root = tabHolding(result.paneId)!.rootNode;
    expect(root).toMatchObject({
      type: "split",
      direction: "horizontal",
      second: {
        type: "split",
        direction: "vertical",
        first: { paneId: "pane-2" },
        second: { paneId: result.paneId },
      },
    });
  });

  it("returns a paneId that exists in the store", () => {
    const { paneId } = run("split-pane", {
      paneId: "pane-1",
      direction: "horizontal",
    }) as { paneId: string };

    expect(paneId).toMatch(/^pane-/);
    expect(tabHolding(paneId)?.focusedPaneId).toBe(paneId);
  });

  it("honours position: first", () => {
    const { paneId } = run("split-pane", {
      direction: "horizontal",
      position: "first",
    }) as { paneId: string };

    expect(tabHolding(paneId)!.rootNode).toMatchObject({
      type: "split",
      first: { paneId },
      second: { paneId: "pane-1" },
    });
  });

  it("applies contentType, url and command", () => {
    const { paneId } = run("split-pane", {
      direction: "horizontal",
      contentType: "browser",
      url: "https://example.com",
      command: "pnpm dev",
    }) as { paneId: string };

    const state = useAppStore.getState();
    expect(state.paneContentType[paneId]).toBe("browser");
    expect(state.paneUrl[paneId]).toBe("https://example.com");
    expect(state.pendingPaneCommands[paneId]).toBe("pnpm dev");
  });

  it("throws on an unknown paneId", () => {
    expect(() =>
      run("split-pane", { paneId: "pane-nope", direction: "horizontal" }),
    ).toThrow(/Unknown paneId: pane-nope/);
  });

  it("throws on an invalid direction", () => {
    expect(() => run("split-pane", { direction: "sideways" })).toThrow(
      /direction must be one of/,
    );
    expect(() => run("split-pane", {})).toThrow(/direction must be one of/);
  });

  it("throws on an invalid contentType", () => {
    expect(() =>
      run("split-pane", { direction: "horizontal", contentType: "spreadsheet" }),
    ).toThrow(/contentType must be one of/);
  });

  it("throws when there is no active workspace", () => {
    useAppStore.setState({ activeWorkspacePath: null });
    expect(() => run("split-pane", { direction: "horizontal" })).toThrow(
      /No active workspace/,
    );
  });
});

describe("new-tab", () => {
  it("creates a plain terminal tab", () => {
    const { tabId, paneId } = run("new-tab", { contentType: "terminal" }) as {
      tabId: string;
      paneId: string;
    };

    const tab = tabHolding(paneId);
    expect(tab?.id).toBe(tabId);
    expect(useAppStore.getState().pendingPaneCommands[paneId]).toBeUndefined();
  });

  it("creates a terminal tab that runs a command", () => {
    const { paneId } = run("new-tab", {
      contentType: "terminal",
      command: "pnpm dev",
    }) as { tabId: string; paneId: string };

    expect(useAppStore.getState().pendingPaneCommands[paneId]).toBe("pnpm dev");
  });

  it("sets paneUrl for a browser tab", () => {
    const { tabId, paneId } = run("new-tab", {
      contentType: "browser",
      url: "https://example.com",
    }) as { tabId: string; paneId: string };

    const state = useAppStore.getState();
    expect(state.paneUrl[paneId]).toBe("https://example.com");
    expect(state.paneContentType[paneId]).toBe("browser");
    expect(tabHolding(paneId)?.id).toBe(tabId);
  });

  it("leaves the current tab selected when background is true", () => {
    const { tabId } = run("new-tab", {
      contentType: "browser",
      url: "https://example.com",
      background: true,
    }) as { tabId: string };

    const state = useAppStore.getState();
    const panel = state.workspaceLayouts[WS_PATH].panels["panel-1"];
    expect(panel.selectedTabId).toBe("tab-1");
    expect(panel.tabs.some((t) => t.id === tabId)).toBe(true);
  });

  it("throws when a browser tab has no url", () => {
    expect(() => run("new-tab", { contentType: "browser" })).toThrow(
      /requires a url/,
    );
  });

  it("throws on an invalid contentType", () => {
    expect(() => run("new-tab", { contentType: "diff" })).toThrow(
      /contentType must be one of/,
    );
  });

  it("switches workspace before creating the tab", () => {
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

    const { paneId } = run("new-tab", {
      contentType: "terminal",
      workspacePath: OTHER_WS_PATH,
    }) as { paneId: string };

    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(OTHER_WS_PATH);
    // The pane landed in the newly-activated workspace, not the old one.
    expect(tabHolding(paneId)).toBeDefined();
    const oldLayout = state.workspaceLayouts[WS_PATH];
    expect(
      Object.values(oldLayout.panels).flatMap((p) => p.tabs),
    ).toHaveLength(1);
  });

  it("throws on an unknown workspacePath", () => {
    expect(() =>
      run("new-tab", { contentType: "terminal", workspacePath: "/nope" }),
    ).toThrow(/Unknown workspace: \/nope/);
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_PATH);
  });
});

describe("focus-pane", () => {
  it("focuses an existing pane", () => {
    setupStore(makeLayout(twoPaneTab()));

    expect(run("focus-pane", { paneId: "pane-1" })).toEqual({ ok: true });
    expect(tabHolding("pane-1")?.focusedPaneId).toBe("pane-1");
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

describe("close-pane", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...(window as unknown as { electronAPI: Record<string, unknown> })
          .electronAPI,
        tasks: { abandonForPane: vi.fn().mockResolvedValue(undefined) },
      },
    });
  });

  it("closes an existing pane", () => {
    setupStore(makeLayout(twoPaneTab()));

    expect(run("close-pane", { paneId: "pane-1" })).toEqual({ ok: true });
    expect(tabHolding("pane-1")).toBeUndefined();
    expect(tabHolding("pane-2")).toBeDefined();
  });

  it("throws on an unknown paneId", () => {
    expect(() => run("close-pane", { paneId: "pane-nope" })).toThrow(
      /Unknown paneId/,
    );
  });
});

describe("dispatch table", () => {
  it("exposes exactly the correlated commands", () => {
    expect(Object.keys(appCommandHandlers).sort()).toEqual([
      "close-pane",
      "focus-pane",
      "list-panes",
      "new-tab",
      "split-pane",
    ]);
  });

  it("does not expose the fire-and-forget legacy commands", () => {
    expect(appCommandHandlers["start-agent"]).toBeUndefined();
    expect(appCommandHandlers["run-setup-script"]).toBeUndefined();
  });
});
