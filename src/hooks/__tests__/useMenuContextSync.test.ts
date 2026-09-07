import { describe, it, expect } from "vitest";
import { deriveMenuContext, type MenuAppState } from "../useMenuContextSync";
import { HOME_PATH } from "../../lib/home";
import type {
  ProjectInfo,
  WorkspaceInfo,
  WorkspaceFolder,
} from "../../store/project-store";
import type { AgentInfo, AppPreferences } from "../../electron.d";

const MAIN = "/repo/demo";
const FEATURE = "/repo/demo-feature";

function ws(path: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    path,
    branch: path.split("/").pop() ?? path,
    isMain: false,
    name: null,
    ...extra,
  };
}

function makeProject(
  overrides: Partial<ProjectInfo> = {},
  workspaces: WorkspaceInfo[] = [
    ws(MAIN, { isMain: true, branch: "main" }),
    ws(FEATURE, { name: "Feature", branch: "feature" }),
  ],
  folders: WorkspaceFolder[] = [],
  sidebarOrder: string[] = workspaces.map((w) => w.path),
): ProjectInfo {
  return {
    id: "proj-1",
    name: "Demo",
    path: MAIN,
    worktreeStartScript: null,
    workspaces,
    folders,
    sidebarOrder,
    selectedWorkspaceIndex: 0,
    ...overrides,
  } as unknown as ProjectInfo;
}

function makeAppState(overrides: Partial<MenuAppState> = {}): MenuAppState {
  return {
    activeWorkspacePath: MAIN,
    workspaceLayouts: {
      [MAIN]: {
        panelTree: { type: "leaf", panelId: "panel-1" },
        activePanelId: "panel-1",
        panels: {
          "panel-1": {
            id: "panel-1",
            selectedTabId: "tab-1",
            pinnedTabIds: ["tab-1"],
            tabs: [
              {
                id: "tab-1",
                title: "Terminal",
                rootNode: { type: "leaf", paneId: "pane-1" },
                focusedPaneId: "pane-1",
              },
            ],
          },
        },
      },
    },
    paneContentType: { "pane-1": "diff" },
    paneAgentStatus: {},
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    name: "Refactor",
    status: "active",
    workspacePath: FEATURE,
    ...overrides,
  } as unknown as AgentInfo;
}

const PREFS = { defaultEditor: "Cursor" } as unknown as AppPreferences;

describe("deriveMenuContext", () => {
  it("describes the active workspace and its project", () => {
    const project = makeProject({
      worktreeStartScript: "./setup.sh",
      folders: [{ id: "f1", name: "Archive" }],
    });
    const context = deriveMenuContext(makeAppState(), [project], [], PREFS);

    expect(context.activeWorkspacePath).toBe(MAIN);
    expect(context.isHome).toBe(false);
    expect(context.workspace).toEqual({
      projectId: "proj-1",
      name: "main",
      branch: "main",
      isMain: true,
      folderId: null,
    });
    expect(context.project).toEqual({
      id: "proj-1",
      name: "Demo",
      hasSetupScript: true,
      folders: [{ id: "f1", name: "Archive" }],
    });
    expect(context.editorName).toBe("Cursor");
  });

  it("labels workspaces by name, falling back to the branch", () => {
    const context = deriveMenuContext(
      makeAppState(),
      [makeProject()],
      [],
      PREFS,
    );
    expect(context.projects).toEqual([
      {
        id: "proj-1",
        name: "Demo",
        workspaces: [
          { path: MAIN, label: "main" },
          { path: FEATURE, label: "Feature" },
        ],
      },
    ]);
  });

  it("lists workspaces in sidebar order and drops hidden ones", () => {
    const hidden = ws("/repo/demo-old", { hidden: true });
    const project = makeProject(
      {},
      [ws(MAIN, { isMain: true, branch: "main" }), hidden, ws(FEATURE)],
      [],
      [FEATURE, MAIN, hidden.path],
    );
    const context = deriveMenuContext(makeAppState(), [project], [], PREFS);
    expect(context.projects[0].workspaces.map((w) => w.path)).toEqual([
      FEATURE,
      MAIN,
    ]);
  });

  it("reports Home with no workspace or project", () => {
    const context = deriveMenuContext(
      makeAppState({ activeWorkspacePath: HOME_PATH, workspaceLayouts: {} }),
      [makeProject()],
      [],
      PREFS,
    );
    expect(context.isHome).toBe(true);
    expect(context.workspace).toBeNull();
    expect(context.project).toBeNull();
    expect(context.focusedPane).toBeNull();
    expect(context.activeTab).toBeNull();
    expect(context.panelCount).toBe(0);
  });

  it("reports the focused pane, the active tab and the panel count", () => {
    const context = deriveMenuContext(
      makeAppState(),
      [makeProject()],
      [],
      PREFS,
    );
    expect(context.focusedPane).toEqual({ id: "pane-1", contentType: "diff" });
  });

  it("reports a terminal pane with a detected agent as an agent pane", () => {
    const context = deriveMenuContext(
      makeAppState({
        paneContentType: { "pane-1": "terminal" },
        paneAgentStatus: {
          "pane-1": {
            kind: "claude",
            status: "working",
            processName: "claude",
            since: 0,
            title: null,
          },
        },
      }),
      [makeProject()],
      [],
      PREFS,
    );
    expect(context.focusedPane).toEqual({ id: "pane-1", contentType: "agent" });
    expect(context.activeTab).toEqual({ id: "tab-1", pinned: true });
    expect(context.panelCount).toBe(1);
  });

  it("defaults an unmarked pane to terminal", () => {
    const context = deriveMenuContext(
      makeAppState({ paneContentType: {} }),
      [makeProject()],
      [],
      PREFS,
    );
    expect(context.focusedPane).toEqual({
      id: "pane-1",
      contentType: "terminal",
    });
  });

  it("keeps only active agents and labels them by workspace", () => {
    const context = deriveMenuContext(
      makeAppState(),
      [makeProject()],
      [
        makeAgent(),
        makeAgent({ id: "agent-2", status: "completed" }),
        makeAgent({ id: "agent-3", name: null, workspacePath: null }),
      ],
      PREFS,
    );
    expect(context.agents).toEqual([
      { id: "agent-1", name: "Refactor", workspaceLabel: "Feature" },
      { id: "agent-3", name: "Agent", workspaceLabel: null },
    ]);
  });

  it("reports no editor when the preference is unset", () => {
    const context = deriveMenuContext(makeAppState(), [makeProject()], [], {
      defaultEditor: "",
    } as unknown as AppPreferences);
    expect(context.editorName).toBeNull();
  });
});
