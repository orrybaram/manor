import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneId,
  selectSelectedTabId,
} from "../app-store";
import type { AppState, WorkspaceLayout, Tab, Panel } from "../app-store";

// window is provided by the setup file (src/store/__tests__/setup.ts)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function seedStore(overrides?: Partial<AppState>) {
  useAppStore.setState({
    activeWorkspacePath: null,
    workspaceLayouts: { [WS_PATH]: makeLayout() },
    viewports: {},
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    paneFavicon: {},
    paneAudioPlaying: {},
    paneAudioMuted: {},
    pendingStartupCommands: {},
    pendingPaneCommands: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("navigateToContext", () => {
  beforeEach(() => seedStore());

  it("sets all four selections in one call", () => {
    useAppStore.getState().navigateToContext({
      workspacePath: WS_PATH,
      tabId: TAB_ID,
      paneId: PANE_ID,
    });

    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(WS_PATH);

    // All three are viewport now — this renderer's alone (ADR-179 D3).
    expect(selectActivePanelId(state)).toBe(PANEL_ID);
    expect(selectSelectedTabId(state, PANEL_ID)).toBe(TAB_ID);
    expect(selectFocusedPaneId(state, TAB_ID)).toBe(PANE_ID);
  });

  it("triggers the store subscriber exactly once", () => {
    const spy = vi.fn();
    const unsub = useAppStore.subscribe(spy);
    try {
      useAppStore.getState().navigateToContext({
        workspacePath: WS_PATH,
        tabId: TAB_ID,
        paneId: PANE_ID,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("does not change state when tabId does not exist in any panel", () => {
    const before = useAppStore.getState();

    useAppStore.getState().navigateToContext({
      workspacePath: WS_PATH,
      tabId: "nonexistent-tab",
      paneId: PANE_ID,
    });

    const after = useAppStore.getState();
    // State reference must be unchanged (Zustand returns same state on bail)
    expect(after.activeWorkspacePath).toBe(before.activeWorkspacePath);
    expect(after.workspaceLayouts).toBe(before.workspaceLayouts);
  });

  it("does not change state when workspacePath has no layout", () => {
    const before = useAppStore.getState();

    useAppStore.getState().navigateToContext({
      workspacePath: "/no/such/workspace",
      tabId: TAB_ID,
      paneId: PANE_ID,
    });

    const after = useAppStore.getState();
    expect(after.activeWorkspacePath).toBe(before.activeWorkspacePath);
    expect(after.workspaceLayouts).toBe(before.workspaceLayouts);
  });
});
