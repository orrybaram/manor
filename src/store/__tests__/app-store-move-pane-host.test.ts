/**
 * A pane that leaves this window is not this window's any more (ADR-178 §6):
 * the window must not keep its host (badge, offline banner, recovery plan).
 *
 * Under a server-owned layout a pane leaves a window two ways: it is popped
 * out — another window claims its tab (ADR-179 D4) — or it is closed, and the
 * broadcast that drops it from the tree arrives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";
import { remoteHostByPane, useRemotePaneStore } from "../remote-pane-store";
import { detachTabToNewWindow, movePaneToNewWindow } from "../../lib/detach";
import {
  broadcastLayout,
  resetFakeLayoutServer,
  seedLayout,
} from "./fake-layout-server";

const WS_PATH = "/test/workspace";

function layout(rootNode: Tab["rootNode"]): WorkspaceLayout {
  const tab: Tab = { id: "tab-1", title: "Terminal", rootNode };
  const panel: Panel = { id: "panel-1", tabs: [tab], pinnedTabIds: [] };
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": panel },
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
  resetFakeLayoutServer();
  seedLayout(WS_PATH, l);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    activeWorkspaceHostId: "local",
    workspaceLayouts: { [WS_PATH]: l },
    layoutVersions: {},
    viewports: {},
    claims: {},
    paneContentType: {},
  });
  useRemotePaneStore.setState({ panes: {} });
  useRemotePaneStore.getState().setPaneHost("pane-1", "box");
  useRemotePaneStore.getState().setPaneHost("pane-2", "box");
}

describe("a pane leaving a window", () => {
  let detachTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    detachTab = vi.fn().mockResolvedValue(undefined);
    const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...api,
        window: {
          getBounds: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 800, height: 600 }),
          detachTab,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forgets every pane of a tab popped out into a window of its own", async () => {
    setup(twoPanes);
    await detachTabToNewWindow("tab-1");
    expect(detachTab).toHaveBeenCalledWith(WS_PATH, "tab-1", expect.anything());
    expect(remoteHostByPane(useRemotePaneStore.getState())).toEqual({});
  });

  it("forgets only the pane that was popped out of a split", async () => {
    setup(twoPanes);
    await movePaneToNewWindow("pane-1");
    expect(remoteHostByPane(useRemotePaneStore.getState())).toEqual({ "pane-2": "box" });
  });

  it("forgets a pane the server closed", () => {
    setup(twoPanes);
    broadcastLayout(WS_PATH, layout({ type: "leaf", paneId: "pane-2" }));
    expect(remoteHostByPane(useRemotePaneStore.getState())).toEqual({ "pane-2": "box" });
  });
});
