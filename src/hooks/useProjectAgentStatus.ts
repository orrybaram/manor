import { useMemo } from "react";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import { pickBestPaneStatus } from "./useTabAgentStatus";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { AgentInfo, AgentStatus } from "../electron.d";
import type { WorkspaceLayout } from "../store/app-store";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";

/** What `groupAgentPaneIds` needs of one member of a linked group. */
export interface GroupMember {
  hostId: string | null | undefined;
  workspaces: readonly { path: string }[];
}

/**
 * The panes whose agents a collapsed linked group (ADR-192) speaks for:
 * every pane in the layouts of every member's workspaces, plus the pane of
 * every agent running in one of them. An agent counts by its own host
 * (`agent.hostId`, where its terminal really runs — ADR-191 §5) and its
 * workspace path, so an agent on either host's section counts, including
 * one whose workspace has no layout open here.
 */
export function groupAgentPaneIds(
  members: readonly GroupMember[],
  workspaceLayouts: Readonly<Record<string, WorkspaceLayout | undefined>>,
  agents: readonly Pick<AgentInfo, "hostId" | "workspacePath" | "paneId">[],
): string[] {
  const paneIds = new Set<string>();
  const memberWorkspaces = new Set<string>();
  for (const member of members) {
    for (const ws of member.workspaces) {
      const key = workspaceKey(member.hostId, ws.path);
      memberWorkspaces.add(key);
      const layout = workspaceLayouts[key];
      if (!layout) continue;
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const id of allPaneIds(tab.rootNode)) paneIds.add(id);
        }
      }
    }
  }
  for (const agent of agents) {
    if (!agent.paneId || !agent.workspacePath) continue;
    if (memberWorkspaces.has(workspaceKey(agent.hostId, agent.workspacePath))) {
      paneIds.add(agent.paneId);
    }
  }
  return [...paneIds];
}

/**
 * Aggregate agent status across every host section of a linked group
 * (ADR-192), for the dot on its collapsed header.
 */
export function useGroupAgentStatus(
  members: readonly GroupMember[],
): { status: AgentStatus | null; pulse: boolean } {
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const unseenInputAgentIds = useAgentStore((s) => s.unseenInputAgentIds);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  return useMemo(
    () =>
      pickBestPaneStatus(groupAgentPaneIds(members, workspaceLayouts, agents), {
        paneAgentStatus,
        agents,
        unseenRespondedAgentIds,
        unseenInputAgentIds,
      }),
    [
      members,
      workspaceLayouts,
      paneAgentStatus,
      agents,
      unseenRespondedAgentIds,
      unseenInputAgentIds,
    ],
  );
}

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
