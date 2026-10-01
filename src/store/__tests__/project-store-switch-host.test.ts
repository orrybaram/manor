import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useProjectStore, type ProjectInfo } from "../project-store";
import { workspaceKey } from "../../lib/workspace-key";

// A host switch moves a project's checkout (ADR-179). The window used to
// keep showing the old path — a workspace that no longer exists — and was
// unusable until the user clicked back in. Now the old workspaces' tabs
// close and the window moves to the new main workspace.

vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    projects: {
      switchHost: vi.fn(),
      moveToHost: vi.fn(),
      selectWorkspace: vi.fn(),
      select: vi.fn(),
    },
  },
});

const OLD = "/Users/me/Code/gary";
const OLD_WT = "/Users/me/.manor/worktrees/gary/feat";
const NEW = "/home/me/code/gary";

function project(path: string, extraWorkspaces: string[] = [], hostId = "local"): ProjectInfo {
  const ws = (p: string, isMain: boolean) => ({
    path: p,
    branch: isMain ? "main" : "feat",
    isMain,
    name: null,
    linkedIssues: [],
  });
  return {
    id: "p1",
    name: "gary",
    path,
    hostId,
    defaultBranch: "main",
    workspaces: [ws(path, true), ...extraWorkspaces.map((p) => ws(p, false))],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    folders: [],
    sidebarOrder: [],
  };
}

/**
 * A layout this window has open for `path`. The layout is the server's
 * (ADR-179 D1): a window only ever holds a replica of what it was sent, so a
 * test seeds the replica rather than building one with actions.
 */
function openLayout(key: string, tabId = "tab-1"): void {
  useAppStore.setState((s) => ({
    workspaceLayouts: {
      ...s.workspaceLayouts,
      [key]: {
        panelTree: { type: "leaf", panelId: "panel-1" },
        panels: {
          "panel-1": {
            id: "panel-1",
            tabs: [{ id: tabId, title: "Terminal", rootNode: { type: "leaf", paneId: `${tabId}-pane` } }],
            pinnedTabIds: [],
          },
        },
      },
    },
  }));
}

describe("switchProjectHost", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [project(OLD, [OLD_WT])], selectedProjectIndex: 0 });
    useAppStore.setState({
      workspaceLayouts: {},
      activeWorkspacePath: null,
      activeWorkspaceHostId: "local",
    });
    vi.clearAllMocks();
  });

  it("closes the old workspaces' tabs and shows the new main workspace", async () => {
    useAppStore.getState().setActiveWorkspace(OLD_WT);
    useAppStore.getState().setActiveWorkspace(OLD);
    vi.mocked(window.electronAPI.projects.switchHost).mockResolvedValue(
      project(NEW, [], "box"),
    );

    await useProjectStore.getState().switchProjectHost("p1", "box");

    const app = useAppStore.getState();
    expect(app.activeWorkspacePath).toBe(NEW);
    expect(app.workspaceLayouts[OLD]).toBeUndefined();
    expect(app.workspaceLayouts[OLD_WT]).toBeUndefined();
  });

  it("closes the old tabs without moving a window that shows another project", async () => {
    useAppStore.getState().setActiveWorkspace(OLD);
    useAppStore.getState().setActiveWorkspace("/elsewhere");
    vi.mocked(window.electronAPI.projects.switchHost).mockResolvedValue(
      project(NEW, [], "box"),
    );

    await useProjectStore.getState().switchProjectHost("p1", "box");

    const app = useAppStore.getState();
    expect(app.activeWorkspacePath).toBe("/elsewhere");
    expect(app.workspaceLayouts[OLD]).toBeUndefined();
  });

  it("changes nothing when the switch is refused", async () => {
    openLayout(OLD);
    useAppStore.getState().setActiveWorkspace(OLD);
    vi.mocked(window.electronAPI.projects.switchHost).mockRejectedValue(
      new Error("does not exist"),
    );

    await expect(useProjectStore.getState().switchProjectHost("p1", "box")).rejects.toThrow();

    const app = useAppStore.getState();
    expect(app.activeWorkspacePath).toBe(OLD);
    expect(app.workspaceLayouts[OLD]).toBeDefined();
  });

  // ADR-191: a path the new host has too keeps its tabs, under its new key.
  it("keeps the tabs of a workspace whose path the new host has too", async () => {
    openLayout(OLD);
    useAppStore.getState().setActiveWorkspace(OLD, "local");
    const tabs = useAppStore.getState().workspaceLayouts[OLD].panels;
    vi.mocked(window.electronAPI.projects.switchHost).mockResolvedValue(
      project(OLD, [], "box"),
    );

    await useProjectStore.getState().switchProjectHost("p1", "box");

    const app = useAppStore.getState();
    expect(app.workspaceLayouts[OLD]).toBeUndefined();
    expect(app.workspaceLayouts[workspaceKey("box", OLD)].panels).toEqual(tabs);
    expect(app.activeWorkspacePath).toBe(OLD);
    expect(app.activeWorkspaceHostId).toBe("box");
  });
});
