/**
 * The native application menu, as a pure function (ADR-170).
 *
 * `buildMenuTemplate` maps a snapshot of renderer state (`MenuContext`), the
 * user's resolved keybindings and a couple of environment flags onto an
 * Electron menu template. It imports only *types* from `electron`, so the whole
 * tree — labels, enabled/checked state, accelerators — is unit-testable in node.
 * Runtime concerns (building the Menu, routing clicks to a window, rebuilding
 * on change) live in `app-menu.ts`.
 *
 * Accelerator rule: key dispatch is renderer-side, so every keybinding-backed
 * item shows its shortcut with `registerAccelerator: false` — displayed, never
 * registered, so the key still reaches the terminal or a browser pane. The
 * three zoom items are the exception: app zoom is implemented in main, so they
 * keep real registered accelerators.
 */

import type { MenuItemConstructorOptions } from "electron";
import { comboToAccelerator, type KeyCombo } from "../src/lib/keybinding-defs";
import { EXTERNAL_LINKS, type MenuContext } from "../src/lib/menu-commands";

export interface MenuTemplateState {
  context: MenuContext | null;
  bindings: Record<string, KeyCombo>;
  isPackaged: boolean;
  platform: "mac" | "other";
  appName: string;
}

export interface MenuActions {
  send: (commandId: string, args?: Record<string, unknown>) => void;
  zoom: (delta: number | "reset") => void;
  checkForUpdates: () => void;
  openExternal: (url: string) => void;
  revealDataFolder: () => void;
}

interface CmdOptions {
  /** Extra payload sent with the command. */
  args?: Record<string, unknown>;
  enabled?: boolean;
  checked?: boolean;
  type?: "checkbox" | "radio";
  /** Display-only accelerator for items with no keybinding id of their own. */
  accelerator?: string;
}

const SEPARATOR: MenuItemConstructorOptions = { type: "separator" };

type PaneContentType = NonNullable<MenuContext["focusedPane"]>["contentType"];

const PANE_CONTENT_TYPES: { contentType: PaneContentType; label: string }[] = [
  { contentType: "terminal", label: "Terminal" },
  { contentType: "browser", label: "Browser" },
  { contentType: "diff", label: "Diff" },
  { contentType: "agent", label: "Agent" },
];

export function buildMenuTemplate(
  state: MenuTemplateState,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const { context, bindings, isPackaged, platform, appName } = state;
  const isMac = platform === "mac";

  /** The display-only accelerator for a keybinding id, if it has one. */
  const accelFor = (id: string): string | undefined =>
    bindings[id] ? comboToAccelerator(bindings[id], platform) : undefined;

  /** A menu item that fires a renderer command, with its shortcut displayed. */
  const cmd = (
    id: string,
    label: string,
    opts: CmdOptions = {},
  ): MenuItemConstructorOptions => {
    const item: MenuItemConstructorOptions = {
      label,
      click: () => actions.send(id, opts.args),
    };
    const accelerator = opts.accelerator ?? accelFor(id);
    if (accelerator) {
      item.accelerator = accelerator;
      item.registerAccelerator = false;
    }
    if (opts.enabled !== undefined) item.enabled = opts.enabled;
    if (opts.type !== undefined) item.type = opts.type;
    if (opts.checked !== undefined) item.checked = opts.checked;
    return item;
  };

  // ── Derived state ──
  const workspace = context?.workspace ?? null;
  /** Workspace-scoped items: a real workspace is selected and we're not on Home. */
  const hasWorkspace = !!workspace && !context?.isHome;
  const isMainWorkspace = !!workspace?.isMain;
  const hasSurface = !!context?.activeWorkspacePath;
  const focusedPane = context?.focusedPane ?? null;
  const activeTab = context?.activeTab ?? null;
  const editorName = context?.editorName ?? null;

  // ── Manor ──
  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: "about" },
      ...(isPackaged
        ? [
            {
              label: "Check for Updates…",
              click: () => actions.checkForUpdates(),
            } as MenuItemConstructorOptions,
          ]
        : []),
      SEPARATOR,
      cmd("settings", "Settings…"),
      SEPARATOR,
      { role: "services" },
      SEPARATOR,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      SEPARATOR,
      { role: "quit" },
    ],
  };

  // ── File ──
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      cmd("new-agent", "New Agent"),
      cmd("new-tab", "New Tab"),
      cmd("new-browser", "New Browser"),
      cmd("new-workspace", "New Workspace…"),
      cmd("add-project", "Add Project…"),
      SEPARATOR,
      cmd("open-diff", "Open Diff"),
      cmd(
        "open-in-editor",
        editorName ? `Open in ${editorName}` : "Open in Editor",
        {
          enabled: !!editorName,
        },
      ),
      cmd("reveal-in-finder", "Reveal in Finder"),
      SEPARATOR,
      cmd("close-pane", "Close Pane"),
      cmd("close-tab", "Close Tab"),
      cmd("close-panel", "Close Panel"),
      // No accelerator: ⇧⌘W stays Close Tab.
      { label: "Close Window", click: () => actions.send("close-window") },
      cmd("reopen-pane", "Reopen Closed Pane"),
      // Without an app menu, Settings and Quit live at the bottom of File.
      ...(isMac
        ? []
        : [
            SEPARATOR,
            cmd("settings", "Settings…"),
            { role: "quit" } as MenuItemConstructorOptions,
          ]),
    ],
  };

  // ── Edit ──
  // AppKit appends Start Dictation and Emoji & Symbols to this menu itself.
  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      SEPARATOR,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      SEPARATOR,
      // Routed to the focused pane's own search; shows the terminal binding,
      // which browser find shares.
      cmd("find", "Find…", { accelerator: accelFor("terminal-search") }),
      SEPARATOR,
      cmd("copy-branch", "Copy Branch Name"),
      cmd("copy-workspace-path", "Copy Workspace Path"),
    ],
  };

  // ── View ──
  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      cmd("command-palette", "Command Palette"),
      cmd("toggle-sidebar", "Toggle Sidebar"),
      cmd("notifications", "Notifications"),
      cmd("your-issues", "Your Issues"),
      SEPARATOR,
      cmd("home", "Home", { type: "checkbox", checked: !!context?.isHome }),
      cmd("processes", "Processes"),
      cmd("stats", "Stats"),
      SEPARATOR,
      cmd("history-back", "Back"),
      cmd("history-forward", "Forward"),
      SEPARATOR,
      // Registered accelerators: app zoom is implemented in main, and the
      // renderer only claims these keys while a browser pane is focused.
      {
        label: "Actual Size",
        accelerator: "CmdOrCtrl+0",
        click: () => actions.zoom("reset"),
      },
      {
        label: "Zoom In",
        accelerator: "CmdOrCtrl+=",
        click: () => actions.zoom(0.1),
      },
      {
        label: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        click: () => actions.zoom(-0.1),
      },
      SEPARATOR,
      { role: "togglefullscreen" },
      ...(isPackaged
        ? []
        : [
            SEPARATOR,
            {
              label: "Developer",
              submenu: [
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
              ],
            } as MenuItemConstructorOptions,
          ]),
    ],
  };

  // ── Workspace ──
  const projects = context?.projects ?? [];
  const switchWorkspaceSubmenu: MenuItemConstructorOptions[] = projects.length
    ? projects.map((project) => ({
        label: project.name,
        submenu: project.workspaces.map((ws) =>
          cmd("switch-workspace", ws.label, {
            args: { path: ws.path },
            type: "radio",
            checked: ws.path === context?.activeWorkspacePath,
          }),
        ),
      }))
    : [{ label: "No Workspaces", enabled: false }];

  const folders = context?.project?.folders ?? [];
  const moveToFolderSubmenu: MenuItemConstructorOptions[] = [
    ...folders.map((folder) =>
      cmd("move-to-folder", folder.name, {
        args: { folderId: folder.id },
        type: "checkbox",
        checked: workspace?.folderId === folder.id,
      }),
    ),
    ...(folders.length ? [SEPARATOR] : []),
    cmd("move-to-folder", "Remove from Folder", {
      args: { folderId: null },
      enabled: hasWorkspace && !!workspace?.folderId,
    }),
  ];

  const workspaceMenu: MenuItemConstructorOptions = {
    label: "Workspace",
    submenu: [
      { label: "Switch Workspace", submenu: switchWorkspaceSubmenu },
      cmd("next-workspace", "Next Workspace"),
      cmd("prev-workspace", "Previous Workspace"),
      SEPARATOR,
      cmd("rename-workspace", "Rename Workspace", { enabled: hasWorkspace }),
      cmd("hide-workspace", "Hide Workspace", { enabled: hasWorkspace }),
      {
        label: "Move to Folder",
        enabled: hasWorkspace,
        submenu: moveToFolderSubmenu,
      },
      SEPARATOR,
      cmd("merge-worktree", "Merge Worktree…", {
        enabled: hasWorkspace && !isMainWorkspace,
      }),
      cmd("delete-worktree", "Delete Worktree…", {
        enabled: hasWorkspace && !isMainWorkspace,
      }),
      SEPARATOR,
      cmd("project-settings", "Project Settings…", { enabled: hasWorkspace }),
      cmd("remove-project", "Remove Project…", { enabled: hasWorkspace }),
    ],
  };

  // ── Pane ──
  const paneMenu: MenuItemConstructorOptions = {
    label: "Pane",
    submenu: [
      cmd("split-h", "Split Horizontal", { enabled: hasSurface }),
      cmd("split-v", "Split Vertical", { enabled: hasSurface }),
      {
        label: "Split With",
        enabled: hasSurface,
        submenu: PANE_CONTENT_TYPES.map(({ contentType, label }) =>
          cmd("split-with", label, { args: { contentType } }),
        ),
      },
      {
        label: "Convert To",
        enabled: hasSurface && !!focusedPane,
        submenu: PANE_CONTENT_TYPES.map(({ contentType, label }) =>
          cmd("convert-to", label, {
            args: { contentType },
            type: "radio",
            checked: focusedPane?.contentType === contentType,
          }),
        ),
      },
      SEPARATOR,
      cmd("next-pane", "Next Pane", { enabled: hasSurface }),
      cmd("prev-pane", "Previous Pane", { enabled: hasSurface }),
      SEPARATOR,
      cmd("split-panel-right", "Split Panel Right", { enabled: hasSurface }),
      cmd("split-panel-down", "Split Panel Down", { enabled: hasSurface }),
      cmd("focus-next-panel", "Next Panel", { enabled: hasSurface }),
      cmd("focus-prev-panel", "Previous Panel", { enabled: hasSurface }),
      cmd("move-tab-to-next-panel", "Move Tab to Next Panel", {
        enabled: hasSurface && (context?.panelCount ?? 0) >= 2,
      }),
      SEPARATOR,
      cmd("detach-pane", "Move Pane to New Window", {
        enabled: hasSurface && !!focusedPane,
      }),
    ],
  };

  // ── Agents ──
  const agents = context?.agents ?? [];
  const agentItems: MenuItemConstructorOptions[] = agents.length
    ? agents.map((agent) =>
        cmd(
          "focus-agent",
          `${agent.name} — ${agent.workspaceLabel ?? "Home"}`,
          {
            args: { agentId: agent.id },
          },
        ),
      )
    : [{ label: "No Active Agents", enabled: false }];

  const agentsMenu: MenuItemConstructorOptions = {
    label: "Agents",
    submenu: [
      cmd("new-agent", "New Agent"),
      cmd("run-setup-script", "Run Setup Script", {
        enabled: !!context?.project?.hasSetupScript,
      }),
      cmd("view-all-agents", "View All Agents…"),
      SEPARATOR,
      ...agentItems,
      SEPARATOR,
      cmd("remote-control", "Remote Control…"),
    ],
  };

  // ── Window ──
  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    role: "window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      SEPARATOR,
      cmd("next-tab", "Next Tab"),
      cmd("prev-tab", "Previous Tab"),
      cmd("pin-tab", activeTab?.pinned ? "Unpin Tab" : "Pin Tab", {
        enabled: !!activeTab,
      }),
      cmd("detach-tab", "Move Tab to New Window", { enabled: !!activeTab }),
      SEPARATOR,
      { role: "front" },
    ],
  };

  // ── Help ──
  // role: "help" is what makes macOS add the Help search field.
  const helpMenu: MenuItemConstructorOptions = {
    label: "Help",
    role: "help",
    submenu: [
      {
        label: "Manor Help",
        click: () => actions.openExternal(EXTERNAL_LINKS.docs),
      },
      cmd("help-shortcuts", "Keyboard Shortcuts…"),
      {
        label: "Release Notes",
        click: () => actions.openExternal(EXTERNAL_LINKS.releaseNotes),
      },
      SEPARATOR,
      cmd("submit-feedback", "Submit Feedback…"),
      {
        label: "Report an Issue on GitHub",
        click: () => actions.openExternal(EXTERNAL_LINKS.newIssue),
      },
      SEPARATOR,
      { label: "Reveal Data Folder", click: () => actions.revealDataFolder() },
      // Dev builds have this under View › Developer.
      ...(isPackaged
        ? [{ role: "toggleDevTools" } as MenuItemConstructorOptions]
        : []),
      SEPARATOR,
      cmd("ghosts", "Ghosts!?"),
    ],
  };

  return [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    workspaceMenu,
    paneMenu,
    agentsMenu,
    windowMenu,
    helpMenu,
  ];
}
