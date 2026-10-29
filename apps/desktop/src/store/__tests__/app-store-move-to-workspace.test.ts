/**
 * A pane moved to another workspace keeps what this renderer knew about it.
 *
 * The server broadcasts the source first, where the pane is gone, so the
 * replica drops its side maps; the target's broadcast hands them back
 * (`restored`), as a reopen's does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  selectActiveWorkspaceKey,
  selectFocusedPaneId,
  useAppStore,
  type Tab,
} from "../app-store";
import { useProjectStore, type ProjectInfo } from "../project-store";
import { clearRecords, toastStore } from "../../toast/toast-store";
import { moveToWorkspaceAndFollow } from "../workspace-actions";
import { useOpenFileStore } from "../open-file-store";
import { answerUnsavedGuard, useUnsavedGuardStore } from "../unsaved-guard-store";
import type { WorkspaceKey } from "../../lib/workspace-key";
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

describe("moveToWorkspaceAndFollow", () => {
  function project(): ProjectInfo {
    return {
      id: "p1",
      name: "project",
      path: FROM,
      hostId: "local",
      workspaces: [
        { path: FROM, branch: "main", isMain: true, name: null },
        { path: TO, branch: "feature", isMain: false, name: null },
      ],
      selectedWorkspaceIndex: 0,
    } as unknown as ProjectInfo;
  }

  beforeEach(() => {
    (window.electronAPI as unknown as Record<string, unknown>).projects = {
      selectWorkspace: vi.fn(),
    };
    useProjectStore.setState({ projects: [project()], selectedProjectIndex: 0 });
    clearRecords();
  });

  it("switches to the target and focuses the moved pane", async () => {
    await moveToWorkspaceAndFollow(FROM as WorkspaceKey, { paneId: "pane-2" }, TO as WorkspaceKey);

    const state = useAppStore.getState();
    expect(selectActiveWorkspaceKey(state)).toBe(TO);
    const tabId = state.viewports[TO].selectedTabIds[state.viewports[TO].activePanelId!];
    expect(selectFocusedPaneId(state, tabId!)).toBe("pane-2");
    expect(useProjectStore.getState().projects[0].selectedWorkspaceIndex).toBe(1);
  });

  describe("over a file pane's unsaved edits", () => {
    beforeEach(() => {
      useOpenFileStore.setState({ byPane: {} });
      useUnsavedGuardStore.setState({ request: null, saving: false });
      const files = useOpenFileStore.getState();
      files.open("pane-2", { hostId: "local", path: FROM }, "src/a.ts");
      files.dispatch("pane-2", { type: "read", content: "a", hash: "h", reason: "open" });
      files.dispatch("pane-2", { type: "edited", dirty: true });
    });

    it("asks first, and Cancel moves nothing", async () => {
      const moving = moveToWorkspaceAndFollow(
        FROM as WorkspaceKey,
        { tabId: "tab-2" },
        TO as WorkspaceKey,
      );
      await Promise.resolve();
      expect(useUnsavedGuardStore.getState().request).toMatchObject({
        verb: "move",
        paneIds: ["pane-2"],
      });
      await answerUnsavedGuard("cancel");
      await moving;
      expect(selectActiveWorkspaceKey(useAppStore.getState())).toBe(FROM);
      expect(useOpenFileStore.getState().byPane["pane-2"].dirty).toBe(true);
    });

    it("Discard and move moves it", async () => {
      const moving = moveToWorkspaceAndFollow(
        FROM as WorkspaceKey,
        { paneId: "pane-2" },
        TO as WorkspaceKey,
      );
      await answerUnsavedGuard("discard");
      await moving;
      expect(selectActiveWorkspaceKey(useAppStore.getState())).toBe(TO);
    });
  });

  it("toasts a refusal and stays put", async () => {
    await moveToWorkspaceAndFollow(FROM as WorkspaceKey, { paneId: "pane-nope" }, TO as WorkspaceKey);

    expect(selectActiveWorkspaceKey(useAppStore.getState())).toBe(FROM);
    expect(toastStore.getState().toasts).toEqual([
      expect.objectContaining({ status: "error", detail: "Unknown paneId: pane-nope" }),
    ]);
  });
});
