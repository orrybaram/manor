/**
 * A bridge resync re-reads every workspace and lets the version guard decide
 * (ADR-220 D2): newer local state is kept, older local state is replaced, and
 * this window's own viewport survives either way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { Tab, WorkspaceLayout } from "../app-store";
import { emitBridgeResync } from "../../bridge/resync";
import { resetFakeLayoutServer, settled } from "./fake-layout-server";

const WS_PATH = "/test/workspace";

function layoutOf(tabId: string, paneId: string): WorkspaceLayout {
  const tab: Tab = { id: tabId, title: "Terminal", rootNode: { type: "leaf", paneId } };
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": { id: "panel-1", tabs: [tab], pinnedTabIds: [] } },
  };
}

function serverEntry(version: number, layout: WorkspaceLayout) {
  return { version, layout, defaultViewport: {}, paneSessions: {}, claims: [] };
}

function answerWith(entries: Record<string, ReturnType<typeof serverEntry>>) {
  return vi
    .spyOn(window.electronAPI.layout, "getAll")
    .mockResolvedValue(entries as never);
}

describe("layout resync", () => {
  const held = layoutOf("t-held", "p-held");
  const incoming = layoutOf("t-new", "p-new");

  beforeEach(() => {
    resetFakeLayoutServer();
    useAppStore.setState({
      workspaceLayouts: { [WS_PATH]: held },
      layoutVersions: { [WS_PATH]: 5 },
      viewports: {},
      mountedWorkspaces: {},
      claims: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not overwrite a newer local layout with an older one", async () => {
    answerWith({ [WS_PATH]: serverEntry(4, incoming) });
    emitBridgeResync();
    await settled();
    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBe(held);
    expect(state.layoutVersions[WS_PATH]).toBe(5);
  });

  it("replaces an older local layout with the server's newer one", async () => {
    answerWith({ [WS_PATH]: serverEntry(6, incoming) });
    emitBridgeResync();
    await settled();
    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBe(incoming);
    expect(state.layoutVersions[WS_PATH]).toBe(6);
  });

  it("does not run the boot load", async () => {
    answerWith({ [WS_PATH]: serverEntry(6, incoming) });
    useAppStore.setState({ layoutLoaded: false });
    emitBridgeResync();
    await settled();
    expect(useAppStore.getState().layoutLoaded).toBe(false);
  });
});
