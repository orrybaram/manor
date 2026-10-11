/**
 * A bridge resync re-reads every workspace and merges it the way the boot
 * read does (ADR-220 D2, ADR-221 ticket 7): newer local state is kept, older
 * local state is replaced, a workspace the server dropped goes, and this
 * window's own viewport survives either way.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { resyncLayout, useAppStore } from "../app-store";
import type { Tab, WorkspaceLayout } from "../app-store";
import { emitBridgeResync, onBridgeResync } from "../../bridge/resync";
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

  // `App.tsx` registers this on mount; no App here.
  let unsubscribe: () => void = () => {};
  beforeAll(() => {
    unsubscribe = onBridgeResync(resyncLayout);
  });
  afterAll(() => unsubscribe());

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

  it("drops a workspace the server no longer lists", async () => {
    answerWith({});
    emitBridgeResync();
    await settled();
    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBeUndefined();
    expect(state.layoutVersions[WS_PATH]).toBeUndefined();
  });

  it("applies pane status from the server's paneSessions", async () => {
    answerWith({
      [WS_PATH]: {
        ...serverEntry(6, incoming),
        paneSessions: {
          "p-new": { lastCwd: "/tmp/x", lastTitle: "vim" },
        },
      },
    } as never);
    emitBridgeResync();
    await settled();
    const state = useAppStore.getState();
    expect(state.paneCwd["p-new"]).toBe("/tmp/x");
    expect(state.paneTitle["p-new"]).toBe("vim");
  });

  it("leaves agent status to getPaneStatuses, not the file", async () => {
    // `pane-status-resync.test.ts` covers the read that does decide it.
    useAppStore.setState({
      paneAgentStatus: { "p-live": { status: "working", kind: "claude" } },
    } as never);
    answerWith({
      [WS_PATH]: {
        ...serverEntry(6, incoming),
        paneSessions: {
          "p-new": { lastAgentStatus: { status: "idle", kind: "claude" } },
          "p-live": { lastAgentStatus: { status: "idle", kind: "claude" } },
        },
      },
    } as never);
    emitBridgeResync();
    await settled();
    const { paneAgentStatus } = useAppStore.getState();
    expect(paneAgentStatus["p-new"]).toBeUndefined();
    expect(paneAgentStatus["p-live"]?.status).toBe("working");
  });

  it("drops a removed workspace's mount, viewport and pane side maps", async () => {
    useAppStore.setState({
      mountedWorkspaces: { [WS_PATH]: true },
      viewports: {
        [WS_PATH]: {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "t-held" },
          focusedPaneIds: {},
        },
      },
      paneCwd: { "p-held": "/tmp/held" },
    });
    answerWith({});
    emitBridgeResync();
    await settled();
    const state = useAppStore.getState();
    expect(state.mountedWorkspaces[WS_PATH]).toBeUndefined();
    expect(state.viewports[WS_PATH]).toBeUndefined();
    expect(state.paneCwd["p-held"]).toBeUndefined();
  });

  it("repairs this window's viewport instead of taking the server's default", async () => {
    const twoTabs: WorkspaceLayout = {
      panelTree: { type: "leaf", panelId: "panel-1" },
      panels: {
        "panel-1": {
          id: "panel-1",
          tabs: [
            { id: "t-a", title: "A", rootNode: { type: "leaf", paneId: "p-a" } },
            { id: "t-b", title: "B", rootNode: { type: "leaf", paneId: "p-b" } },
          ],
          pinnedTabIds: [],
        },
      },
    };
    useAppStore.setState({
      mountedWorkspaces: { [WS_PATH]: true },
      viewports: {
        [WS_PATH]: {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "t-b" },
          focusedPaneIds: {},
        },
      },
    });
    answerWith({
      [WS_PATH]: {
        ...serverEntry(6, twoTabs),
        defaultViewport: {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "t-a" },
          focusedPaneIds: {},
        },
      },
    } as never);
    emitBridgeResync();
    await settled();
    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBe(twoTabs);
    expect(state.viewports[WS_PATH].selectedTabIds).toEqual({ "panel-1": "t-b" });
  });

  it("does not seed a viewport for a workspace this window has not opened", async () => {
    answerWith({ [WS_PATH]: serverEntry(6, incoming) });
    emitBridgeResync();
    await settled();
    expect(useAppStore.getState().viewports[WS_PATH]).toBeUndefined();
  });

  it("keeps a workspace whose creation landed while the read was in flight", async () => {
    // The only workspace the server can be missing from its read: the store
    // holds no layout for a workspace until the server's broadcast creates it.
    const OTHER = "/test/other";
    vi.spyOn(window.electronAPI.layout, "getAll").mockImplementation(
      async () => {
        useAppStore.setState((state) => ({
          workspaceLayouts: { ...state.workspaceLayouts, [OTHER]: held },
          layoutVersions: { ...state.layoutVersions, [OTHER]: 1 },
        }));
        return { [WS_PATH]: serverEntry(5, held) } as never;
      },
    );
    emitBridgeResync();
    await settled();
    expect(useAppStore.getState().workspaceLayouts[OTHER]).toBe(held);
  });
});
