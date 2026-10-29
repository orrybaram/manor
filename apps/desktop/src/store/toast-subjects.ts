/**
 * What "on screen" means for a toast's subject (`ToastOptions.about`), told
 * to the toast module when `App` mounts (`wireToastSubjects`). The toast module
 * asks; the stores here answer, so `src/toast/` imports none of them.
 *
 * - a **pane** is on screen when this desktop shows it in any window
 *   (`selectOnScreenPaneIds`: the selected tab of every panel here, plus
 *   every tab a detached window claims);
 * - an **agent** is when its pane is;
 * - a **workspace** is when it is the active one (its layout key, or its
 *   plain path).
 *
 * Driven by store subscriptions, filtered to the slices that decide it, so
 * the rest of the store's churn (titles, cwds, output) costs one comparison.
 */
import { type ToastSubject, watchToastSubjects } from "../toast";
import { useAgentStore } from "./agent-store";
import {
  selectActiveWorkspaceKey,
  selectOnScreenPaneIds,
  useAppStore,
} from "./app-store";
import { isHomePath } from "../lib/home-path";

/** Whether `subject` is on screen right now. */
export function isSubjectOnScreen(subject: ToastSubject): boolean {
  const app = useAppStore.getState();
  if ("workspace" in subject) {
    if (isHomePath(app.activeWorkspacePath)) return false;
    return (
      subject.workspace === selectActiveWorkspaceKey(app) ||
      subject.workspace === app.activeWorkspacePath
    );
  }
  const paneId =
    "pane" in subject
      ? subject.pane
      : useAgentStore.getState().agents.find((a) => a.id === subject.agent)?.paneId;
  return paneId != null && selectOnScreenPaneIds(app).has(paneId);
}

/**
 * Give the toast module its view of the screen; returns the undo. A second
 * call replaces the first.
 */
export function wireToastSubjects(): () => void {
  watchToastSubjects({
    isOnScreen: isSubjectOnScreen,
    subscribe: (changed) => {
      const offApp = useAppStore.subscribe((state, prev) => {
        if (
          state.workspaceLayouts !== prev.workspaceLayouts ||
          state.viewports !== prev.viewports ||
          state.claims !== prev.claims ||
          state.activeWorkspacePath !== prev.activeWorkspacePath ||
          state.activeWorkspaceHostId !== prev.activeWorkspaceHostId
        ) {
          changed();
        }
      });
      const offAgents = useAgentStore.subscribe((state, prev) => {
        if (state.agents !== prev.agents) changed();
      });
      return () => {
        offApp();
        offAgents();
      };
    },
  });
  return () => watchToastSubjects(null);
}
