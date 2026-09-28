import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { selectActiveWorkspaceKey, useAppStore } from "../app-store";
import { useProjectStore } from "../project-store";
import { workspaceKey } from "../../lib/workspace-key";
import { paneCreateHostId } from "../../hooks/useTerminalConnection";
import type { ProjectInfo } from "../project-store";

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

/** Load `workspaces` as `layout.json` at `version`, with nothing open. */
async function loadLayout(version: 2 | 3, workspaces: object[]): Promise<void> {
  useAppStore.setState({
    workspaceLayouts: {},
    activeWorkspacePath: null,
    activeWorkspaceHostId: "local",
  });
  vi.mocked(window.electronAPI.layout.load).mockResolvedValueOnce({
    version,
    workspaces,
  } as never);
  await useAppStore.getState().loadPersistedLayout();
}

/** The workspace key the active layout was last saved under. */
function lastSavedKey(): string {
  vi.advanceTimersByTime(600);
  const calls = vi.mocked(window.electronAPI.layout.save).mock.calls;
  return (calls[calls.length - 1][0] as { workspacePath: string }).workspacePath;
}

// Main leaves layout.json at version 2 while a remote host can't say what it
// owns. Each workspace still reads and saves under its own key — a local one
// under its bare path, as before — never under a key picked from the project
// list, which may not match what main's migration later sees.
describe("a layout file not yet migrated (v2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives the legacy layout to the local workspace and the remote one its own key", async () => {
    // The re-review's scenario: the remote project's workspaces haven't
    // loaded yet, and it shares a path with a local project.
    useProjectStore.setState({
      projects: [project("p-local", "local"), { ...project("p-box", "box"), workspaces: [] }],
      selectedProjectIndex: 0,
    } as never);
    await loadLayout(2, [persistedWorkspace(SHARED, "legacy-pane")]);

    useAppStore.getState().setActiveWorkspace(SHARED, "box");
    expect(paneIds(BOX)).toEqual([]);
    expect(lastSavedKey()).toBe(BOX);

    useAppStore.getState().setActiveWorkspace(SHARED, "local");
    expect(paneIds(SHARED)).toEqual(["legacy-pane"]);
    expect(lastSavedKey()).toBe(SHARED);
  });

  it("keeps the same keys when the remote project's workspaces load mid-session", async () => {
    useProjectStore.setState({
      projects: [project("p-local", "local"), { ...project("p-box", "box"), workspaces: [] }],
      selectedProjectIndex: 0,
    } as never);
    await loadLayout(2, [persistedWorkspace(SHARED, "legacy-pane")]);
    useAppStore.getState().setActiveWorkspace(SHARED, "local");
    expect(lastSavedKey()).toBe(SHARED);

    useProjectStore.setState({
      projects: [project("p-local", "local"), project("p-box", "box")],
    } as never);
    useAppStore.getState().addTab();

    expect(lastSavedKey()).toBe(SHARED);
  });
});

// ADR-191 §3: main moves a moved project's saved layouts in layout.json;
// the renderer's copy of it must follow, or picking a moved workspace that
// wasn't open would start empty and save over the moved layout.
describe("a host move for a workspace that isn't open", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restores the moved layout under its new key", async () => {
    const local = { ...project("p1", "local"), path: SHARED } as unknown as ProjectInfo;
    useProjectStore.setState({ projects: [local], selectedProjectIndex: 0 } as never);
    await loadLayout(3, [persistedWorkspace(SHARED, "kept-pane")]);
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...window.electronAPI,
        projects: {
          ...window.electronAPI.projects,
          switchHost: vi.fn().mockResolvedValue({ ...local, hostId: "box" }),
          selectWorkspace: vi.fn(),
        },
      },
    });

    await useProjectStore.getState().switchProjectHost("p1", "box");
    useAppStore.getState().setActiveWorkspace(SHARED, "box");

    expect(paneIds(BOX)).toEqual(["kept-pane"]);
    expect(lastSavedKey()).toBe(BOX);
    vi.unstubAllGlobals();
  });
});

