import type { AgentInfo, AgentStatus, PaneAgentStatus } from "../../../electron.d";
import { isHomePath } from "../../../lib/home";
import { needsYouItems } from "../../../lib/home-dashboard";
import type { ProjectInfo, WorkspaceInfo } from "../../../store/project-store";
import { byUpdatedDesc, relativeShortIso } from "../../../utils/relative-time";

/** One "Needs you" card: the agent and where it runs. */
export interface AgentsDrawerNeedsYou {
  agent: AgentInfo;
  projectName: string;
  color: string | null;
  workspaceLabel: string;
}

/** One agent in a project group, with the label shown at its trailing edge. */
export interface AgentsDrawerRow {
  agent: AgentInfo;
  /** The live status while it's working, thinking or errored, else the age. */
  trailing: string;
  error: boolean;
}

export interface AgentsDrawerGroup {
  /**
   * The project id, the linked group's id for any of its members,
   * or the agent's project name when it carries no known id.
   */
  key: string;
  projectName: string;
  color: string | null;
  rows: AgentsDrawerRow[];
}

export interface AgentsDrawerModel {
  needsYou: AgentsDrawerNeedsYou[];
  groups: AgentsDrawerGroup[];
}

interface AgentsDrawerInput {
  agents: readonly (AgentInfo & { projectName: string })[];
  paneAgentStatus: Readonly<Record<string, PaneAgentStatus>>;
  projects: readonly ProjectInfo[];
}

type Bucket = { projectName: string; agents: AgentInfo[] };

const NO_UNSEEN: ReadonlySet<string> = new Set();

/**
 * Where a grouped row sorts and what it says: live work first, then errors,
 * then the rest. A null `label` means the row shows its age instead.
 */
export function rowState(status: AgentStatus | undefined): {
  rank: number;
  label: string | null;
} {
  if (status === "thinking" || status === "working") return { rank: 0, label: status };
  if (status === "error") return { rank: 1, label: status };
  return { rank: 2, label: null };
}

/** The agent's workspace name, else the last segment of its path. */
function workspaceLabel(agent: AgentInfo, workspace: WorkspaceInfo | undefined): string {
  if (agent.workspacePath && isHomePath(agent.workspacePath)) return "Dashboard";
  const path = agent.workspacePath ?? agent.cwd;
  const basename = path.split("/").filter(Boolean).pop() ?? "";
  return workspace?.name || workspace?.branch || basename;
}

/**
 * Splits agents into a "Needs you" list and per-project groups for the phone
 * drawer. "Needs you" is the dashboard's `input` tier
 * (`needsYouItems`), so the label means the same agents on both surfaces.
 * Statuses are read as given, never re-derived.
 */
export function buildAgentsDrawerModel({
  agents,
  paneAgentStatus,
  projects,
}: AgentsDrawerInput): AgentsDrawerModel {
  const statusOf = (a: AgentInfo) =>
    a.paneId ? paneAgentStatus[a.paneId]?.status : undefined;

  const needsYou: AgentsDrawerNeedsYou[] = [];
  const pinned = new Set<string>();
  const items = needsYouItems({
    projects,
    agents,
    paneAgentStatus,
    unseenRespondedAgentIds: NO_UNSEEN,
  });
  for (const item of items) {
    if (item.kind !== "agent" || item.tier !== "input") continue;
    pinned.add(item.agent.id);
    needsYou.push({
      agent: item.agent,
      projectName: item.project.name,
      color: item.project.color,
      workspaceLabel: workspaceLabel(item.agent, item.workspace),
    });
  }
  needsYou.sort((a, b) => byUpdatedDesc(a.agent, b.agent));

  // A linked group's members share one group, as in the sidebar —
  // otherwise a project checked out on two hosts shows up twice. Like
  // `buildTopLevelEntries`, a group with fewer than two members present
  // falls back to plain projects.
  const byId = new Map(projects.map((p) => [p.id, p]));
  const entryKeyOf = new Map<string, string>();
  for (const project of projects) {
    const group = project.group;
    const members = group
      ? group.memberIds.filter((id) => byId.get(id)?.group?.id === group.id)
      : [];
    entryKeyOf.set(project.id, group && members.length >= 2 ? group.id : project.id);
  }

  const buckets = new Map<string, Bucket>();
  for (const agent of agents) {
    if (pinned.has(agent.id)) continue;
    const key =
      (agent.projectId && entryKeyOf.get(agent.projectId)) ??
      agent.projectId ??
      agent.projectName;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { projectName: agent.projectName, agents: [] };
      buckets.set(key, bucket);
    }
    bucket.agents.push(agent);
  }

  const toGroup = (
    key: string,
    bucket: Bucket,
    color: string | null,
    name = bucket.projectName,
  ): AgentsDrawerGroup => ({
    key,
    projectName: name,
    color,
    rows: bucket.agents
      .map((agent) => ({ agent, state: rowState(statusOf(agent)) }))
      .sort((x, y) => x.state.rank - y.state.rank || byUpdatedDesc(x.agent, y.agent))
      .map(({ agent, state }) => ({
        agent,
        trailing: state.label ?? relativeShortIso(agent.updatedAt),
        error: state.label === "error",
      })),
  });

  // Known projects and groups in store order, a group in its first member's
  // slot, then the rest by name.
  const groups: AgentsDrawerGroup[] = [];
  for (const project of projects) {
    const key = entryKeyOf.get(project.id) ?? project.id;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    buckets.delete(key);
    groups.push(
      key === project.id
        ? toGroup(key, bucket, project.color)
        : toGroup(key, bucket, project.color, project.group?.name),
    );
  }
  const unknown = [...buckets.entries()].sort(([, a], [, b]) =>
    a.projectName.localeCompare(b.projectName),
  );
  for (const [key, bucket] of unknown) groups.push(toGroup(key, bucket, null));

  return { needsYou, groups };
}
