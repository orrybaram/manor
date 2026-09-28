import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { selectActiveWorkspaceKey, useAppStore } from "../app-store";
import { useProjectStore } from "../project-store";
import { workspaceKey } from "../../lib/workspace-key";
import { paneCreateHostId } from "../../hooks/useTerminalConnection";

// ADR-191: a local and a remote workspace at the same path keep separate
// layouts, keyed by host plus path, and each restored pane comes back on the
// host its workspace is on.

const SHARED = "/home/me/.manor/worktrees/app/feat";
const BOX = workspaceKey("box", SHARED);

function persistedWorkspace(key: string, paneId: string) {
  return {
    workspacePath: key,
    panelTree: { type: "leaf", panelId: `panel-${paneId}` },
    panels: {
      [`panel-${paneId}`]: {
        id: `panel-${paneId}`,
        tabs: [
          {
            id: `tab-${paneId}`,
            title: "Terminal",
            rootNode: { type: "leaf", paneId },
            focusedPaneId: paneId,
            paneSessions: {
              [paneId]: { daemonSessionId: paneId, lastCwd: SHARED, lastTitle: null },
            },
          },
        ],
        selectedTabId: `tab-${paneId}`,
        pinnedTabIds: [],
      },
    },
    activePanelId: `panel-${paneId}`,
  };
}

function project(id: string, hostId: string) {
  return {
    id,
    name: id,
    path: "/home/me/app",
    hostId,
    workspaces: [{ path: SHARED, branch: "feat", isMain: false, name: null }],
    selectedWorkspaceIndex: 0,
  };
}

function paneIds(key: string): string[] {
  const layout = useAppStore.getState().workspaceLayouts[key];
  return Object.values(layout?.panels ?? {}).flatMap((p) =>
    p.tabs.map((t) => t.focusedPaneId),
  );
}

beforeEach(async () => {
  useAppStore.setState({
    workspaceLayouts: {},
    activeWorkspacePath: null,
    activeWorkspaceHostId: "local",
  });
  // The local project is selected, as it may well be after a restart.
  useProjectStore.setState({
    projects: [project("p-local", "local"), project("p-box", "box")],
    selectedProjectIndex: 0,
  } as never);
  vi.mocked(window.electronAPI.layout.load).mockResolvedValueOnce({
    version: 3,
    workspaces: [
      persistedWorkspace(SHARED, "local-pane"),
      persistedWorkspace(BOX, "box-pane"),
    ],
  } as never);
  await useAppStore.getState().loadPersistedLayout();
});

describe("layouts keyed by host plus path", () => {
  it("restores each host's layout for the same path", () => {
    useAppStore.getState().setActiveWorkspace(SHARED, "box");
    useAppStore.getState().setActiveWorkspace(SHARED, "local");

    expect(paneIds(BOX)).toEqual(["box-pane"]);
    expect(paneIds(SHARED)).toEqual(["local-pane"]);
  });

  it("activates the workspace on the host it is asked for", () => {
    useAppStore.getState().setActiveWorkspace(SHARED, "box");

    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(SHARED);
    expect(state.activeWorkspaceHostId).toBe("box");
    expect(selectActiveWorkspaceKey(state)).toBe(BOX);
  });

  it("takes the selected project's host when the caller names none", () => {
    useAppStore.getState().setActiveWorkspace(SHARED);
    expect(useAppStore.getState().activeWorkspaceHostId).toBe("local");

    useProjectStore.setState({ selectedProjectIndex: 1 });
    useAppStore.getState().setActiveWorkspace(SHARED);
    expect(useAppStore.getState().activeWorkspaceHostId).toBe("box");
  });

  it("brings a restored remote pane back on its host while the local project is selected", () => {
    useAppStore.getState().setActiveWorkspace(SHARED, "box");

    const noPanes = { panes: {} };
    expect(paneCreateHostId("box-pane", BOX, noPanes)).toBe("box");
    expect(paneCreateHostId("local-pane", SHARED, noPanes)).toBe("local");
  });

  it("moves a layout to its key on a new host, following the active workspace", () => {
    useAppStore.getState().setActiveWorkspace(SHARED, "local");
    useAppStore.setState((s) => {
      const { [BOX]: _, ...rest } = s.workspaceLayouts;
      return { workspaceLayouts: rest };
    });

    useAppStore.getState().moveWorkspaceLayout(workspaceKey("local", SHARED), BOX);

    const state = useAppStore.getState();
    expect(state.workspaceLayouts[SHARED]).toBeUndefined();
    expect(paneIds(BOX)).toEqual(["local-pane"]);
    expect(selectActiveWorkspaceKey(state)).toBe(BOX);
  });

  describe("saving", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("saves the active workspace under its key", () => {
      vi.mocked(window.electronAPI.layout.save).mockClear();
      useAppStore.getState().setActiveWorkspace(SHARED, "box");
      vi.advanceTimersByTime(600);

      expect(window.electronAPI.layout.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspacePath: BOX }),
      );
    });
  });
});
