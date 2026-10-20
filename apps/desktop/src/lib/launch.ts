import {
  getPersistedActiveWorkspacePath,
  OWN_CLAIM,
  resyncLayout,
  useAppStore,
} from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { HOME_PATH, isHomePath } from "./home";
import { parseWorkspaceKey } from "./workspace-key";

/** Open the selected project's selected workspace, as a launch does. */
export function openSelectedProjectWorkspace(): void {
  const { projects: ps, selectedProjectIndex: idx } = useProjectStore.getState();
  const project = ps[idx];
  if (!project) return;
  const ws =
    project.workspaces[project.selectedWorkspaceIndex] ?? project.workspaces[0];
  if (ws) useAppStore.getState().setActiveWorkspace(ws.path, project.hostId);
}

/**
 * Read the projects and this renderer's layout, then reopen what this window
 * had open. Run at boot, and again by `resyncAfterReconnect` when the boot's
 * reads failed — a phone opened while its desktop is away reads nothing, and
 * the first hello is the first chance to.
 */
export async function launch(): Promise<void> {
  // `layout.getAll()` is a read of the Manor server's layout, and the
  // subscription that keeps it current is installed when `app-store.ts` is
  // imported — well before this runs, so a change that lands in the gap is
  // delivered rather than lost.
  await Promise.all([
    useProjectStore.getState().loadProjects(),
    useAppStore.getState().loadPersistedLayout(),
  ]);
  const app = useAppStore.getState();
  // A detached window opens on the workspace holding the tab it claims,
  // whatever this renderer would otherwise have reopened on.
  // Its claim names the workspace by key, so it opens on the right host.
  if (OWN_CLAIM) {
    const { path, hostId } = parseWorkspaceKey(OWN_CLAIM.workspacePath);
    app.setActiveWorkspace(path, hostId);
    // No sidebar in a detached window: plain setState, not the persisting
    // action, so the primary's mode is untouched. Its tab bar
    // clears the macOS traffic lights through the `:root` default of
    // `--window-lead-inset`.
    useProjectStore.setState({ sidebarMode: "hidden" });
    // Its panes reopen without waking a sleeping host.
    app.seedRestoredPanes();
    window.electronAPI.agents.reconcileStale().catch(console.error);
    return;
  }
  // A relaunch after a failed boot leaves alone a workspace opened since.
  if (!app.activeWorkspacePath) {
    // If the Home surface was the last-active surface, restore it directly —
    // it isn't a project workspace, so the project-based restore below can't
    // reach it. Other workspaces are restored via project selection.
    if (isHomePath(getPersistedActiveWorkspacePath())) {
      app.setActiveWorkspace(HOME_PATH);
    } else {
      openSelectedProjectWorkspace();
    }
  }
  // The workspace this window reopened on: its panes reopen without
  // waking a sleeping host; any opened later is the user's.
  // A failed project load has reopened nothing yet: the Retry that
  // succeeds does it.
  if (useProjectStore.getState().loadError === null) {
    useAppStore.getState().seedRestoredPanes();
  }
  window.electronAPI.agents.reconcileStale().catch(console.error);
}

/**
 * Retry a project load that failed at launch. Once it works,
 * reopen what the launch would have, since the launch found nothing to open.
 */
export async function retryLoadProjects(): Promise<void> {
  await useProjectStore.getState().loadProjects();
  if (useProjectStore.getState().loadError !== null) return;
  if (!useAppStore.getState().activeWorkspacePath) openSelectedProjectWorkspace();
  useAppStore.getState().seedRestoredPanes();
}

/**
 * A reconnected browser missed whatever was pushed while it was gone:
 * re-read the projects and every workspace. The layout's resync is not its
 * boot read — see `resyncLayout` — unless the boot's reads failed, and then
 * the whole launch runs again, reopening what this window had open.
 */
export function resyncAfterReconnect(): Promise<unknown> {
  const bootFailed =
    useProjectStore.getState().loadError !== null ||
    useAppStore.getState().layoutLoadError !== null;
  if (bootFailed) return launch();
  return Promise.all([useProjectStore.getState().loadProjects(), resyncLayout()]);
}
