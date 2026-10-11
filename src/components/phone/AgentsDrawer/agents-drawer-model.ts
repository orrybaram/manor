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
  /** The project id, or its name when the agent carries no id. */
  key: string;
  projectName: string;
  color: string | null;
  rows: AgentsDrawerRow[];
}

export interface AgentsDrawerModel {
  needsYou: AgentsDrawerNeedsYou[];
  groups: AgentsDrawerGroup[];
  /** "2 · 5 workspaces", for the Projects row. */
  projectsSummary: string;
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
 * drawer (ADR-219). "Needs you" is the dashboard's `input` tier
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

  const buckets = new Map<string, Bucket>();
  for (const agent of agents) {
    if (pinned.has(agent.id)) continue;
    const key = agent.projectId ?? agent.projectName;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { projectName: agent.projectName, agents: [] };
      buckets.set(key, bucket);
    }
    bucket.agents.push(agent);
  }

  const toGroup = (key: string, bucket: Bucket, color: string | null): AgentsDrawerGroup => ({
    key,
    projectName: bucket.projectName,
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

  // Known projects in store order, then the rest by name.
  const groups: AgentsDrawerGroup[] = [];
  for (const project of projects) {
    const bucket = buckets.get(project.id);
    if (!bucket) continue;
    buckets.delete(project.id);
    groups.push(toGroup(project.id, bucket, project.color));
  }
  const unknown = [...buckets.entries()].sort(([, a], [, b]) =>
    a.projectName.localeCompare(b.projectName),
  );
  for (const [key, bucket] of unknown) groups.push(toGroup(key, bucket, null));

  const workspaceCount = projects.reduce((n, p) => n + p.workspaces.length, 0);

  return {
    needsYou,
    groups,
    projectsSummary: `${projects.length} · ${workspaceCount} workspaces`,
  };
}
