import { useCallback } from "react";
import { useAgentRollup, type AgentRollup, type PaneSetSelector } from "../store/agent-rollup";
import { layoutPaneIds } from "./useProjectAgentStatus";
import type { WorkspaceKey } from "../lib/workspace-key";

/** Agent status of the workspace keyed `key` (ADR-191). */
export function useWorkspaceAgentStatus(key: WorkspaceKey): AgentRollup {
  const selectPanes = useCallback<PaneSetSelector>(
    ({ app }) => layoutPaneIds([key], app.workspaceLayouts),
    [key],
  );
  return useAgentRollup(selectPanes);
}
