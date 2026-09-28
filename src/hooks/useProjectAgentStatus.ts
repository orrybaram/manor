import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import { pickBestPaneStatus } from "./useTabAgentStatus";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { AgentStatus } from "../electron.d";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";

/**
 * Aggregate agent status across an arbitrary set of workspaces, named by
 * their workspace keys (ADR-191) — the whole project (see
 * `useProjectAgentStatus`), one folder's members, or a linked group's.
 * Memoize `keys`: a new array each render recomputes.
 */
export function useWorkspacesAgentStatus(
  keys: readonly string[],
): { status: AgentStatus | null; pulse: boolean } {
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(() => {
    const paneIds: string[] = [];
    for (const key of keys) {
      const layout = workspaceLayouts[key];
      if (!layout) continue;

      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          paneIds.push(...allPaneIds(tab.rootNode));
        }
      }
    }

    return pickBestPaneStatus(paneIds, {
      paneAgentStatus,
      agents,
      unseenRespondedAgentIds,
      unseenInputAgentIds,
    });
  }, [
    keys,
    workspaceLayouts,
    paneAgentStatus,
    agents,
    unseenRespondedAgentIds,
    unseenInputAgentIds,
  ]);
}

/** The workspace keys of `workspaces`, all on `hostId`, memoized. */
export function useWorkspaceKeys(
  workspaces: readonly WorkspaceInfo[],
  hostId: string | null | undefined,
): WorkspaceKey[] {
  return useMemo(
    () => workspaces.map((ws) => workspaceKey(hostId, ws.path)),
    [workspaces, hostId],
  );
}

export function useProjectAgentStatus(
  project: ProjectInfo,
): { status: AgentStatus | null; pulse: boolean } {
  return useWorkspacesAgentStatus(useWorkspaceKeys(project.workspaces, project.hostId));
}
