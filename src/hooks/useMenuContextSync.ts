/**
 * Keeps the native menu's idea of renderer state fresh (ADR-170 §7).
 *
 * Main can't read the stores, so labels ("Open in Cursor", "Unpin Tab") and
 * enabled/checked state come from a compact `MenuContext` the primary window
 * pushes over IPC. `deriveMenuContext` is the whole derivation, kept pure and
 * unit-tested; the hook is just the plumbing: subscribe to the four stores that
 * feed it, debounce, and skip pushes that would not change anything.
 *
 * The debounce matters — rebuilding the menu while it is open closes it on
 * macOS, and store mutations arrive in bursts (a workspace switch touches
 * layouts, projects and agents in the same tick).
 */

import { useAppStore, type AppState } from "../store/app-store";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { useAgentStore } from "../store/agent-store";
import { usePreferencesStore } from "../store/preferences-store";
import { useMountEffect } from "./useMountEffect";
import { buildSidebarItems } from "../utils/sidebar-items";
import { isHomePath } from "../lib/home";
import type { MenuContext } from "../lib/menu-commands";
import type { AgentInfo, AppPreferences } from "../electron.d";

/** How long a burst of store mutations is allowed to settle before a push. */
const DEBOUNCE_MS = 100;

/** The slice of the app store the menu context is derived from. */
export type MenuAppState = Pick<
  AppState,
  | "activeWorkspacePath"
  | "workspaceLayouts"
  | "paneContentType"
  | "paneAgentStatus"
>;

/** A project's visible workspaces, folder members flattened, in sidebar order. */
function orderedWorkspaces(project: ProjectInfo) {
  return buildSidebarItems(project).flatMap((item) =>
    item.kind === "folder" ? item.workspaces : [item.ws],
  );
}

/** What the sidebar (and therefore the menu) calls a workspace. */
function workspaceLabel(ws: { name: string | null; branch: string }): string {
  return ws.name ?? ws.branch;
}

/**
 * Fold the renderer stores into the snapshot main needs. Pure: no store reads,
 * no IPC — everything it uses is an argument.
 */
function focusedContentType(
  app: MenuAppState,
  paneId: string,
): "terminal" | "browser" | "diff" | "agent" {
  const stored = app.paneContentType[paneId] ?? "terminal";
  if (stored !== "terminal") return stored;
  return app.paneAgentStatus[paneId]?.kind ? "agent" : "terminal";
}

export function deriveMenuContext(
  app: MenuAppState,
  projects: ProjectInfo[],
  agents: AgentInfo[],
  preferences: AppPreferences,
): MenuContext {
  const path = app.activeWorkspacePath;
  const isHome = isHomePath(path);

  const project =
    (!isHome && path
      ? projects.find((p) => p.workspaces.some((w) => w.path === path))
      : undefined) ?? null;
  const workspace = project?.workspaces.find((w) => w.path === path) ?? null;

  const layout = app.workspaceLayouts[path ?? ""] ?? null;
  const panel = layout?.panels[layout.activePanelId] ?? null;
  const tab = panel?.tabs.find((t) => t.id === panel.selectedTabId) ?? null;
  const focusedPaneId = tab?.focusedPaneId ?? null;

  const workspaceLabelByPath = new Map<string, string>();
  for (const p of projects) {
    for (const ws of p.workspaces) {
      workspaceLabelByPath.set(ws.path, workspaceLabel(ws));
    }
  }

  return {
    activeWorkspacePath: path,
    isHome,
    workspace:
      project && workspace
        ? {
            projectId: project.id,
            name: workspaceLabel(workspace),
            branch: workspace.branch,
            isMain: workspace.isMain,
            folderId: workspace.folderId ?? null,
          }
        : null,
    project: project
      ? {
          id: project.id,
          name: project.name,
          hasSetupScript: !!project.worktreeStartScript,
          folders: project.folders.map((f) => ({ id: f.id, name: f.name })),
        }
      : null,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      workspaces: orderedWorkspaces(p).map((ws) => ({
        path: ws.path,
        label: workspaceLabel(ws),
      })),
    })),
    agents: agents
      .filter((agent) => agent.status === "active")
      .map((agent) => ({
        id: agent.id,
        name: agent.name?.trim() || "Agent",
        workspaceLabel: agent.workspacePath
          ? (workspaceLabelByPath.get(agent.workspacePath) ?? null)
          : null,
      })),
    // The store has no "agent" content type — an agent pane is a terminal
    // running an agent command — so a terminal with a detected agent reports
    // "agent" here, which is what Pane › Convert To radio-checks.
    focusedPane: focusedPaneId
      ? {
          id: focusedPaneId,
          contentType: focusedContentType(app, focusedPaneId),
        }
      : null,
    activeTab:
      panel && panel.selectedTabId
        ? {
            id: panel.selectedTabId,
            pinned: (panel.pinnedTabIds ?? []).includes(panel.selectedTabId),
          }
        : null,
    panelCount: layout ? Object.keys(layout.panels).length : 0,
    editorName: preferences.defaultEditor || null,
  };
}

/** Push a fresh `MenuContext` to main whenever the derived snapshot changes. */
export function useMenuContextSync(): void {
  useMountEffect(() => {
    let lastJson = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const push = () => {
      const context = deriveMenuContext(
        useAppStore.getState(),
        useProjectStore.getState().projects,
        useAgentStore.getState().agents,
        usePreferencesStore.getState().preferences,
      );
      const json = JSON.stringify(context);
      if (json === lastJson) return;
      lastJson = json;
      window.electronAPI.menu.setContext(context);
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        push();
      }, DEBOUNCE_MS);
    };

    const unsubscribes = [
      useAppStore.subscribe(schedule),
      useProjectStore.subscribe(schedule),
      useAgentStore.subscribe(schedule),
      usePreferencesStore.subscribe(schedule),
    ];

    // Main starts with a null context; give it one before anything changes.
    push();

    return () => {
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  });
}
