import { describe, it, expect } from "vitest";
import type { WorkspaceKey } from "../src/lib/workspace-key";
import { findWorkspaceForPane, matchProjectByPath } from "./pane-context";
import type {
  PersistedLayout,
  PersistedWorkspace,
  PersistedPanel,
  PersistedTab,
  PersistedPaneSession,
} from "./terminal-host/layout-persistence";
import type { ProjectInfo, WorkspaceInfo } from "./persistence";

function paneSession(overrides: Partial<PersistedPaneSession> = {}): PersistedPaneSession {
  return {
    daemonSessionId: "daemon-1",
    lastCwd: null,
    lastTitle: null,
    ...overrides,
  };
}

function tab(id: string, paneSessions: Record<string, PersistedPaneSession>): PersistedTab {
  return {
    id,
    title: id,
    rootNode: { type: "leaf", paneId: Object.keys(paneSessions)[0] ?? "pane-x" },
    paneSessions,
  };
}

function panel(id: string, tabs: PersistedTab[]): PersistedPanel {
  return {
    id,
    tabs,
    pinnedTabIds: [],
  };
}

/**
 * A v3 workspace: the tree, plus the default viewport that holds the
 * selection the tree used to (ADR-179 D3). `findWorkspaceForPane` walks
 * panes and never reads it, but a fixture with focus still in the tree
 * describes a file this version does not write.
 */
function workspace(
  workspacePath: string,
  panels: Record<string, PersistedPanel>,
): PersistedWorkspace {
  const firstPanelId = Object.keys(panels)[0] ?? "panel-1";
  return {
    workspacePath: workspacePath as WorkspaceKey,
    panelTree: { type: "leaf", panelId: firstPanelId },
    panels,
    activePanelId: firstPanelId,
    defaultViewport: {
      activePanelId: firstPanelId,
      selectedTabIds: Object.fromEntries(
        Object.values(panels).flatMap((p) =>
          p.tabs[0] ? [[p.id, p.tabs[0].id]] : [],
        ),
      ),
      focusedPaneIds: Object.fromEntries(
        Object.values(panels).flatMap((p) =>
          p.tabs.flatMap((t) => {
            const paneId = Object.keys(t.paneSessions)[0];
            return paneId ? [[t.id, paneId]] : [];
          }),
        ),
      ),
    },
  };
}

describe("pane-context", () => {
  // ─── findWorkspaceForPane ─────────────────────────────────────────────────

  describe("findWorkspaceForPane", () => {
    it("finds a pane in the first workspace", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          workspace("/repo/a", {
            "panel-1": panel("panel-1", [tab("tab-1", { "pane-1": paneSession() })]),
          }),
        ],
      };

      expect(findWorkspaceForPane(layout, "pane-1")).toBe("/repo/a");
    });

    it("returns the host-qualified key of a remote workspace (ADR-191)", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          workspace("/repo/a", {
            "panel-1": panel("panel-1", [tab("tab-1", { "pane-local": paneSession() })]),
          }),
          workspace("box:/repo/a", {
            "panel-2": panel("panel-2", [tab("tab-2", { "pane-box": paneSession() })]),
          }),
        ],
      };

      expect(findWorkspaceForPane(layout, "pane-local")).toBe("/repo/a");
      expect(findWorkspaceForPane(layout, "pane-box")).toBe("box:/repo/a");
    });

    it("finds a pane in a later workspace", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          workspace("/repo/a", {
            "panel-1": panel("panel-1", [tab("tab-1", { "pane-1": paneSession() })]),
          }),
          workspace("/repo/b", {
            "panel-2": panel("panel-2", [tab("tab-2", { "pane-2": paneSession() })]),
          }),
        ],
      };

      expect(findWorkspaceForPane(layout, "pane-2")).toBe("/repo/b");
    });

    it("finds a pane in a non-first tab/panel", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          workspace("/repo/a", {
            "panel-1": panel("panel-1", [tab("tab-1", { "pane-1": paneSession() })]),
            "panel-2": panel("panel-2", [
              tab("tab-2", { "pane-2": paneSession() }),
              tab("tab-3", { "pane-3": paneSession() }),
            ]),
          }),
        ],
      };

      expect(findWorkspaceForPane(layout, "pane-3")).toBe("/repo/a");
    });

    it("returns null on a miss", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          workspace("/repo/a", {
            "panel-1": panel("panel-1", [tab("tab-1", { "pane-1": paneSession() })]),
          }),
        ],
      };

      expect(findWorkspaceForPane(layout, "does-not-exist")).toBeNull();
    });

    it("does not match on daemonSessionId, only the paneId key", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          workspace("/repo/a", {
            "panel-1": panel("panel-1", [
              tab("tab-1", { "pane-1": paneSession({ daemonSessionId: "daemon-xyz" }) }),
            ]),
          }),
        ],
      };

      expect(findWorkspaceForPane(layout, "daemon-xyz")).toBeNull();
    });

    it("returns null when panels/tabs/paneSessions are missing (legacy/hand-rolled files)", () => {
      const layoutMissingPanels = {
        version: 2,
        workspaces: [{ workspacePath: "/repo/a" }],
      } as unknown as PersistedLayout;
      expect(findWorkspaceForPane(layoutMissingPanels, "pane-1")).toBeNull();

      const layoutMissingTabs = {
        version: 2,
        workspaces: [
          { workspacePath: "/repo/a", panels: { "panel-1": {} } },
        ],
      } as unknown as PersistedLayout;
      expect(findWorkspaceForPane(layoutMissingTabs, "pane-1")).toBeNull();

      const layoutMissingPaneSessions = {
        version: 2,
        workspaces: [
          {
            workspacePath: "/repo/a",
            panels: { "panel-1": { tabs: [{ id: "tab-1" }] } },
          },
        ],
      } as unknown as PersistedLayout;
      expect(findWorkspaceForPane(layoutMissingPaneSessions, "pane-1")).toBeNull();
    });

    it("returns null for an empty layout", () => {
      const layout: PersistedLayout = { version: 3, workspaces: [] };
      expect(findWorkspaceForPane(layout, "pane-1")).toBeNull();
    });
  });

  // ─── matchProjectByPath ───────────────────────────────────────────────────

  function makeWorkspaceInfo(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
    return {
      path: "/repo",
      branch: "main",
      isMain: true,
      name: null,
      ...overrides,
    };
  }

  function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
    return {
      id: "proj-1",
      name: "repo",
      path: "/repo",
      defaultBranch: "main",
      workspaces: [makeWorkspaceInfo()],
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
      hostId: "local",
      folders: [],
      sidebarOrder: [],
      ...overrides,
    };
  }

  describe("matchProjectByPath", () => {
    it("matches an exact workspace path", () => {
      const project = makeProject();
      const result = matchProjectByPath([project], "local", "/repo");

      expect(result).not.toBeNull();
      expect(result?.project).toBe(project);
      expect(result?.workspace.path).toBe("/repo");
    });

    it("picks the longest-prefix match over a shorter one (worktree beats main)", () => {
      const mainWorkspace = makeWorkspaceInfo({ path: "/repo", isMain: true });
      const worktreeWorkspace = makeWorkspaceInfo({
        path: "/repo/.worktrees/feat",
        isMain: false,
        name: "feat",
      });
      const project = makeProject({
        workspaces: [mainWorkspace, worktreeWorkspace],
      });

      const result = matchProjectByPath([project], "local", "/repo/.worktrees/feat/src");

      expect(result?.workspace).toBe(worktreeWorkspace);
    });

    it("respects path boundaries — /a/b must not match /a/bc", () => {
      const workspace = makeWorkspaceInfo({ path: "/a/b" });
      const project = makeProject({ workspaces: [workspace] });

      expect(matchProjectByPath([project], "local", "/a/bc")).toBeNull();
      expect(matchProjectByPath([project], "local", "/a/bc/d")).toBeNull();
    });

    it("matches a proper sub-path across the boundary", () => {
      const workspace = makeWorkspaceInfo({ path: "/a/b" });
      const project = makeProject({ workspaces: [workspace] });

      const result = matchProjectByPath([project], "local", "/a/b/src/index.ts");
      expect(result?.workspace).toBe(workspace);
    });

    it("returns null when nothing matches", () => {
      const project = makeProject();
      expect(matchProjectByPath([project], "local", "/somewhere/else")).toBeNull();
    });

    it("returns null for an empty project list", () => {
      expect(matchProjectByPath([], "local", "/repo")).toBeNull();
    });

    it("with the same path on a local and a remote project, a remote host resolves to the remote project", () => {
      const localProject = makeProject({ id: "local-p", hostId: "local" });
      const remoteProject = makeProject({ id: "box-p", hostId: "box" });

      const result = matchProjectByPath([localProject, remoteProject], "box", "/repo");

      expect(result?.project).toBe(remoteProject);
    });

    it("with the same path on a local and a remote project, local resolves to the local project", () => {
      const localProject = makeProject({ id: "local-p", hostId: "local" });
      const remoteProject = makeProject({ id: "box-p", hostId: "box" });

      const result = matchProjectByPath([localProject, remoteProject], "local", "/repo");

      expect(result?.project).toBe(localProject);
    });

    it("a caller's host with no project at the path finds nothing, even though another host's project matches", () => {
      const remoteProject = makeProject({ id: "box-p", hostId: "box" });
      expect(matchProjectByPath([remoteProject], "other", "/repo")).toBeNull();
    });

    it("an empty host filters as local, same as a project with no hostId", () => {
      const project = makeProject({ hostId: "" });
      const result = matchProjectByPath([project], "", "/repo");
      expect(result?.project).toBe(project);
    });
  });
});
