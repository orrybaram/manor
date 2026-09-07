/**
 * Renderer-side dispatch for the native application menu (ADR-170 §6).
 *
 * `createMenuHandlers` builds one command→action map for the primary window:
 * the window-agnostic keybinding handlers, the primary-only keybinding handlers
 * that used to live inline in `App`, and the menu-only commands that have no
 * keybinding at all. `App` uses the same map for key dispatch, so a command can
 * never work from the keyboard and be dead in the menu (or the reverse).
 *
 * Every handler reads `getState()` rather than React state — the map is built
 * outside the render cycle and `chrome` is the only React-owned surface it
 * touches. Actions that live in component-local state (dialogs, popovers, pane
 * search) go out over the `ui-request` bus instead.
 */

import { useAppStore } from "../store/app-store";
import {
  useProjectStore,
  runWorkspaceSetupScript,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../store/project-store";
import { useToastStore } from "../store/toast-store";
import { hideWorkspaceAndNavigate } from "../store/workspace-actions";
import {
  createSharedKeybindingHandlers,
  resolveWorkspaceCommand,
} from "./keybinding-commands";
import {
  convertFocusedPaneTo,
  getFocusedPaneId,
  splitFocusedPaneWith,
  type PaneContentType,
} from "./pane-actions";
import { detachTabToNewWindow, movePaneToNewWindow } from "./window-handoff";
import { openInEditor } from "./editor";
import { HOME_PATH } from "./home";
import { EXTERNAL_LINKS, type MenuCommandPayload } from "./menu-commands";
import { requestUi } from "../utils/ui-request";
import {
  buildSidebarItems,
  placeAfterFolder,
  placeInFolder,
} from "../utils/sidebar-items";
import { navigateBack, navigateForward } from "../hooks/useNavigationHistory";
import type { SettingsPageId } from "../components/settings/SettingsModal/SettingsModal";
import type { PaletteView } from "../components/command-palette/types";

/**
 * The `App`-owned chrome a menu command may need. Everything else is reachable
 * from a store; these are React state that only `App` can drive.
 */
export interface MenuChrome {
  openSettings: (page?: SettingsPageId) => void;
  togglePalette: () => void;
  openPaletteView: (view: PaletteView) => void;
  openNewWorkspace: () => void;
  addProject: () => void;
  openFeedback: () => void;
  openAgents: () => void;
  openProjectSettings: (projectId: string) => void;
  resumeAgent: (agentId: string) => void;
  showGhosts: () => void;
}

/** Menu commands carry optional args (a workspace path, a folder id, …). */
export type MenuHandler = (args?: Record<string, unknown>) => void;

interface ActiveWorkspace {
  project: ProjectInfo | null;
  workspace: WorkspaceInfo | null;
  path: string | null;
}

/** The active surface, resolved back to its owning project and workspace. */
function activeWorkspace(): ActiveWorkspace {
  const path = useAppStore.getState().activeWorkspacePath;
  const project =
    useProjectStore
      .getState()
      .projects.find((p) => p.workspaces.some((w) => w.path === path)) ?? null;
  const workspace = project?.workspaces.find((w) => w.path === path) ?? null;
  return { project, workspace, path };
}

/** The selected tab of the active panel, if any. */
function activeTabId(): string | null {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
  return layout?.panels[layout.activePanelId]?.selectedTabId ?? null;
}

/** A string arg, or null when the menu sent nothing usable. */
function stringArg(
  args: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = args?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Every workspace the menu can switch between, in the order the sidebar shows
 * them: Home first, then each project's visible workspaces with folder members
 * flattened into the folder's slot.
 */
export function orderedWorkspacePaths(projects: ProjectInfo[]): string[] {
  const paths: string[] = [HOME_PATH];
  for (const project of projects) {
    for (const item of buildSidebarItems(project)) {
      if (item.kind === "folder") {
        for (const ws of item.workspaces) paths.push(ws.path);
      } else {
        paths.push(item.ws.path);
      }
    }
  }
  return paths;
}

/** Switch to a workspace by path, keeping the project selection in sync. */
function switchToWorkspace(path: string): void {
  const projects = useProjectStore.getState().projects;
  for (const project of projects) {
    const index = project.workspaces.findIndex((w) => w.path === path);
    if (index >= 0) {
      useProjectStore.getState().selectWorkspace(project.id, index);
      return;
    }
  }
  // Home, or a path no project claims — activate it directly.
  useAppStore.getState().setActiveWorkspace(path);
}

/** Step through `orderedWorkspacePaths` with wrap-around. */
function stepWorkspace(delta: 1 | -1): void {
  const paths = orderedWorkspacePaths(useProjectStore.getState().projects);
  if (paths.length === 0) return;
  const current = useAppStore.getState().activeWorkspacePath;
  const index = current ? paths.indexOf(current) : -1;
  // Nothing active (or an unlisted surface): "next" starts at the top.
  const from = index === -1 ? (delta === 1 ? -1 : 0) : index;
  switchToWorkspace(paths[(from + delta + paths.length) % paths.length]);
}

/**
 * The sidebar owns the rename / merge / delete / remove-project flows, so a
 * hidden sidebar would swallow the request (its `ProjectItem`s are unmounted).
 */
function ensureSidebarVisible(): void {
  const store = useProjectStore.getState();
  if (!store.sidebarVisible) store.toggleSidebar();
}

function copyToClipboard(text: string, label: string): void {
  void navigator.clipboard.writeText(text);
  useToastStore.getState().addToast({
    id: `${label}-${Date.now()}`,
    message: `Copied "${text}"`,
    status: "success",
  });
}

/**
 * The full command→action map for the primary window.
 *
 * Shared keybinding handlers first, so the primary-only entries below can
 * override the ones that need this window's chrome (`close-tab`).
 */
export function createMenuHandlers(
  chrome: MenuChrome,
): Record<string, MenuHandler> {
  const app = () => useAppStore.getState();

  return {
    ...createSharedKeybindingHandlers({ prewarmNewAgent: true }),

    // ── Primary-window keybindings ─────────────────────────────────────────
    settings: () => chrome.openSettings(),
    "command-palette": () => chrome.togglePalette(),
    "toggle-sidebar": () => useProjectStore.getState().toggleSidebar(),
    "history-back": () => navigateBack(),
    "history-forward": () => navigateForward(),
    "new-workspace": () => chrome.openNewWorkspace(),
    "close-tab": () => {
      const tabId = activeTabId();
      if (tabId) app().requestCloseTab(tabId);
    },

    // ── File ──────────────────────────────────────────────────────────────
    "add-project": () => chrome.addProject(),
    "open-in-editor": () => {
      const { path } = activeWorkspace();
      if (path) openInEditor(path);
    },
    "reveal-in-finder": () => {
      const { path } = activeWorkspace();
      if (path) void window.electronAPI.shell.showItemInFolder(path);
    },
    // Main routes this to whichever window has focus; closing it is all the
    // renderer has to do.
    "close-window": () => window.close(),

    // ── Edit ──────────────────────────────────────────────────────────────
    find: () => {
      const paneId = getFocusedPaneId();
      if (paneId) requestUi({ type: "pane-search", paneId });
    },
    "copy-workspace-path": () => {
      const { path } = activeWorkspace();
      if (path) copyToClipboard(path, "copy-workspace-path");
    },

    // ── View ──────────────────────────────────────────────────────────────
    notifications: () => requestUi({ type: "open-notifications" }),
    "your-issues": () => {
      // Linear when the active project is linked to a team, else GitHub —
      // the same choice `useIssuesShortcut` makes for the empty states.
      const { project } = activeWorkspace();
      const projectStore = useProjectStore.getState();
      const fallback = projectStore.projects[projectStore.selectedProjectIndex];
      const linked =
        ((project ?? fallback)?.linearAssociations?.length ?? 0) > 0;
      chrome.openPaletteView(linked ? "linear-all" : "github-all");
    },
    home: () => app().setActiveWorkspace(HOME_PATH),
    processes: () => chrome.openPaletteView("processes"),
    stats: () => chrome.openPaletteView("stats"),

    // ── Workspace ─────────────────────────────────────────────────────────
    "switch-workspace": (args) => {
      const path = stringArg(args, "path");
      if (path) switchToWorkspace(path);
    },
    "next-workspace": () => stepWorkspace(1),
    "prev-workspace": () => stepWorkspace(-1),
    "rename-workspace": () => {
      const { project, path } = activeWorkspace();
      if (!project || !path) return;
      ensureSidebarVisible();
      requestUi({ type: "rename-workspace", projectId: project.id, path });
    },
    "hide-workspace": () => {
      const { project, path } = activeWorkspace();
      if (project && path) hideWorkspaceAndNavigate(project.id, path);
    },
    "move-to-folder": (args) => {
      const { project, workspace, path } = activeWorkspace();
      if (!project || !workspace || !path) return;
      const folderId = stringArg(args, "folderId");
      const items = buildSidebarItems(project);
      const next = folderId
        ? placeInFolder(items, path, folderId)
        : workspace.folderId
          ? placeAfterFolder(items, path, workspace.folderId)
          : items;
      void useProjectStore.getState().applySidebarChange(project.id, next);
    },
    "merge-worktree": () => {
      const { project, path } = activeWorkspace();
      if (!project || !path) return;
      ensureSidebarVisible();
      requestUi({ type: "merge-worktree", projectId: project.id, path });
    },
    "delete-worktree": () => {
      const { project, path } = activeWorkspace();
      if (!project || !path) return;
      ensureSidebarVisible();
      requestUi({ type: "delete-worktree", projectId: project.id, path });
    },
    "project-settings": () => {
      const { project } = activeWorkspace();
      if (project) chrome.openProjectSettings(project.id);
    },
    "remove-project": () => {
      const { project } = activeWorkspace();
      if (!project) return;
      ensureSidebarVisible();
      requestUi({ type: "remove-project", projectId: project.id });
    },

    // ── Pane ──────────────────────────────────────────────────────────────
    "split-with": (args) => {
      const contentType = (stringArg(args, "contentType") ??
        "terminal") as PaneContentType;
      const paneCommand =
        contentType === "agent"
          ? resolveWorkspaceCommand(app().activeWorkspacePath)
          : undefined;
      // A plain terminal is the default content — leave it unset, like the
      // palette's "Split with Terminal" does.
      splitFocusedPaneWith(
        contentType === "terminal" ? undefined : contentType,
        paneCommand,
      );
    },
    "convert-to": (args) => {
      const contentType = stringArg(args, "contentType");
      if (contentType) convertFocusedPaneTo(contentType as PaneContentType);
    },
    "detach-pane": () => {
      const paneId = getFocusedPaneId();
      if (paneId) void movePaneToNewWindow(paneId);
    },

    // ── Agents ────────────────────────────────────────────────────────────
    "run-setup-script": () => {
      const { project, path } = activeWorkspace();
      if (project?.worktreeStartScript && path) {
        runWorkspaceSetupScript(path, project.worktreeStartScript);
      }
    },
    "view-all-agents": () => chrome.openAgents(),
    "focus-agent": (args) => {
      const agentId = stringArg(args, "agentId");
      if (agentId) chrome.resumeAgent(agentId);
    },
    "remote-control": () => chrome.openSettings("remote"),

    // ── Window ────────────────────────────────────────────────────────────
    "pin-tab": () => {
      const tabId = activeTabId();
      if (tabId) app().togglePinTab(tabId);
    },
    "detach-tab": () => {
      const tabId = activeTabId();
      if (tabId) void detachTabToNewWindow(tabId);
    },

    // ── Help ──────────────────────────────────────────────────────────────
    // Main opens these itself; the handlers exist so every menu command has a
    // renderer-side action even if the routing ever changes.
    "help-docs": () =>
      void window.electronAPI.shell.openExternal(EXTERNAL_LINKS.docs),
    "help-shortcuts": () => chrome.openSettings("keybindings"),
    "help-release-notes": () =>
      void window.electronAPI.shell.openExternal(EXTERNAL_LINKS.releaseNotes),
    "submit-feedback": () => chrome.openFeedback(),
    "help-report-issue": () =>
      void window.electronAPI.shell.openExternal(EXTERNAL_LINKS.newIssue),
    ghosts: () => chrome.showGhosts(),
  };
}

/** Command ids already reported as unhandled — warn once, not per click. */
const warnedCommandIds = new Set<string>();

/** Run the handler a `menu-command` payload names. Unknown ids warn once. */
export function dispatchMenuCommand(
  payload: MenuCommandPayload,
  handlers: Record<string, MenuHandler>,
): void {
  const handler = handlers[payload.commandId];
  if (!handler) {
    if (!warnedCommandIds.has(payload.commandId)) {
      warnedCommandIds.add(payload.commandId);
      console.warn(`[menu] No handler for command "${payload.commandId}"`);
    }
    return;
  }
  handler(payload.args);
}
