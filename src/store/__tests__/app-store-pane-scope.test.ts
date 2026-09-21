/**
 * One paneId scope: `closePaneById` and `splitPaneAt` resolve a pane in *any*
 * panel, matching `focusPane`/`movePaneToTarget` and what `list_panes` reports.
 * They previously searched only the active panel and silently no-opped.
 *
 * Also covers what the mutating actions return, and the `pendingPaneCommands`
 * prune that keeps an undrained command from outliving its pane.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneId,
} from "../app-store";
import type { Panel, Tab, WorkspaceLayout } from "../app-store";
import { allPaneIds, hasPaneId } from "../../lib/layout/pane-tree";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import {
  queuedCommands,
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
} from "./fake-layout-server";

const WS_PATH = "/test/workspace";

const ACTIVE_PANEL = "panel-active";
const OTHER_PANEL = "panel-other";

function leafTab(id: string, paneId: string): Tab {
  return {
    id,
    title: "Terminal",
    rootNode: { type: "leaf", paneId },
  };
}

function splitTab(id: string, firstPane: string, secondPane: string): Tab {
  return {
    id,
    title: "Terminal",
    rootNode: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: firstPane },
      second: { type: "leaf", paneId: secondPane },
    },
  };
}

function panel(id: string, tabs: Tab[]): Panel {
  return { id, tabs, pinnedTabIds: [] };
}

/** Two panels side by side. `panel-active` is active; `panel-other` is not. */
function twoPanelLayout(activeTabs: Tab[], otherTabs: Tab[]): WorkspaceLayout {
  return {
    panelTree: {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", panelId: ACTIVE_PANEL },
      second: { type: "leaf", panelId: OTHER_PANEL },
    },
    panels: {
      [ACTIVE_PANEL]: panel(ACTIVE_PANEL, activeTabs),
      [OTHER_PANEL]: panel(OTHER_PANEL, otherTabs),
    },
  };
}

function setupStore(layout: WorkspaceLayout) {
  // The server holds the same layout the store starts from: every
  // structural action goes through it now (ADR-179 D1).
  resetFakeLayoutServer();
  const start = layout;
  seedLayout(WS_PATH, start);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: start },
    viewports: { [WS_PATH]: reconcileViewport(start, emptyViewport()) },
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

function getPanel(panelId: string): Panel {
  return useAppStore.getState().workspaceLayouts[WS_PATH].panels[panelId];
}

function tabHolding(paneId: string): { panelId: string; tab: Tab } | null {
  const layout = useAppStore.getState().workspaceLayouts[WS_PATH];
  for (const p of Object.values(layout.panels)) {
    const tab = p.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (tab) return { panelId: p.id, tab };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Part A — panes in a non-active panel
// ---------------------------------------------------------------------------

describe("splitPaneAt across panels", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout([leafTab("tab-a", "pane-a")], [leafTab("tab-b", "pane-b")]),
    );
  });

  it("splits a pane living in a non-active panel", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt("pane-b", "horizontal", "second");

    expect(newPane).toBeTruthy();
    expect(tabHolding(newPane!)?.panelId).toBe(OTHER_PANEL);

    const otherTab = getPanel(OTHER_PANEL).tabs[0];
    expect(selectFocusedPaneId(useAppStore.getState(), otherTab.id)).toBe(
      newPane,
    );
    expect(otherTab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-b" },
      second: { type: "leaf", paneId: newPane },
    });
  });

  it("leaves the active panel untouched when splitting elsewhere", () => {
    const before = getPanel(ACTIVE_PANEL);

    useAppStore.getState().splitPaneAt("pane-b", "horizontal", "second");

    expect(getPanel(ACTIVE_PANEL)).toEqual(before);
    expect(selectActivePanelId(useAppStore.getState())).toBe(ACTIVE_PANEL);
  });
});

describe("closePaneById across panels", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout(
        [leafTab("tab-a", "pane-a")],
        [splitTab("tab-b", "pane-b1", "pane-b2")],
      ),
    );
  });

  it("closes a pane living in a non-active panel", () => {
    useAppStore.getState().closePaneById("pane-b1");

    expect(tabHolding("pane-b1")).toBeNull();
    expect(tabHolding("pane-b2")?.panelId).toBe(OTHER_PANEL);
    expect(getPanel(OTHER_PANEL).tabs[0].rootNode).toEqual({
      type: "leaf",
      paneId: "pane-b2",
    });
    // Ending the session is the server's, from `effects.killPanes` — the
    // store sends the command and nothing else (ADR-179 D2).
    expect(sentCommands[sentCommands.length - 1]).toEqual({
      workspacePath: WS_PATH,
      command: { type: "close-pane", paneId: "pane-b1" },
    });
  });

  it("does not move focus to the panel it mutated", () => {
    const activeBefore = getPanel(ACTIVE_PANEL);

    useAppStore.getState().closePaneById("pane-b1");

    expect(selectActivePanelId(useAppStore.getState())).toBe(ACTIVE_PANEL);
    expect(getPanel(ACTIVE_PANEL)).toEqual(activeBefore);
  });

  it("puts the pane back where it was when reopened", () => {
    useAppStore.getState().closePaneById("pane-b1");
    expect(tabHolding("pane-b1")).toBeNull();

    // The reopen stack is the server's (ADR-179 D3), and it remembers which
    // panel the pane came from — not the one the window happens to be on.
    useAppStore.getState().reopenClosedPane();

    expect(tabHolding("pane-b1")?.panelId).toBe(OTHER_PANEL);
  });

  it("closes the tab when the pane was the last one in a non-active panel's tab", () => {
    setupStore(
      twoPanelLayout(
        [leafTab("tab-a", "pane-a")],
        [leafTab("tab-b1", "pane-b1"), leafTab("tab-b2", "pane-b2")],
      ),
    );

    useAppStore.getState().closePaneById("pane-b1");

    expect(tabHolding("pane-b1")).toBeNull();
    expect(getPanel(OTHER_PANEL).tabs.map((t) => t.id)).toEqual(["tab-b2"]);
  });

  it("no-ops on an unknown paneId", () => {
    const before = useAppStore.getState().workspaceLayouts[WS_PATH];

    useAppStore.getState().closePaneById("pane-nope");

    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Part B — actions return what they mint
// ---------------------------------------------------------------------------

describe("tab actions return their IDs", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout([leafTab("tab-a", "pane-a")], [leafTab("tab-b", "pane-b")]),
    );
  });

  it("addTab returns the tabId and paneId it created", () => {
    const created = useAppStore.getState().addTab();

    expect(created).not.toBeNull();
    const tab = getPanel(ACTIVE_PANEL).tabs.find((t) => t.id === created!.tabId);
    expect(tab).toBeDefined();
    expect(allPaneIds(tab!.rootNode)).toEqual([created!.paneId]);
  });

  it("addTab adopts a caller-supplied paneId (prewarmed PTY session)", () => {
    const created = useAppStore.getState().addTab("pane-prewarmed");

    expect(created!.paneId).toBe("pane-prewarmed");
    expect(tabHolding("pane-prewarmed")?.tab.id).toBe(created!.tabId);
  });

  it("addTerminalTab returns its IDs and queues the command on the new pane", () => {
    const created = useAppStore.getState().addTerminalTab("pnpm dev");

    expect(created).not.toBeNull();
    // Queued on the server against the pane the tab minted (ADR-179 ticket
    // 11), so whichever renderer mounts it runs the command.
    expect(queuedCommands).toContainEqual(
      expect.objectContaining({ paneId: created!.paneId, text: "pnpm dev" }),
    );
    expect(tabHolding(created!.paneId)?.tab.id).toBe(created!.tabId);
  });

  it("returns null from every creator when there is no active panel", () => {
    useAppStore.setState({ activeWorkspacePath: null });

    const state = useAppStore.getState();
    expect(state.addTab()).toBeNull();
    expect(state.addTerminalTab("pnpm dev")).toBeNull();
    expect(state.addBrowserTab("https://example.com")).toBeNull();
    expect(state.splitPaneAt("pane-a", "horizontal", "second")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part C — a pane's queued command does not outlive it
// ---------------------------------------------------------------------------

/**
 * Pruning moved with the map (ADR-179 ticket 11): a pending command lives on
 * the server, and the server drops it when the reducer says the pane left the
 * tree — see `electron/layout/__tests__/layout-store.test.ts`. There is
 * nothing left in this store to prune, which is the point: a pane closed from
 * a *different* renderer used to leave the command behind here forever.
 */
describe("a split's queued command", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout(
        [splitTab("tab-a", "pane-a1", "pane-a2")],
        [leafTab("tab-b", "pane-b")],
      ),
    );
  });

  it("is queued on the server for the pane the split minted", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt("pane-a1", "horizontal", "second", {
        contentType: "agent",
        paneCommand: "pnpm test",
      })!;

    expect(queuedCommands).toContainEqual(
      expect.objectContaining({
        paneId: newPane,
        text: "pnpm test",
        kind: "agent-startup",
      }),
    );
  });
});
