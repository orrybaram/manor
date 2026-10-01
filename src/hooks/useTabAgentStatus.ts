import { useCallback, useMemo } from "react";
import { useAppStore, selectActiveWorkspace, selectVisiblePaneIds } from "../store/app-store";
import { useAgentRollup, type AgentRollup, type PaneSetSelector } from "../store/agent-rollup";
import { allPaneIds } from "../store/pane-tree";

/**
 * The panes on screen (`selectVisiblePaneIds`), kept current with the layout.
 * The same definition the read-state sweep in the agent store uses (#142).
 */
export function useVisiblePaneIds(): ReadonlySet<string> {
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceHostId = useAppStore((s) => s.activeWorkspaceHostId);
  return useMemo(
    () => selectVisiblePaneIds({ activeWorkspacePath, activeWorkspaceHostId, workspaceLayouts }),
    [activeWorkspacePath, activeWorkspaceHostId, workspaceLayouts],
  );
}

/** Agent status of the active workspace's tab `tabId` (see `useAgentRollup`). */
export function useTabAgentStatus(tabId: string): AgentRollup {
  // No tab, no panes: the rollup then gives { null, pulse: true }.
  const selectPanes = useCallback<PaneSetSelector>(({ app }) => {
    const tab = selectActiveWorkspace(app)?.tabs.find((t) => t.id === tabId);
    return tab ? allPaneIds(tab.rootNode) : [];
  }, [tabId]);
  return useAgentRollup(selectPanes);
}
