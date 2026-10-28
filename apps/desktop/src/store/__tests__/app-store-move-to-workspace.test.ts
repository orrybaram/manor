/**
 * A pane moved to another workspace keeps what this renderer knew about it.
 *
 * The server broadcasts the source first, where the pane is gone, so the
 * replica drops its side maps; the target's broadcast hands them back
 * (`restored`), as a reopen's does.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, type Tab } from "../app-store";
import { layoutServer, resetFakeLayoutServer, settled } from "./fake-layout-server";

const FROM = "/project/main";
const TO = "/project/feature";

function leafTab(id: string, paneId: string): Tab {
  return { id, title: "Terminal", rootNode: { type: "leaf", paneId } };
}

beforeEach(async () => {
  resetFakeLayoutServer();
  useAppStore.setState({
    activeWorkspacePath: FROM,
    workspaceLayouts: {},
    viewports: {},
    layoutVersions: {},
    mountedWorkspaces: {},
    claims: {},
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
  });
  const layout = window.electronAPI.layout;
  await layout.apply(FROM, { type: "new-tab", tab: leafTab("tab-1", "pane-1") });
  await layout.apply(FROM, { type: "new-tab", tab: leafTab("tab-2", "pane-2") });
  await layout.apply(TO, { type: "new-tab", tab: leafTab("tab-t", "pane-t") });
  await settled();
});

describe("moving a pane to another workspace", () => {
  it("keeps its cwd and agent status in the replica", async () => {
    const server = layoutServer();
    server.recordSpawn("pane-2", "/project/main/src");
    server.onPaneStatus({ paneId: "pane-2", status: "working", reason: "hook", kind: "claude" });
    useAppStore.setState({
      paneCwd: { "pane-2": "/project/main/src" },
      paneAgentStatus: { "pane-2": { status: "working", reason: "hook", kind: "claude" } },
    } as never);

    const result = await window.electronAPI.layout.moveToWorkspace(FROM, { paneId: "pane-2" }, TO);
    await settled();

    expect(result).toMatchObject({ workspacePath: TO, paneId: "pane-2" });
    const state = useAppStore.getState();
    expect(state.paneCwd["pane-2"]).toBe("/project/main/src");
    expect(state.paneAgentStatus["pane-2"]).toMatchObject({ status: "working" });
  });

  it("still forgets a pane that closed", async () => {
    useAppStore.setState({ paneCwd: { "pane-2": "/project/main/src" } });

    await window.electronAPI.layout.apply(FROM, { type: "close-pane", paneId: "pane-2" });
    await settled();

    expect(useAppStore.getState().paneCwd["pane-2"]).toBeUndefined();
  });
});
