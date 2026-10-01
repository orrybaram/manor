import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectActiveWorkspaceKey, useAppStore } from "../app-store";
import type { WorkspaceLayout } from "../app-store";
import { useProjectStore } from "../project-store";
import { workspaceKey } from "../../lib/workspace-key";
import { allPaneIds } from "../../lib/layout/pane-tree";
import { paneCreateHostId } from "../../hooks/useTerminalConnection";
import type { ProjectInfo } from "../project-store";
import {
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
} from "./fake-layout-server";

// ADR-191: a local and a remote workspace at the same path keep separate
// layouts, keyed by host plus path — on the Manor server, which owns them
// (ADR-179 D1), and so in every renderer's replica — and each restored pane
// comes back on the host its workspace is on.

const SHARED = "/home/me/.manor/worktrees/app/feat";
const BOX = workspaceKey("box", SHARED);

function layoutWith(paneId: string): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: `panel-${paneId}` },
    panels: {
      [`panel-${paneId}`]: {
        id: `panel-${paneId}`,
        tabs: [
          {
            id: `tab-${paneId}`,
            title: "Terminal",
            rootNode: { type: "leaf", paneId },
          },
        ],
        pinnedTabIds: [],
      },
    },
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
    p.tabs.flatMap((t) => allPaneIds(t.rootNode)),
  );
}

/** The server holds `layouts` by key; the renderer has opened none of them. */
async function loadFromServer(layouts: Record<string, WorkspaceLayout>): Promise<void> {
  resetFakeLayoutServer();
  for (const [key, layout] of Object.entries(layouts)) seedLayout(key, layout);
  useAppStore.setState({
    workspaceLayouts: {},
    serverLayouts: {},
    layoutVersions: {},
    viewports: {},
    claims: {},
    activeWorkspacePath: null,
    activeWorkspaceHostId: "local",
  });
  await useAppStore.getState().loadPersistedLayout();
}

beforeEach(async () => {
  // The local project is selected, as it may well be after a restart.
  useProjectStore.setState({
    projects: [project("p-local", "local"), project("p-box", "box")],
    selectedProjectIndex: 0,
  } as never);
  await loadFromServer({
    [SHARED]: layoutWith("local-pane"),
    [BOX]: layoutWith("box-pane"),
  });
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
      const { [BOX]: _server, ...serverRest } = s.serverLayouts;
      return { workspaceLayouts: rest, serverLayouts: serverRest };
    });

    useAppStore.getState().moveWorkspaceLayout(workspaceKey("local", SHARED), BOX);

    const state = useAppStore.getState();
    expect(state.workspaceLayouts[SHARED]).toBeUndefined();
    expect(paneIds(BOX)).toEqual(["local-pane"]);
    expect(selectActiveWorkspaceKey(state)).toBe(BOX);
  });

  it("sends the active workspace's commands under its key", () => {
    useAppStore.getState().setActiveWorkspace(SHARED, "box");
    useAppStore.getState().addTab();

    expect(sentCommands.map((c) => c.workspacePath)).toEqual([BOX]);
  });
});

// ADR-191 §3: the server moves a moved project's layouts (`LayoutStore.
// moveWorkspaces`); the renderer's copy of what it was handed must follow,
// or picking a moved workspace that wasn't open would start empty.
describe("a host move for a workspace that isn't open", () => {
  it("restores the moved layout under its new key", async () => {
    const local = { ...project("p1", "local"), path: SHARED } as unknown as ProjectInfo;
    useProjectStore.setState({ projects: [local], selectedProjectIndex: 0 } as never);
    await loadFromServer({ [SHARED]: layoutWith("kept-pane") });
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
    vi.unstubAllGlobals();
  });
});
