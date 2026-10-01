import { useMemo } from "react";
import type { AgentRollup } from "../store/agent-rollup";
import { useWorkspacesAgentStatus } from "./useProjectAgentStatus";
import type { WorkspaceKey } from "../lib/workspace-key";

/** Agent status of the workspace keyed `key` (ADR-191). */
export function useWorkspaceAgentStatus(key: WorkspaceKey): AgentRollup {
  return useWorkspacesAgentStatus(useMemo(() => [key], [key]));
}
