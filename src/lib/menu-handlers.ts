/**
 * Renderer-side dispatch for the native application menu (ADR-170 §6).
 *
 * `createMenuHandlers` builds one command→action map per window: `run` over
 * the command table (`commands.ts`), against a context that adds `App`'s
 * chrome to the shared one. `App` uses the same map for key dispatch, the
 * native menu and the command palette, so a command can never work from one
 * and be dead (or different) in another.
 *
 * Every context member reads `getState()` rather than React state — the map
 * is built outside the render cycle and `chrome` is the only React-owned
 * surface it touches. Actions that live in component-local state (dialogs,
 * popovers, pane search) go out over the `ui-request` bus instead.
 */

import { useAppStore } from "../store/app-store";
import {
  useProjectStore,
  runWorkspaceSetupScript,
  type ProjectInfo,
} from "../store/project-store";
import { hideWorkspaceAndNavigate } from "../store/workspace-actions";
import {
  activeSurface,
  createSharedCommandContext,
  resolveWorkspaceCommand,
} from "./keybinding-commands";
import { convertFocusedPaneTo, splitFocusedPaneWith } from "./pane-actions";
import { detachTabToNewWindow, movePaneToNewWindow } from "./detach";
import { openInEditor } from "./editor";
import { focusRegionWhenReady } from "./focus-regions";
import { HOME_PATH } from "./home";
import type { MenuCommandPayload } from "./menu-commands";
import {
  commandHandlers,
  type CommandContext,
  type CommandHandler,
} from "./commands";
import { openExternal } from "./open-external";
import { isWebApp } from "./platform";
import {
  buildSidebarItems,
  placeAfterFolder,
  placeInFolder,
  type SidebarItem,
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
export type MenuHandler = CommandHandler;

/**
 * Every workspace the menu can switch between, in the order the sidebar shows
 * them: Home first, then each project's visible workspaces with folders — at
 * any depth — flattened into the folder's slot.
 */
export function orderedWorkspacePaths(projects: ProjectInfo[]): string[] {
  const paths: string[] = [HOME_PATH];
  const walk = (items: SidebarItem[]) => {
    for (const item of items) {
      if (item.kind === "folder") walk(item.children);
      else paths.push(item.ws.path);
    }
  };
  for (const project of projects) walk(buildSidebarItems(project));
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

/**
 * What the command table's commands run against in a window with `App`'s
 * chrome: the shared context plus the primary window's own surfaces.
 */
function createCommandContext(chrome: MenuChrome): CommandContext {
  return {
    ...createSharedCommandContext({ prewarmNewAgent: true }),
    chrome,
    toggleSidebar: () => useProjectStore.getState().toggleSidebar(),
    ensureSidebarVisible,
    focusRegionWhenReady: (region) => focusRegionWhenReady(region),
    navigateBack,
    navigateForward,
    switchToWorkspace,
    stepWorkspace,
    hideWorkspace: hideWorkspaceAndNavigate,
    moveActiveWorkspaceToFolder: (folderId) => {
      const { project, workspace, path } = activeSurface();
      if (!project || !workspace || !path) return;
      const items = buildSidebarItems(project);
      const next = folderId
        ? placeInFolder(items, path, folderId)
        : workspace.folderId
          ? placeAfterFolder(items, path, workspace.folderId)
          : items;
      void useProjectStore.getState().applySidebarChange(project.id, next);
    },
    activeProjectLinkedToLinear: () => {
      const { project } = activeSurface();
      const projectStore = useProjectStore.getState();
      const fallback = projectStore.projects[projectStore.selectedProjectIndex];
      return ((project ?? fallback)?.linearAssociations?.length ?? 0) > 0;
    },
    runSetupScript: runWorkspaceSetupScript,
    agentCommand: resolveWorkspaceCommand,
    splitFocusedPaneWith,
    convertFocusedPaneTo,
    movePaneToNewWindow: (paneId) => void movePaneToNewWindow(paneId),
    detachTab: (tabId) => void detachTabToNewWindow(tabId),
    openInEditor,
    revealInFinder: (path) =>
      void window.electronAPI.shell.showItemInFolder(path),
    openExternal,
    closeWindow: () => window.close(),
  };
}

/**
 * The command→action map for a window running `App`: `run` over the whole
 * command table (`commands.ts`), less the native-only commands on the web.
 *
 * `primary: false` — a detached window (ADR-179 D4) — keeps only the
 * `scope: "any"` commands. A popout has none of the chrome the rest need;
 * the dispatcher's fallback forwards their combos to the primary window, and
 * main never routes their menu clicks here.
 */
export function createMenuHandlers(
  chrome: MenuChrome,
  { primary = true }: { primary?: boolean } = {},
): Record<string, MenuHandler> {
  return commandHandlers(createCommandContext(chrome), {
    web: isWebApp(),
    primary,
  });
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
