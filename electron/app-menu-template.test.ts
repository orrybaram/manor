import { describe, it, expect, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  buildMenuTemplate,
  type MenuActions,
  type MenuTemplateState,
} from "./app-menu-template";
import { resolveBindings } from "../src/lib/keybinding-defs";
import type { MenuContext } from "../src/lib/menu-commands";

function makeContext(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    activeWorkspacePath: "/repo/feature",
    isHome: false,
    workspace: {
      projectId: "proj-1",
      name: "feature",
      branch: "feature/xyz",
      isMain: false,
      folderId: null,
    },
    project: {
      id: "proj-1",
      name: "Manor",
      hasSetupScript: false,
      folders: [{ id: "folder-1", name: "Active", parentId: null }],
    },
    projects: [
      {
        id: "proj-1",
        name: "Manor",
        workspaces: [
          { path: "/repo/main", label: "main" },
          { path: "/repo/feature", label: "feature" },
        ],
      },
    ],
    agents: [],
    focusedPane: { id: "pane-1", contentType: "terminal" },
    activeTab: { id: "tab-1", pinned: false },
    panelCount: 1,
    editorName: "Cursor",
    ...overrides,
  };
}

function makeActions(overrides: Partial<MenuActions> = {}): MenuActions {
  return {
    send: vi.fn(),
    zoom: vi.fn(),
    checkForUpdates: vi.fn(),
    openExternal: vi.fn(),
    revealDataFolder: vi.fn(),
    ...overrides,
  };
}

function makeState(
  overrides: Partial<MenuTemplateState> = {},
): MenuTemplateState {
  return {
    context: makeContext(),
    bindings: resolveBindings({}, "MacIntel").bindings,
    isPackaged: false,
    platform: "mac",
    appName: "Manor",
    ...overrides,
  };
}

function build(
  state: Partial<MenuTemplateState> = {},
  actions: MenuActions = makeActions(),
) {
  return buildMenuTemplate(makeState(state), actions);
}

/** Submenu of a template item, as an array (never a Menu instance here). */
function submenu(
  item: MenuItemConstructorOptions | undefined,
): MenuItemConstructorOptions[] {
  return (item?.submenu as MenuItemConstructorOptions[]) ?? [];
}

function menu(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  return submenu(template.find((m) => m.label === label));
}

function item(
  items: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  return items.find((i) => i.label === label);
}

/** Depth-first walk of every item in the template, submenus included. */
function walk(
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...walk(submenu(i))]);
}

function click(entry: MenuItemConstructorOptions | undefined): void {
  (entry?.click as unknown as () => void)();
}

describe("buildMenuTemplate", () => {
  it("lays out the top-level menus in order", () => {
    expect(build().map((m) => m.label)).toEqual([
      "Manor",
      "File",
      "Edit",
      "View",
      "Workspace",
      "Pane",
      "Agents",
      "Window",
      "Help",
    ]);
  });

  it("omits the app menu off macOS and moves Settings into File", () => {
    const template = build({ platform: "other" });
    expect(template.map((m) => m.label)).toEqual([
      "File",
      "Edit",
      "View",
      "Workspace",
      "Pane",
      "Agents",
      "Window",
      "Help",
    ]);
    const file = menu(template, "File");
    expect(item(file, "Settings…")).toBeDefined();
    expect(file[file.length - 1]).toMatchObject({ role: "quit" });
  });

  it("puts Settings… in the app menu with a display-only Cmd+, ", () => {
    const settings = item(menu(build(), "Manor"), "Settings…");
    expect(settings?.accelerator).toBe("Cmd+,");
    expect(settings?.registerAccelerator).toBe(false);
  });

  it("shows the user's binding for New Agent", () => {
    expect(item(menu(build(), "File"), "New Agent")?.accelerator).toBe("Cmd+N");

    const rebound = build({
      bindings: resolveBindings({ "new-agent": "meta+shift+a" }, "MacIntel")
        .bindings,
    });
    expect(item(menu(rebound, "File"), "New Agent")?.accelerator).toBe(
      "Cmd+Shift+A",
    );
  });

  it("labels Open in <Editor> from the preference and disables it when unset", () => {
    expect(item(menu(build(), "File"), "Open in Cursor")?.enabled).toBe(true);

    const noEditor = build({ context: makeContext({ editorName: null }) });
    expect(item(menu(noEditor, "File"), "Open in Editor")?.enabled).toBe(false);
  });

  it("leaves Close Window without an accelerator", () => {
    const closeWindow = item(menu(build(), "File"), "Close Window");
    expect(closeWindow?.accelerator).toBeUndefined();
  });

  describe("Workspace menu", () => {
    it("disables workspace items with no context", () => {
      const workspace = menu(build({ context: null }), "Workspace");
      expect(item(workspace, "Rename Workspace")?.enabled).toBe(false);
    });

    it("disables workspace items on Home", () => {
      const workspace = menu(
        build({ context: makeContext({ isHome: true }) }),
        "Workspace",
      );
      expect(item(workspace, "Rename Workspace")?.enabled).toBe(false);
    });

    it("enables workspace items for a real workspace", () => {
      const workspace = menu(build(), "Workspace");
      expect(item(workspace, "Rename Workspace")?.enabled).toBe(true);
      expect(item(workspace, "Merge Worktree…")?.enabled).toBe(true);
    });

    it("disables Merge/Delete Worktree for the main workspace", () => {
      const template = build({
        context: makeContext({
          workspace: {
            projectId: "proj-1",
            name: "main",
            branch: "main",
            isMain: true,
            folderId: null,
          },
        }),
      });
      const workspace = menu(template, "Workspace");
      expect(item(workspace, "Merge Worktree…")?.enabled).toBe(false);
      expect(item(workspace, "Delete Worktree…")?.enabled).toBe(false);
      expect(item(workspace, "Rename Workspace")?.enabled).toBe(true);
    });

    it("lists projects in Switch Workspace and radio-checks the active path", () => {
      const workspace = menu(build(), "Workspace");
      const projects = submenu(item(workspace, "Switch Workspace"));
      expect(projects.map((p) => p.label)).toEqual(["Manor"]);

      const workspaces = submenu(projects[0]);
      expect(workspaces.map((w) => w.label)).toEqual(["main", "feature"]);
      expect(workspaces.every((w) => w.type === "radio")).toBe(true);
      expect(item(workspaces, "main")?.checked).toBe(false);
      expect(item(workspaces, "feature")?.checked).toBe(true);
    });

    it("sends switch-workspace with the clicked path", () => {
      const actions = makeActions();
      const template = build({}, actions);
      const projects = submenu(
        item(menu(template, "Workspace"), "Switch Workspace"),
      );
      click(item(submenu(projects[0]), "main"));
      expect(actions.send).toHaveBeenCalledWith("switch-workspace", {
        path: "/repo/main",
      });
    });

    it("falls back to a disabled No Workspaces item", () => {
      const template = build({ context: makeContext({ projects: [] }) });
      const entries = submenu(
        item(menu(template, "Workspace"), "Switch Workspace"),
      );
      expect(entries).toEqual([{ label: "No Workspaces", enabled: false }]);
    });

    it("checks the current folder and enables Remove from Folder only inside one", () => {
      const inFolder = build({
        context: makeContext({
          workspace: {
            projectId: "proj-1",
            name: "feature",
            branch: "feature/xyz",
            isMain: false,
            folderId: "folder-1",
          },
        }),
      });
      const entries = submenu(
        item(menu(inFolder, "Workspace"), "Move to Folder"),
      );
      expect(item(entries, "Active")?.checked).toBe(true);
      expect(item(entries, "Remove from Folder")?.enabled).toBe(true);

      const outside = submenu(
        item(menu(build(), "Workspace"), "Move to Folder"),
      );
      expect(item(outside, "Active")?.checked).toBe(false);
      expect(item(outside, "Remove from Folder")?.enabled).toBe(false);
    });
  });

  describe("Pane menu", () => {
    it("disables the group with no active workspace", () => {
      const pane = menu(
        build({ context: makeContext({ activeWorkspacePath: null }) }),
        "Pane",
      );
      expect(item(pane, "Split Horizontal")?.enabled).toBe(false);
      expect(item(pane, "Next Pane")?.enabled).toBe(false);
    });

    it("radio-checks Convert To on the focused pane's type", () => {
      const convert = submenu(item(menu(build(), "Pane"), "Convert To"));
      expect(convert.map((c) => c.label)).toEqual([
        "Terminal",
        "Browser",
        "Diff",
        "Agent",
      ]);
      expect(item(convert, "Terminal")?.checked).toBe(true);
      expect(item(convert, "Browser")?.checked).toBe(false);
    });

    it("disables Convert To and Move Pane to New Window with no focused pane", () => {
      const pane = menu(
        build({ context: makeContext({ focusedPane: null }) }),
        "Pane",
      );
      expect(item(pane, "Convert To")?.enabled).toBe(false);
      expect(item(pane, "Move Pane to New Window")?.enabled).toBe(false);
    });

    it("disables Move Tab to Next Panel with a single panel", () => {
      expect(
        item(menu(build(), "Pane"), "Move Tab to Next Panel")?.enabled,
      ).toBe(false);
      const twoPanels = build({ context: makeContext({ panelCount: 2 }) });
      expect(
        item(menu(twoPanels, "Pane"), "Move Tab to Next Panel")?.enabled,
      ).toBe(true);
    });

    it("sends split-with with the chosen content type", () => {
      const actions = makeActions();
      const splitWith = submenu(
        item(menu(build({}, actions), "Pane"), "Split With"),
      );
      click(item(splitWith, "Browser"));
      expect(actions.send).toHaveBeenCalledWith("split-with", {
        contentType: "browser",
      });
    });
  });

  describe("Agents menu", () => {
    it("shows a disabled placeholder with no active agents", () => {
      const agents = menu(build(), "Agents");
      expect(item(agents, "No Active Agents")?.enabled).toBe(false);
    });

    it("lists active agents with their workspace and focuses on click", () => {
      const actions = makeActions();
      const template = build(
        {
          context: makeContext({
            agents: [
              { id: "a1", name: "Claude", workspaceLabel: "feature" },
              { id: "a2", name: "Codex", workspaceLabel: null },
            ],
          }),
        },
        actions,
      );
      const agents = menu(template, "Agents");
      expect(item(agents, "Claude — feature")).toBeDefined();
      click(item(agents, "Codex — Home"));
      expect(actions.send).toHaveBeenCalledWith("focus-agent", {
        agentId: "a2",
      });
    });

    it("enables Run Setup Script only when the project has one", () => {
      expect(item(menu(build(), "Agents"), "Run Setup Script")?.enabled).toBe(
        false,
      );
      const withScript = build({
        context: makeContext({
          project: {
            id: "proj-1",
            name: "Manor",
            hasSetupScript: true,
            folders: [],
          },
        }),
      });
      expect(
        item(menu(withScript, "Agents"), "Run Setup Script")?.enabled,
      ).toBe(true);
    });
  });

  describe("Window menu", () => {
    it("flips Pin Tab to Unpin Tab for a pinned tab", () => {
      expect(item(menu(build(), "Window"), "Pin Tab")).toBeDefined();
      const pinned = build({
        context: makeContext({ activeTab: { id: "tab-1", pinned: true } }),
      });
      expect(item(menu(pinned, "Window"), "Unpin Tab")).toBeDefined();
      expect(item(menu(pinned, "Window"), "Pin Tab")).toBeUndefined();
    });

    it("disables tab items with no active tab", () => {
      const windowMenu = menu(
        build({ context: makeContext({ activeTab: null }) }),
        "Window",
      );
      expect(item(windowMenu, "Pin Tab")?.enabled).toBe(false);
      expect(item(windowMenu, "Move Tab to New Window")?.enabled).toBe(false);
    });

    it("uses role: window so AppKit appends the window list", () => {
      expect(build().find((m) => m.label === "Window")?.role).toBe("window");
    });
  });

  describe("build flavour", () => {
    it("shows the Developer submenu only in dev builds", () => {
      expect(item(menu(build(), "View"), "Developer")).toBeDefined();
      expect(
        submenu(item(menu(build(), "View"), "Developer")).map((i) => i.role),
      ).toEqual(["reload", "forceReload", "toggleDevTools"]);
      expect(
        item(menu(build({ isPackaged: true }), "View"), "Developer"),
      ).toBeUndefined();
    });

    it("shows Check for Updates… only in packaged builds", () => {
      expect(
        item(menu(build(), "Manor"), "Check for Updates…"),
      ).toBeUndefined();
      const packaged = build({ isPackaged: true });
      expect(item(menu(packaged, "Manor"), "Check for Updates…")).toBeDefined();
    });

    it("moves Toggle Developer Tools into Help for packaged builds", () => {
      const packaged = menu(build({ isPackaged: true }), "Help");
      expect(packaged.some((i) => i.role === "toggleDevTools")).toBe(true);
      expect(
        menu(build(), "Help").some((i) => i.role === "toggleDevTools"),
      ).toBe(false);
    });
  });

  describe("Help menu", () => {
    it("opens external links and reveals the data folder", () => {
      const actions = makeActions();
      const help = menu(build({}, actions), "Help");
      click(item(help, "Manor Help"));
      click(item(help, "Release Notes"));
      click(item(help, "Report an Issue on GitHub"));
      click(item(help, "Reveal Data Folder"));
      expect(actions.openExternal).toHaveBeenCalledTimes(3);
      expect(actions.revealDataFolder).toHaveBeenCalledTimes(1);
      expect(build().find((m) => m.label === "Help")?.role).toBe("help");
    });
  });

  describe("accelerators", () => {
    it("registers the zoom accelerators and applies them to the focused window", () => {
      const actions = makeActions();
      const view = menu(build({}, actions), "View");
      for (const [label, accelerator] of [
        ["Actual Size", "CmdOrCtrl+0"],
        ["Zoom In", "CmdOrCtrl+="],
        ["Zoom Out", "CmdOrCtrl+-"],
      ]) {
        const entry = item(view, label);
        expect(entry?.accelerator).toBe(accelerator);
        expect(entry?.registerAccelerator).toBeUndefined();
      }
      click(item(view, "Actual Size"));
      click(item(view, "Zoom In"));
      click(item(view, "Zoom Out"));
      expect(actions.zoom).toHaveBeenNthCalledWith(1, "reset");
      expect(actions.zoom).toHaveBeenNthCalledWith(2, 0.1);
      expect(actions.zoom).toHaveBeenNthCalledWith(3, -0.1);
    });

    it("keeps every command accelerator display-only", () => {
      const zoomLabels = new Set(["Actual Size", "Zoom In", "Zoom Out"]);
      const offenders = walk(build())
        .filter((i) => i.accelerator && !zoomLabels.has(String(i.label)))
        .filter((i) => i.registerAccelerator !== false)
        .map((i) => i.label);
      expect(offenders).toEqual([]);
    });

    it("shows the terminal search binding on Find…", () => {
      expect(item(menu(build(), "Edit"), "Find…")?.accelerator).toBe("Cmd+F");
      expect(item(menu(build(), "Edit"), "Find…")?.registerAccelerator).toBe(
        false,
      );
    });
  });
});
