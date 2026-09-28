import { useMemo } from "react";
import { useAppStore, type WorkspaceLayout } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { allPaneIds } from "../store/pane-tree";
import { useBestStatusForPanes } from "./useTabAgentStatus";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { AgentInfo, AgentStatus } from "../electron.d";

type WorkspaceLayouts = Readonly<Record<string, WorkspaceLayout | undefined>>;

/**
 * Every pane in every tab of the layouts of the workspaces `keys` name
 * (ADR-191: layouts are keyed by host plus path), in order.
 */
export function layoutPaneIds(
  keys: Iterable<string>,
  workspaceLayouts: WorkspaceLayouts,
): string[] {
  const paneIds: string[] = [];
  for (const key of keys) {
    const layout = workspaceLayouts[key];
    if (!layout) continue;
    for (const panel of Object.values(layout.panels)) {
      for (const tab of panel.tabs) paneIds.push(...allPaneIds(tab.rootNode));
    }
  }
  return paneIds;
}

/**
 * Aggregate agent status across an arbitrary set of workspaces, named by
 * their workspace keys (ADR-191) — the whole project (see
 * `useProjectAgentStatus`) or one folder's members.
 * Memoize `keys`: a new array each render recomputes.
 */
export function useWorkspacesAgentStatus(
  keys: readonly string[],
): { status: AgentStatus | null; pulse: boolean } {
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const paneIds = useMemo(() => layoutPaneIds(keys, workspaceLayouts), [keys, workspaceLayouts]);
  return useBestStatusForPanes(paneIds);
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

/** What `groupAgentPaneIds` needs of one member of a linked group. */
export interface GroupMember {
  hostId: string | null | undefined;
  workspaces: readonly { path: string }[];
}

/**
 * The panes whose agents a collapsed linked group (ADR-192) speaks for:
 * every pane in the layouts of every member's workspaces, each looked up on
 * its member's host, plus the pane of every agent running in one of them.
 * An agent counts by its own host (`agent.hostId`, where its terminal really
 * runs — ADR-191 §5) and its workspace path, so an agent on either host's
 * section counts, including one whose workspace has no layout open here.
 */
export function groupAgentPaneIds(
  members: readonly GroupMember[],
  workspaceLayouts: WorkspaceLayouts,
  agents: readonly Pick<AgentInfo, "hostId" | "workspacePath" | "paneId">[],
): string[] {
  const memberKeys = members.flatMap((m) =>
    m.workspaces.map((ws) => workspaceKey(m.hostId, ws.path)),
  );
  const paneIds = new Set(layoutPaneIds(memberKeys, workspaceLayouts));
  const memberWorkspaces = new Set<string>(memberKeys);
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
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const agents = useAgentStore((s) => s.agents);
  const paneIds = useMemo(
    () => groupAgentPaneIds(members, workspaceLayouts, agents),
    [members, workspaceLayouts, agents],
  );
  return useBestStatusForPanes(paneIds);
}
