import type { AgentInfo, AgentStatus } from "../../../electron.d";
import type { ProjectInfo } from "../../../store/project-store";

export interface AgentsDrawerGroup {
  projectId: string;
  projectName: string;
  color: string | null;
  agents: AgentInfo[];
}

export interface AgentsDrawerModel {
  needsYou: AgentInfo[];
  groups: AgentsDrawerGroup[];
}

interface AgentsDrawerInput {
  agents: (AgentInfo & { projectName: string })[];
  statusByPane: Record<string, AgentStatus | undefined>;
  projects: Pick<ProjectInfo, "id" | "name" | "color">[];
}

function rank(status: AgentStatus | undefined): number {
  if (status === "thinking" || status === "working") return 0;
  if (status === "error") return 1;
  return 2;
}

const byUpdatedDesc = (a: AgentInfo, b: AgentInfo) =>
  b.updatedAt.localeCompare(a.updatedAt);

/**
 * Splits agents into a "needs you" list and per-project groups for the phone
 * drawer (ADR-219). Statuses are read as given, never re-derived.
 */
export function buildAgentsDrawerModel({
  agents,
  statusByPane,
  projects,
}: AgentsDrawerInput): AgentsDrawerModel {
  const statusOf = (a: AgentInfo) =>
    a.paneId ? statusByPane[a.paneId] : undefined;

  const needsYou: AgentInfo[] = [];
  const buckets = new Map<
    string,
    { projectId: string | null; projectName: string; agents: AgentInfo[] }
  >();

  for (const agent of agents) {
    if (statusOf(agent) === "requires_input") {
      needsYou.push(agent);
      continue;
    }
    const key = agent.projectId ?? agent.projectName;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        projectId: agent.projectId,
        projectName: agent.projectName,
        agents: [],
      };
      buckets.set(key, bucket);
    }
    bucket.agents.push(agent);
  }

  needsYou.sort(byUpdatedDesc);

  const projectIndex = new Map(projects.map((p, i) => [p.id, i]));
  const colorById = new Map(projects.map((p) => [p.id, p.color]));

  const groups = [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      index: b.projectId ? (projectIndex.get(b.projectId) ?? -1) : -1,
      group: {
        projectId: key,
        projectName: b.projectName,
        color: (b.projectId ? colorById.get(b.projectId) : null) ?? null,
        agents: b.agents.sort(
          (x, y) =>
            rank(statusOf(x)) - rank(statusOf(y)) || byUpdatedDesc(x, y),
        ),
      },
    }))
    .sort((a, b) => {
      if (a.index === -1 && b.index === -1) {
        return a.group.projectName.localeCompare(b.group.projectName);
      }
      if (a.index === -1) return 1;
      if (b.index === -1) return -1;
      return a.index - b.index;
    })
    .map((g) => g.group);

  return { needsYou, groups };
}
