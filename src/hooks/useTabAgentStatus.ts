import { useCallback } from "react";
import { selectActiveWorkspace } from "../store/app-store";
import type { AgentRollup } from "../store/agent-rollup";
import { allPaneIds } from "../store/pane-tree";
import { useAgentRollup, type PaneSetSelector } from "./useAgentRollup";

/** Agent status of the active workspace's tab `tabId` (see `useAgentRollup`). */
export function useTabAgentStatus(tabId: string): AgentRollup {
  // No tab, no panes: the rollup then gives { null, pulse: true }.
  const selectPanes = useCallback<PaneSetSelector>(({ app }) => {
    const tab = selectActiveWorkspace(app)?.tabs.find((t) => t.id === tabId);
    return tab ? allPaneIds(tab.rootNode) : [];
  }, [tabId]);
  return useAgentRollup(selectPanes);
}
