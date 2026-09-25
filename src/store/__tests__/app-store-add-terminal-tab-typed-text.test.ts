import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import type { Panel, WorkspaceLayout } from "../app-store";

// window is provided by the setup file (src/store/__tests__/setup.ts).

const WS_PATH = "/test/workspace";

function makeLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const paneId = "pane-1";
  const tab = {
    id: "tab-1",
    title: "Terminal",
    rootNode: { type: "leaf" as const, paneId },
    focusedPaneId: paneId,
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
    pendingTypedTexts: {},
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

describe("addTerminalTabWithTypedText (ADR-178 ticket 5 — fix in terminal)", () => {
  beforeEach(() => setupStore());

  it("creates a new tab in the active panel and stages the text for its pane", () => {
    const panelBefore = getActivePanel();
    expect(panelBefore.tabs).toHaveLength(1);

    const result = useAppStore.getState().addTerminalTabWithTypedText("claude setup-token");
    expect(result).not.toBeNull();

    const panelAfter = getActivePanel();
    expect(panelAfter.tabs).toHaveLength(2);
    expect(panelAfter.selectedTabId).toBe(result!.tabId);

    expect(useAppStore.getState().pendingTypedTexts[result!.paneId]).toBe(
      "claude setup-token",
    );
    // Never staged as a command that would be submitted with \r.
    expect(useAppStore.getState().pendingPaneCommands[result!.paneId]).toBeUndefined();
  });

  it("returns null when there is no active panel context", () => {
    useAppStore.setState({ activeWorkspacePath: null });
    const result = useAppStore.getState().addTerminalTabWithTypedText("gh auth login");
    expect(result).toBeNull();
  });
});

describe("consumePendingTypedText", () => {
  beforeEach(() => setupStore());

  it("returns the text once, then null", () => {
    useAppStore.getState().setPendingTypedText("pane-1", "codex login");
    expect(useAppStore.getState().consumePendingTypedText("pane-1")).toBe(
      "codex login",
    );
    expect(useAppStore.getState().consumePendingTypedText("pane-1")).toBeNull();
  });

  it("returns null when nothing is staged", () => {
    expect(useAppStore.getState().consumePendingTypedText("pane-none")).toBeNull();
  });
});
