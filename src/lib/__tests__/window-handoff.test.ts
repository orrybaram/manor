import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  countPanesInWindow,
  movePaneToNewWindow,
  movePaneToMainWindow,
  trackHandoff,
  whenHandoffsIdle,
} from "../window-handoff";
import { useAppStore } from "../../store/app-store";
import { hasPaneId } from "../../store/pane-tree";
import type { WorkspaceLayout, Tab, Panel } from "../../store/app-store";

const WS_PATH = "/test/workspace";

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
    focusedPaneId: "pane-1",
  };
}

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

const detachTab = vi.fn().mockResolvedValue("detached-1");
const reattachPane = vi.fn().mockResolvedValue(undefined);
const ptyDetach = vi.fn();

/** The tab currently holding `paneId`, if any. */
function tabHolding(paneId: string): Tab | undefined {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
  for (const panel of Object.values(layout?.panels ?? {})) {
    const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (tab) return tab;
  }
  return undefined;
}

beforeEach(() => {
  detachTab.mockClear();
  reattachPane.mockClear();
  ptyDetach.mockClear();
  vi.stubGlobal("window", {
    ...window,
    electronAPI: {
      ...window.electronAPI,
      pty: { detach: ptyDetach },
      webview: { unregister: vi.fn() },
      window: {
        detachTab,
        reattachPane,
        getBounds: vi.fn().mockResolvedValue({
          x: 100,
          y: 200,
          width: 1200,
          height: 800,
        }),
      },
    },
  });
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: makeLayout(twoPaneTab()) },
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("countPanesInWindow", () => {
  it("counts panes across every tab of every panel", () => {
    expect(countPanesInWindow()).toBe(2);
  });
});

describe("movePaneToNewWindow", () => {
  it("hands the pane to a new window and drops it from this one", async () => {
    await movePaneToNewWindow("pane-2");

    expect(detachTab).toHaveBeenCalledTimes(1);
    const [payload, spawnBounds] = detachTab.mock.calls[0];
    expect(hasPaneId(payload.tab.rootNode, "pane-2")).toBe(true);
    expect(payload.sourceWorkspacePath).toBe(WS_PATH);
    // Offset from this window's bounds so the popout doesn't land exactly on it.
    expect(spawnBounds).toMatchObject({ x: 140, y: 240 });

    // Released, not killed: the new window re-attaches to the same session.
    expect(ptyDetach).toHaveBeenCalledWith("pane-2");
    expect(tabHolding("pane-2")).toBeUndefined();
    expect(tabHolding("pane-1")).toBeDefined();
  });

  it("keeps the pane when the handoff fails", async () => {
    detachTab.mockRejectedValueOnce(new Error("no window"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await movePaneToNewWindow("pane-2");

    expect(tabHolding("pane-2")).toBeDefined();
    err.mockRestore();
  });
});

describe("movePaneToMainWindow", () => {
  it("releases the pane locally before forwarding it to the primary window", async () => {
    // The reverse order would let this window's beforeunload kill a session the
    // primary window has already adopted.
    reattachPane.mockImplementationOnce(async () => {
      expect(tabHolding("pane-2")).toBeUndefined();
    });

    await movePaneToMainWindow("pane-2");

    expect(reattachPane).toHaveBeenCalledTimes(1);
    const [payload] = reattachPane.mock.calls[0];
    expect(hasPaneId(payload.tab.rootNode, "pane-2")).toBe(true);
    expect(ptyDetach).toHaveBeenCalledWith("pane-2");
    expect(tabHolding("pane-1")).toBeDefined();
  });
});

describe("handoff tracking", () => {
  it("is idle when nothing is in flight", async () => {
    await expect(whenHandoffsIdle()).resolves.toBeUndefined();
  });

  it("stays busy until the handoff settles", async () => {
    let release!: () => void;
    const handoff = trackHandoff(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let idle = false;
    void whenHandoffsIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await handoff;
    await whenHandoffsIdle();
    expect(idle).toBe(true);
  });

  it("goes idle when a handoff rejects", async () => {
    // A popout must still be able to close after a failed handoff — otherwise a
    // rejected transfer would strand an empty window forever.
    const handoff = trackHandoff(Promise.reject(new Error("no window")));
    await expect(handoff).rejects.toThrow("no window");
    await expect(whenHandoffsIdle()).resolves.toBeUndefined();
  });

  it("waits for the last of several concurrent handoffs", async () => {
    const resolvers: Array<() => void> = [];
    const handoffs = [0, 1].map(() =>
      trackHandoff(
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      ),
    );

    let idle = false;
    void whenHandoffsIdle().then(() => {
      idle = true;
    });

    resolvers[0]();
    await handoffs[0];
    await Promise.resolve();
    expect(idle).toBe(false);

    resolvers[1]();
    await handoffs[1];
    await whenHandoffsIdle();
    expect(idle).toBe(true);
  });
});
