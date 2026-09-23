import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMenuHandlers,
  dispatchMenuCommand,
  orderedWorkspacePaths,
  type MenuChrome,
} from "../menu-handlers";
import { COMMANDS } from "../commands";
import { SHARED_WINDOW_COMMANDS } from "../menu-commands";
import { HOME_PATH } from "../home";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import type {
  ProjectInfo,
  WorkspaceInfo,
  WorkspaceFolder,
} from "../../store/project-store";
import type { WorkspaceLayout, Tab, Panel } from "../../store/app-store";

const WS_PATH = "/repo/main";

function makeChrome(): MenuChrome {
  return {
    openSettings: vi.fn(),
    togglePalette: vi.fn(),
    openPaletteView: vi.fn(),
    openNewWorkspace: vi.fn(),
    addProject: vi.fn(),
    openFeedback: vi.fn(),
    openAgents: vi.fn(),
    openProjectSettings: vi.fn(),
    resumeAgent: vi.fn(),
    showGhosts: vi.fn(),
  };
}

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
  id: string,
  workspaces: WorkspaceInfo[],
  folders: WorkspaceFolder[] = [],
  sidebarOrder: string[] = workspaces.map((w) => w.path),
): ProjectInfo {
  return {
    id,
    name: id,
    path: `/repo/${id}`,
    workspaces,
    folders,
    sidebarOrder,
    selectedWorkspaceIndex: 0,
  } as unknown as ProjectInfo;
}

function makeLayout(tab: Tab): WorkspaceLayout {
  const panel: Panel = {
    id: "panel-1",
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
  };
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [],
    selectedProjectIndex: 0,
    sidebarVisible: true,
  });
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: {
      [WS_PATH]: makeLayout({
        id: "tab-1",
        title: "Terminal",
        rootNode: { type: "leaf", paneId: "pane-1" },
      }),
    },
  });
});

describe("orderedWorkspacePaths", () => {
  it("puts Home first and follows the sidebar order", () => {
    const projects = [
      makeProject(
        "a",
        [ws("/repo/a/one"), ws("/repo/a/two")],
        [],
        ["/repo/a/two", "/repo/a/one"],
      ),
      makeProject("b", [ws("/repo/b/one")]),
    ];
    expect(orderedWorkspacePaths(projects)).toEqual([
      HOME_PATH,
      "/repo/a/two",
      "/repo/a/one",
      "/repo/b/one",
    ]);
  });

  it("flattens folder members into the folder's slot", () => {
    const projects = [
      makeProject(
        "a",
        [
          ws("/repo/a/loose"),
          ws("/repo/a/in-folder", { folderId: "f1" }),
          ws("/repo/a/last"),
        ],
        [{ id: "f1", name: "Folder", parentId: null }],
        ["/repo/a/loose", "f1", "/repo/a/in-folder", "/repo/a/last"],
      ),
    ];
    expect(orderedWorkspacePaths(projects)).toEqual([
      HOME_PATH,
      "/repo/a/loose",
      "/repo/a/in-folder",
      "/repo/a/last",
    ]);
  });

  it("flattens a nested folder's members too", () => {
    const projects = [
      makeProject(
        "a",
        [
          ws("/repo/a/loose"),
          ws("/repo/a/in-folder", { folderId: "f1" }),
          ws("/repo/a/deep", { folderId: "f2" }),
          ws("/repo/a/last"),
        ],
        [
          { id: "f1", name: "Epic", parentId: null },
          { id: "f2", name: "Api", parentId: "f1" },
        ],
        [
          "/repo/a/loose",
          "f1",
          "/repo/a/in-folder",
          "f2",
          "/repo/a/deep",
          "/repo/a/last",
        ],
      ),
    ];
    expect(orderedWorkspacePaths(projects)).toEqual([
      HOME_PATH,
      "/repo/a/loose",
      "/repo/a/in-folder",
      "/repo/a/deep",
      "/repo/a/last",
    ]);
  });

  it("excludes hidden workspaces", () => {
    const projects = [
      makeProject("a", [
        ws("/repo/a/one"),
        ws("/repo/a/hidden", { hidden: true }),
      ]),
    ];
    expect(orderedWorkspacePaths(projects)).toEqual([HOME_PATH, "/repo/a/one"]);
  });
});

describe("workspace stepping", () => {
  const selectWorkspace = vi.fn();

  beforeEach(() => {
    selectWorkspace.mockClear();
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...window.electronAPI,
        projects: { selectWorkspace },
      },
    });
    useProjectStore.setState({
      projects: [makeProject("a", [ws("/repo/a/one"), ws("/repo/a/two")])],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("next-workspace moves down the list", () => {
    useAppStore.setState({ activeWorkspacePath: "/repo/a/one" });
    createMenuHandlers(makeChrome())["next-workspace"]();
    expect(selectWorkspace).toHaveBeenCalledWith("a", 1);
    expect(useAppStore.getState().activeWorkspacePath).toBe("/repo/a/two");
  });

  it("next-workspace wraps past the last workspace back to Home", () => {
    useAppStore.setState({ activeWorkspacePath: "/repo/a/two" });
    createMenuHandlers(makeChrome())["next-workspace"]();
    expect(useAppStore.getState().activeWorkspacePath).toBe(HOME_PATH);
  });

  it("prev-workspace wraps from Home to the last workspace", () => {
    useAppStore.setState({ activeWorkspacePath: HOME_PATH });
    createMenuHandlers(makeChrome())["prev-workspace"]();
    expect(selectWorkspace).toHaveBeenCalledWith("a", 1);
    expect(useAppStore.getState().activeWorkspacePath).toBe("/repo/a/two");
  });

  it("switch-workspace selects the project that owns the path", () => {
    createMenuHandlers(makeChrome())["switch-workspace"]({
      path: "/repo/a/two",
    });
    expect(selectWorkspace).toHaveBeenCalledWith("a", 1);
  });
});

describe("createMenuHandlers", () => {
  it("runs every table command that has a run", () => {
    const handlers = createMenuHandlers(makeChrome());
    for (const def of COMMANDS) {
      if (def.run) expect(handlers[def.id], def.id).toBeTypeOf("function");
      else expect(handlers[def.id], def.id).toBeUndefined();
    }
    // Terminal search is serviced by the focused terminal itself (Edit ›
    // Find… sends `find` instead), so its key must fall through.
    expect(handlers["terminal-search"]).toBeUndefined();
  });

  it("keeps a popout's map to the shared-window commands", () => {
    const handlers = createMenuHandlers(makeChrome(), { primary: false });
    expect(Object.keys(handlers).sort()).toEqual(
      [...SHARED_WINDOW_COMMANDS].sort(),
    );
  });

  it("opens help links with openExternal, which also works on the web", () => {
    const openExternal = vi.fn();
    vi.stubGlobal("window", {
      ...window,
      electronAPI: { ...window.electronAPI, shell: { openExternal } },
    });
    try {
      createMenuHandlers(makeChrome())["help-docs"]();
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/orrybaram/manor#readme",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves native-only commands out of the web app's map", () => {
    vi.stubGlobal("window", {
      ...window,
      electronAPI: { ...window.electronAPI, platform: "web" },
    });
    try {
      const handlers = createMenuHandlers(makeChrome());
      expect(handlers["add-project"]).toBeUndefined();
      expect(handlers["detach-tab"]).toBeUndefined();
      expect(handlers["open-in-editor"]).toBeUndefined();
      expect(handlers["help-docs"]).toBeTypeOf("function");
      expect(handlers["new-tab"]).toBeTypeOf("function");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes chrome commands to the App callbacks", () => {
    const chrome = makeChrome();
    const handlers = createMenuHandlers(chrome);

    handlers["add-project"]();
    handlers["view-all-agents"]();
    handlers["help-shortcuts"]();
    handlers["remote-control"]();
    handlers["focus-agent"]({ agentId: "agent-7" });
    handlers["stats"]();

    expect(chrome.addProject).toHaveBeenCalled();
    expect(chrome.openAgents).toHaveBeenCalled();
    expect(chrome.openSettings).toHaveBeenCalledWith("keybindings");
    expect(chrome.openSettings).toHaveBeenCalledWith("remote");
    expect(chrome.resumeAgent).toHaveBeenCalledWith("agent-7");
    expect(chrome.openPaletteView).toHaveBeenCalledWith("stats");
  });

  it("un-hides the sidebar before asking it to rename a workspace", () => {
    useProjectStore.setState({
      projects: [makeProject("a", [ws(WS_PATH)])],
      sidebarVisible: false,
    });
    createMenuHandlers(makeChrome())["rename-workspace"]();
    expect(useProjectStore.getState().sidebarVisible).toBe(true);
  });
});

describe("dispatchMenuCommand", () => {
  it("runs the named handler with the payload's args", () => {
    const handler = vi.fn();
    dispatchMenuCommand(
      { commandId: "switch-workspace", args: { path: "/repo/a/one" } },
      { "switch-workspace": handler },
    );
    expect(handler).toHaveBeenCalledWith({ path: "/repo/a/one" });
  });

  it("warns once for an unknown command id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatchMenuCommand({ commandId: "not-a-command" }, {});
    dispatchMenuCommand({ commandId: "not-a-command" }, {});
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
