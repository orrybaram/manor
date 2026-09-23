/**
 * The renderer is a replica (ADR-179 D1).
 *
 * Every structural action sends a `LayoutCommand` and writes nothing; the
 * layout arrives on `layout.changed` and replaces what was there. These are
 * the rules the rest of the store tests rely on without restating: what goes
 * out, what comes back, what is dropped, and what this window's selection
 * survives.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectFocusedPaneId,
  selectPaneContentType,
  selectPaneUrl,
  selectSelectedTabId,
  selectVisibleTabs,
} from "../app-store";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import type { Panel, Tab, WorkspaceLayout } from "../app-store";
import {
  broadcastLayout,
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
  settled,
} from "./fake-layout-server";

const WS_PATH = "/test/workspace";

function tab(id: string, paneId: string, title = "Terminal"): Tab {
  return {
    id,
    title,
    rootNode: { type: "leaf", paneId },
  };
}

function panel(id: string, tabs: Tab[]): Panel {
  return { id, tabs, pinnedTabIds: [] };
}

function layoutOf(tabs: Tab[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": panel("panel-1", tabs) },
  };
}

/** This renderer's selection, which is where it now lives (ADR-179 D3). */
function selectedTabId(): string | null {
  return selectSelectedTabId(useAppStore.getState(), "panel-1");
}

function focusedPaneId(tabId: string): string | null {
  return selectFocusedPaneId(useAppStore.getState(), tabId);
}

function setup(layout: WorkspaceLayout) {
  resetFakeLayoutServer();
  seedLayout(WS_PATH, layout);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout },
    viewports: { [WS_PATH]: reconcileViewport(layout, emptyViewport()) },
    layoutVersions: {},
    mountedWorkspaces: {},
    claims: {},
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneLiveUrl: {},
  });
}

function replica(): WorkspaceLayout {
  return useAppStore.getState().workspaceLayouts[WS_PATH];
}

/** A layout the server could send: same shape, different object identity. */
function withExtraTab(base: WorkspaceLayout, extra: Tab): WorkspaceLayout {
  const first = base.panels["panel-1"];
  return {
    ...base,
    panels: {
      "panel-1": { ...first, tabs: [...first.tabs, extra] },
    },
  };
}

describe("actions send commands", () => {
  beforeEach(() => setup(layoutOf([tab("tab-1", "pane-1")])));

  it("splitPane names the focused pane and mints the new one", async () => {
    useAppStore.getState().splitPane("vertical");
    await settled();

    expect(sentCommands).toHaveLength(1);
    const { workspacePath, command } = sentCommands[0];
    expect(workspacePath).toBe(WS_PATH);
    expect(command).toMatchObject({
      type: "split-pane-at",
      position: "second",
      paneId: "pane-1",
      direction: "vertical",
    });
    // The id is the sender's, so it can focus the pane when it lands (D1).
    expect(command).toHaveProperty("newPaneId", expect.any(String));
  });

  it("closeTab sends the command and nothing else", async () => {
    useAppStore.getState().closeTab("tab-1");
    await settled();

    expect(sentCommands).toEqual([
      { workspacePath: WS_PATH, command: { type: "close-tab", tabId: "tab-1" } },
    ]);
  });

  it("selecting a tab sends nothing — viewport is local (D3)", async () => {
    useAppStore.getState().selectTab("tab-1");
    await settled();
    useAppStore.getState().focusPane("pane-1");
    await settled();

    expect(sentCommands).toEqual([]);
  });

  it("an action writes no layout of its own", async () => {
    // The fake server answers, so the *broadcast* changes the replica. What
    // must not happen is the action changing it first, or at all on its own.
    resetFakeLayoutServer();
    const before = replica();

    useAppStore.getState().splitPane("horizontal");
    await settled();
    useAppStore.getState().closeTab("tab-1");
    await settled();
    useAppStore.getState().togglePinTab("tab-1");
    await settled();

    expect(sentCommands).toHaveLength(3);
    expect(replica()).toBe(before);
  });
});

describe("broadcasts set the state", () => {
  beforeEach(() => setup(layoutOf([tab("tab-1", "pane-1")])));

  it("replaces the workspace and records the version", async () => {
    const next = withExtraTab(replica(), tab("tab-2", "pane-2"));

    broadcastLayout(WS_PATH, next, 7);

    expect(replica().panels["panel-1"].tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "tab-2",
    ]);
    expect(useAppStore.getState().layoutVersions[WS_PATH]).toBe(7);
  });

  it("drops a broadcast older than the one it has", async () => {
    const second = withExtraTab(replica(), tab("tab-2", "pane-2"));
    broadcastLayout(WS_PATH, second, 5);

    const stale = withExtraTab(replica(), tab("tab-stale", "pane-stale"));
    broadcastLayout(WS_PATH, stale, 4);

    expect(replica().panels["panel-1"].tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "tab-2",
    ]);
    expect(useAppStore.getState().layoutVersions[WS_PATH]).toBe(5);
  });

  it("drops a repeat of the version it already has", async () => {
    broadcastLayout(WS_PATH, withExtraTab(replica(), tab("t2", "p2")), 3);
    const after = replica();

    broadcastLayout(WS_PATH, withExtraTab(after, tab("t3", "p3")), 3);

    expect(replica()).toBe(after);
  });

  it("applies an equal-version broadcast whose claims changed (D4)", async () => {
    setup(layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]));
    const current = replica();
    broadcastLayout(WS_PATH, current, 4);

    // Popping tab-2 out changes no tree and bumps no version — the only new
    // thing the server has to say is who is holding it.
    broadcastLayout(WS_PATH, current, 4, undefined, {
      claims: [{ windowId: "9", tabId: "tab-2" }],
    });

    expect(useAppStore.getState().claims[WS_PATH]).toEqual([
      { windowId: "9", tabId: "tab-2" },
    ]);
    expect(selectVisibleTabs(useAppStore.getState(), WS_PATH, replica().panels["panel-1"]).map((t) => t.id)).toEqual(["tab-1"]);

    // And releasing it, at the same version again, brings the tab back.
    broadcastLayout(WS_PATH, current, 4, undefined, { claims: [] });
    expect(useAppStore.getState().claims[WS_PATH]).toEqual([]);
    expect(selectVisibleTabs(useAppStore.getState(), WS_PATH, replica().panels["panel-1"]).map((t) => t.id)).toEqual(["tab-1", "tab-2"]);
  });

  it("moves the selection off a tab that was just claimed (D4)", async () => {
    setup(layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]));
    useAppStore.getState().selectTab("tab-2");
    await settled();
    expect(selectedTabId()).toBe("tab-2");

    broadcastLayout(WS_PATH, replica(), 2, undefined, {
      claims: [{ windowId: "9", tabId: "tab-2" }],
    });

    expect(selectedTabId()).toBe("tab-1");
  });

  it("reads contentType and url off the leaves (ADR-182 D9)", async () => {
    const browserTab: Tab = {
      id: "tab-2",
      title: "example.com",
      rootNode: {
        type: "leaf",
        paneId: "pane-2",
        contentType: "browser",
        url: "https://example.com",
      },
    };

    broadcastLayout(WS_PATH, withExtraTab(replica(), browserTab), 2);

    const state = useAppStore.getState();
    expect(selectPaneContentType(state, "pane-2")).toBe("browser");
    expect(selectPaneUrl(state, "pane-2")).toBe("https://example.com");
  });

  it("forgets a pane's content type the moment its leaf loses it", async () => {
    // The old side map only ever added entries, so a retype that came from
    // elsewhere left the stale one behind.
    const browserTab: Tab = {
      id: "tab-2",
      title: "example.com",
      rootNode: { type: "leaf", paneId: "pane-2", contentType: "browser" },
    };
    broadcastLayout(WS_PATH, withExtraTab(replica(), browserTab), 2);

    broadcastLayout(
      WS_PATH,
      withExtraTab(layoutOf([tab("tab-1", "pane-1")]), tab("tab-2", "pane-2")),
      3,
    );

    expect(selectPaneContentType(useAppStore.getState(), "pane-2")).toBe(
      "terminal",
    );
  });

  it("drops the side maps of panes that left the tree", async () => {
    setup(layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]));
    useAppStore.setState({
      paneCwd: { "pane-1": "/repo", "pane-2": "/repo/sub" },
      paneTitle: { "pane-1": "one", "pane-2": "two" },
    });

    broadcastLayout(WS_PATH, layoutOf([tab("tab-1", "pane-1")]), 2);

    const state = useAppStore.getState();
    expect(state.paneCwd).toEqual({ "pane-1": "/repo" });
    expect(state.paneTitle).toEqual({ "pane-1": "one" });
  });

  it("seeds the side maps of the panes a reopen brought back", async () => {
    // The server's grace kept the shell alive, so the pane reattaches with
    // the cwd and title it had (ADR-179 ticket 10) rather than looking new.
    broadcastLayout(
      WS_PATH,
      withExtraTab(replica(), tab("tab-2", "pane-2")),
      2,
      {
        "pane-2": {
          daemonSessionId: "pane-2",
          lastCwd: "/repo/sub",
          lastTitle: "build",
          lastAgentStatus: {
            kind: "claude",
            status: "working",
            processName: "claude",
            since: 1,
            title: "build",
          },
        },
      },
    );

    const state = useAppStore.getState();
    expect(state.paneCwd["pane-2"]).toBe("/repo/sub");
    expect(state.paneTitle["pane-2"]).toBe("build");
    expect(state.paneAgentStatus["pane-2"]?.status).toBe("working");
  });

  it("does not open a workspace this window has never looked at", async () => {
    const other = layoutOf([tab("tab-9", "pane-9")]);
    broadcastLayout("/other/workspace", other, 1);

    const state = useAppStore.getState();
    // Held, but not mounted: rendering its panes would create their PTYs
    // behind the user's back.
    expect(state.workspaceLayouts["/other/workspace"]).toBe(other);
    expect(state.mountedWorkspaces["/other/workspace"]).toBeUndefined();
    expect(state.viewports["/other/workspace"]).toBeUndefined();
    expect(state.layoutVersions["/other/workspace"]).toBe(1);

    // Mounted the moment the user goes looking.
    state.setActiveWorkspace("/other/workspace");
    const after = useAppStore.getState();
    expect(after.mountedWorkspaces["/other/workspace"]).toBe(true);
    expect(selectSelectedTabId(after, "panel-1")).toBe("tab-9");
  });
});

describe("this window's selection survives a broadcast", () => {
  it("keeps the selected tab when the change was somewhere else", async () => {
    setup(layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]));
    useAppStore.getState().selectTab("tab-2");
    await settled();

    // The selection is this renderer's and never reached the server, so a
    // structural change elsewhere cannot move it (ADR-179 D3).
    useAppStore.getState().splitPane("horizontal");
    await settled();

    expect(selectedTabId()).toBe("tab-2");
  });

  it("takes the hint from a command it sent itself", async () => {
    setup(layoutOf([tab("tab-1", "pane-1")]));

    const created = useAppStore.getState().addTab()!;
    await settled();

    // `new-tab` implies "select it", and the hint came back tagged with this
    // renderer's id.
    expect(selectedTabId()).toBe(created.tabId);
  });

  it("ignores a hint addressed to another renderer", async () => {
    setup(layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]));
    useAppStore.getState().selectTab("tab-2");
    await settled();

    // Exactly what the server sends when *another* window opens a tab.
    const next = layoutOf([
      tab("tab-1", "pane-1"),
      tab("tab-2", "pane-2"),
      tab("tab-3", "pane-3"),
    ]);
    broadcastLayout(WS_PATH, next, 99, undefined, {
      origin: { kind: "window", id: "some-other-window" },
      hint: { selectTab: { panelId: "panel-1", tabId: "tab-3" } },
    });

    expect(replica().panels["panel-1"].tabs).toHaveLength(3);
    expect(selectedTabId()).toBe("tab-2");
  });

  it("repairs a selection whose tab is gone", async () => {
    setup(layoutOf([tab("tab-1", "pane-1"), tab("tab-2", "pane-2")]));
    useAppStore.getState().selectTab("tab-2");
    await settled();

    useAppStore.getState().closeTab("tab-2");
    await settled();

    expect(selectedTabId()).toBe("tab-1");
  });

  it("keeps the focused pane when the tab's panes did not change", async () => {
    setup(
      layoutOf([
        {
          id: "tab-1",
          title: "Terminal",
          rootNode: {
            type: "split",
            direction: "horizontal",
            ratio: 0.5,
            first: { type: "leaf", paneId: "pane-1" },
            second: { type: "leaf", paneId: "pane-2" },
          },
        },
      ]),
    );
    useAppStore.getState().focusPane("pane-1");
    await settled();

    // A ratio drag touches no pane set, so it must not move the keyboard.
    useAppStore.getState().updateSplitRatio("pane-1", 0.7);
    await settled();

    const current = replica().panels["panel-1"].tabs[0];
    expect(focusedPaneId("tab-1")).toBe("pane-1");
    expect(current.rootNode).toMatchObject({ ratio: 0.7 });
  });

  it("takes the focus hint into a pane it just created", async () => {
    setup(layoutOf([tab("tab-1", "pane-1")]));

    const paneId = useAppStore
      .getState()
      .splitPaneAt("pane-1", "horizontal", "second")!;
    await settled();

    expect(focusedPaneId("tab-1")).toBe(paneId);
  });
});
