import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import type { Panel, WorkspaceLayout } from "../app-store";
import { shouldRequeuePaneCommand, windowPaneIds } from "../../lib/remote-recovery";

// window is provided by the setup file (src/store/__tests__/setup.ts).

const WS_PATH = "/test/workspace";

/** One tab holding a split of pane-1 and pane-2. */
function makeLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tab = {
    id: "tab-1",
    title: "Terminal",
    rootNode: {
      type: "split" as const,
      direction: "horizontal" as const,
      ratio: 0.5,
      first: { type: "leaf" as const, paneId: "pane-1" },
      second: { type: "leaf" as const, paneId: "pane-2" },
    },
    focusedPaneId: "pane-2",
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    selectedTabId: "tab-1",
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
    activePanelId: panelId,
  };
}

function setupStore(layout?: WorkspaceLayout) {
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout ?? makeLayout() },
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

function getActivePanel(): Panel {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[WS_PATH];
  return layout.panels[layout.activePanelId];
}

describe("addTerminalTab with submit: false (ADR-178 ticket 5 — fix in terminal)", () => {
  beforeEach(() => setupStore());

  it("creates a new tab in the active panel and queues the text unsubmitted", () => {
    const result = useAppStore
      .getState()
      .addTerminalTab("claude setup-token", { submit: false });
    expect(result).not.toBeNull();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);
    expect(panel.selectedTabId).toBe(result!.tabId);
    expect(useAppStore.getState().pendingPaneCommands[result!.paneId]).toEqual({
      text: "claude setup-token",
      submit: false,
    });
  });

  it("submits by default", () => {
    const result = useAppStore.getState().addTerminalTab("pnpm dev");
    expect(useAppStore.getState().pendingPaneCommands[result!.paneId]).toEqual({
      text: "pnpm dev",
      submit: true,
    });
  });

  it("returns null when there is no active panel context", () => {
    useAppStore.setState({ activeWorkspacePath: null });
    expect(
      useAppStore.getState().addTerminalTab("gh auth login", { submit: false }),
    ).toBeNull();
  });
});

describe("consumePendingPaneCommand", () => {
  beforeEach(() => setupStore());

  it("returns the command once, then null", () => {
    useAppStore.getState().setPendingPaneCommand("pane-1", "codex login", { submit: false });
    expect(useAppStore.getState().consumePendingPaneCommand("pane-1")).toEqual({
      text: "codex login",
      submit: false,
    });
    expect(useAppStore.getState().consumePendingPaneCommand("pane-1")).toBeNull();
  });

  it("returns null when nothing is queued", () => {
    expect(useAppStore.getState().consumePendingPaneCommand("pane-none")).toBeNull();
  });
});

// ADR-183 regressions: typed text used to live in its own queue, which
// closing a tab or pane never cleared and host-away never held back.
describe("typed text shares the pane-command queue (ADR-183)", () => {
  beforeEach(() => setupStore());

  it("is dropped when its tab closes", () => {
    const created = useAppStore
      .getState()
      .addTerminalTab("gh auth login", { submit: false })!;

    useAppStore.getState().closeTab(created.tabId);

    expect(useAppStore.getState().pendingPaneCommands).not.toHaveProperty(
      created.paneId,
    );
  });

  it("is dropped when its pane closes, and a sibling's is kept", () => {
    useAppStore.getState().setPendingPaneCommand("pane-1", "keep", { submit: false });
    useAppStore.getState().setPendingPaneCommand("pane-2", "drop", { submit: false });

    useAppStore.getState().closePane();

    expect(useAppStore.getState().pendingPaneCommands).toEqual({
      "pane-1": { text: "keep", submit: false },
    });
  });

  it("goes back on the queue, still unsubmitted, when its remote host was away", () => {
    // A mount takes the typed text, cannot write it while the host is away,
    // and requeues it on unmount — as it does any pane command.
    useAppStore.getState().setPendingPaneCommand("pane-1", "codex login", { submit: false });
    const taken = useAppStore.getState().consumePendingPaneCommand("pane-1")!;

    const app = useAppStore.getState();
    expect(
      shouldRequeuePaneCommand("pane-1", {
        remoteHostByPane: { "pane-1": "box" },
        windowPaneIds: windowPaneIds(app.workspaceLayouts),
        closedPaneIds: app.closedPaneIds,
        pendingPaneCommands: app.pendingPaneCommands,
      }),
    ).toBe(true);
    app.setPendingPaneCommand("pane-1", taken.text, { submit: taken.submit });

    expect(useAppStore.getState().consumePendingPaneCommand("pane-1")).toEqual({
      text: "codex login",
      submit: false,
    });
  });
});
