import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectActivePanelId,
  selectPaneContentType,
  selectPaneFilePath,
  selectSelectedTabId,
} from "../app-store";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import { buildLayoutSnapshot } from "../../lib/layout/snapshot";
import { tabTitle } from "../../lib/pane-title";
import { takeSourceControlRequest } from "../../lib/source-control-request";
import { convertPaneTo, splitPaneWith } from "../../lib/pane-actions";
import type { Panel, WorkspaceLayout } from "../app-store";
import { resetFakeLayoutServer, seedLayout, settled } from "./fake-layout-server";

const WS_PATH = "/test/workspace";

function makeLayout(): WorkspaceLayout {
  const panel: Panel = {
    id: "panel-1",
    tabs: [{ id: "tab-1", title: "Terminal", rootNode: { type: "leaf", paneId: "pane-1" } }],
    pinnedTabIds: [],
  };
  return { panelTree: { type: "leaf", panelId: "panel-1" }, panels: { "panel-1": panel } };
}

function setupStore() {
  resetFakeLayoutServer();
  const start = makeLayout();
  seedLayout(WS_PATH, start);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: start },
    viewports: { [WS_PATH]: reconcileViewport(start, emptyViewport()) },
    layoutVersions: {},
    mountedWorkspaces: {},
    paneCwd: {},
    paneTitle: {},
    paneLiveUrl: {},
  });
}

function activePanel(): Panel {
  const state = useAppStore.getState();
  return state.workspaceLayouts[WS_PATH].panels[selectActivePanelId(state)!];
}

describe("file panes", () => {
  beforeEach(setupStore);

  it("addFileTab opens a selected file tab with its file on the leaf", async () => {
    const created = useAppStore.getState().addFileTab("src/lib/thing.ts");
    await settled();

    const tab = activePanel().tabs[1];
    expect(tab.id).toBe(created!.tabId);
    expect(tab.title).toBe("thing.ts");
    expect(tab.rootNode).toEqual({
      type: "leaf",
      paneId: created!.paneId,
      contentType: "file",
      filePath: "src/lib/thing.ts",
    });
    const state = useAppStore.getState();
    expect(selectSelectedTabId(state, selectActivePanelId(state))).toBe(tab.id);
    expect(selectPaneContentType(state, created!.paneId)).toBe("file");
    expect(selectPaneFilePath(state, created!.paneId)).toBe("src/lib/thing.ts");
    expect(tabTitle(state, created!.paneId, null)).toBe("thing.ts");
  });

  it("addFileTab with no file opens a pane on nothing, titled Files", async () => {
    const { paneId } = useAppStore.getState().addFileTab()!;
    await settled();

    const state = useAppStore.getState();
    expect(selectPaneContentType(state, paneId)).toBe("file");
    expect(selectPaneFilePath(state, paneId)).toBeNull();
    expect(tabTitle(state, paneId, null)).toBe("Files");
  });

  it("setPaneFilePath keeps the open file on the leaf, by way of the server", async () => {
    const { paneId } = useAppStore.getState().addFileTab()!;
    await settled();

    useAppStore.getState().setPaneFilePath(paneId, "README.md");
    await settled();
    expect(selectPaneFilePath(useAppStore.getState(), paneId)).toBe("README.md");

    useAppStore.getState().setPaneFilePath(paneId, "docs/guide.md");
    await settled();
    expect(selectPaneFilePath(useAppStore.getState(), paneId)).toBe("docs/guide.md");
    expect(selectPaneContentType(useAppStore.getState(), paneId)).toBe("file");
  });

  it("setPaneFilePath leaves a pane that is not a file pane alone", async () => {
    useAppStore.getState().setPaneFilePath("pane-1", "README.md");
    await settled();
    const state = useAppStore.getState();
    expect(selectPaneContentType(state, "pane-1")).toBe("terminal");
    expect(selectPaneFilePath(state, "pane-1")).toBeNull();
  });

  it("splitPaneAt can open a file pane on a file", async () => {
    const paneId = useAppStore
      .getState()
      .splitPaneAt("pane-1", "horizontal", "second", { contentType: "file", filePath: "a/b.ts" });
    await settled();
    const state = useAppStore.getState();
    expect(selectPaneContentType(state, paneId!)).toBe("file");
    expect(selectPaneFilePath(state, paneId!)).toBe("a/b.ts");
  });

  it("retyping a file pane drops its file", async () => {
    const { paneId } = useAppStore.getState().addFileTab("a.ts")!;
    await settled();
    useAppStore.getState().setPaneContentType(paneId, "terminal");
    await settled();
    expect(selectPaneFilePath(useAppStore.getState(), paneId)).toBeNull();
  });

  it("Open Source Control comes back to its pane once a file is open there, on Source Control", async () => {
    const tabId = useAppStore.getState().openSourceControl();
    await settled();
    const rootNode = activePanel().tabs.find((t) => t.id === tabId)!.rootNode;
    const paneId = rootNode.type === "leaf" ? rootNode.paneId : "";
    useAppStore.getState().setPaneFilePath(paneId, "a.ts");
    await settled();
    useAppStore.getState().selectTab("tab-1");
    takeSourceControlRequest(paneId);

    expect(useAppStore.getState().openSourceControl()).toBe(tabId);
    await settled();

    expect(activePanel().tabs).toHaveLength(2);
    const state = useAppStore.getState();
    expect(selectSelectedTabId(state, selectActivePanelId(state))).toBe(tabId);
    expect(selectPaneFilePath(state, paneId)).toBe("a.ts");
    expect(takeSourceControlRequest(paneId)).toBe(true);
  });

  // A host on an older bundle drops `startsOn`; the request opens the drawer anyway.
  it("Split with › Source Control asks the new pane for Source Control", async () => {
    splitPaneWith("pane-1", "horizontal", "scm");
    await settled();
    const rootNode = activePanel().tabs[0].rootNode;
    const paneId = rootNode.type === "split" && rootNode.second.type === "leaf" ? rootNode.second.paneId : "";
    expect(selectPaneContentType(useAppStore.getState(), paneId)).toBe("file");
    expect(takeSourceControlRequest(paneId)).toBe(true);
  });

  it("Convert to › Source Control asks the converted pane for Source Control", async () => {
    convertPaneTo("pane-1", "scm");
    await settled();
    expect(selectPaneContentType(useAppStore.getState(), "pane-1")).toBe("file");
    expect(takeSourceControlRequest("pane-1")).toBe(true);
  });

  it("the layout snapshot lists a file pane's file", async () => {
    const { paneId } = useAppStore.getState().addFileTab("a.ts")!;
    await settled();
    const snapshot = buildLayoutSnapshot(
      WS_PATH,
      useAppStore.getState().workspaceLayouts[WS_PATH],
      null,
    );
    expect(snapshot.tabs[1].panes).toEqual([{ paneId, contentType: "file", filePath: "a.ts" }]);
  });
});
