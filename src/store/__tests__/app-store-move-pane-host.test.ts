/**
 * A pane moved to another window is that window's now (ADR-178 §6): the
 * window it left must not keep its host (badge, offline banner, recovery
 * plan) or a command queued for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";
import { usePaneHostStore } from "../pane-host-store";

const WS_PATH = "/test/workspace";

function layout(rootNode: Tab["rootNode"]): WorkspaceLayout {
  const tab: Tab = { id: "tab-1", title: "Terminal", rootNode, focusedPaneId: "pane-1" };
  const panel: Panel = { id: "panel-1", tabs: [tab], selectedTabId: "tab-1", pinnedTabIds: [] };
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": panel },
    activePanelId: "panel-1",
  };
}

const twoPanes = layout({
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  first: { type: "leaf", paneId: "pane-1" },
  second: { type: "leaf", paneId: "pane-2" },
});

function setup(l: WorkspaceLayout) {
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: l },
    paneContentType: {},
    pendingPaneCommands: { "pane-1": "claude --resume s", "pane-2": "keep" },
    pendingTypedTexts: { "pane-1": "fix" },
  });
  usePaneHostStore.setState({ remoteHostByPane: { "pane-1": "box", "pane-2": "box" } });
}

describe("moving a pane out of a window", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI,
        pty: { detach: vi.fn() },
        webview: { unregister: vi.fn() },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removeDetachedPaneLocally forgets the pane's host and queued input, even from a split", () => {
    setup(twoPanes);
    useAppStore.getState().removeDetachedPaneLocally("pane-1");
    expect(usePaneHostStore.getState().remoteHostByPane).toEqual({ "pane-2": "box" });
    expect(useAppStore.getState().pendingPaneCommands).toEqual({ "pane-2": "keep" });
    expect(useAppStore.getState().pendingTypedTexts).toEqual({});
  });

  it("removeDetachedPaneLocally does the same for a tab's sole pane", () => {
    setup(layout({ type: "leaf", paneId: "pane-1" }));
    useAppStore.getState().removeDetachedPaneLocally("pane-1");
    expect(usePaneHostStore.getState().remoteHostByPane).toEqual({ "pane-2": "box" });
    expect(useAppStore.getState().pendingPaneCommands).toEqual({ "pane-2": "keep" });
    expect(useAppStore.getState().pendingTypedTexts).toEqual({});
  });

  it("removeDetachedTabLocally forgets every pane of the tab", () => {
    setup(twoPanes);
    useAppStore.getState().removeDetachedTabLocally("tab-1");
    expect(usePaneHostStore.getState().remoteHostByPane).toEqual({});
    expect(useAppStore.getState().pendingPaneCommands).toEqual({});
    expect(useAppStore.getState().pendingTypedTexts).toEqual({});
  });
});
