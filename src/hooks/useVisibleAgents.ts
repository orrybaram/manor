import { useMemo } from "react";
import type { AgentInfo } from "../electron.d";
import { useAgentStore } from "../store/agent-store";
import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";

/**
 * The agents the sidebar's Agents list shows. Shared with the collapsed rail's
 * Agents count (ADR-195) so the two never disagree.
 */
export function useVisibleAgents(): (AgentInfo & { projectName: string })[] {
  const agents = useAgentStore((s) => s.agents);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);

  // Collect all active pane IDs across all workspace layouts
  const activePaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const layout of Object.values(workspaceLayouts)) {
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const id of allPaneIds(tab.rootNode)) {
            ids.add(id);
          }
        }
      }
    }
    return ids;
  }, [workspaceLayouts]);

  // Show active agents only while they still own a pane; show completed/error/abandoned
  // only if their pane is still active. Orphaned active records (paneId null) are
  // hidden because they have no pane to navigate to.
  //
  // Pagination note (ADR-136): the agent store loads `agents:getActive` (all active)
  // plus the first page of `agents:getAll` (most recent N). A non-active agent whose
  // paneId is still in the current layout is by construction recent — its pane
  // hasn't been closed yet — and is therefore expected to be inside the first
  // page. If a user closes the modal before scrolling far enough to load older
  // agents, the visible set here is unaffected.
  //
  // An agent without a project is held back rather than grouped under a
  // placeholder: its context arrives shortly (useAgentContextRepair), and it
  // then appears once, in its own project, instead of jumping there.
  const visibleAgents = useMemo(
    () =>
      agents.filter(
        (t): t is AgentInfo & { projectName: string } =>
          !!t.projectName &&
          ((t.status === "active" && t.paneId != null) ||
            (t.paneId != null && activePaneIds.has(t.paneId))),
      ),
    [agents, activePaneIds],
  );

  return visibleAgents;
}
