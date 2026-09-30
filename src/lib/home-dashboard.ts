/**
 * ADR-194 §1–§2: pure ranking selectors for the Home dashboard.
 * Everything here is a plain function over data the
 * caller already has in its stores — no store or React imports, so it can be
 * unit-tested the same way `prReadiness` is (`pr-readiness.test.ts`). The
 * components wire store state into these; they own no state of their own.
 */

import type { AgentInfo, PaneAgentStatus } from "../electron.d";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { TopLevelEntry } from "../utils/sidebar-items";
import {
  blockerLabel,
  prVerdict,
  type PrBlocker,
} from "./pr-readiness";
import type { PrInfo } from "./pr-info";
import { projectForWorkspaceKey } from "./hosts";
import { workspaceKey } from "./workspace-key";

// ── Needs you ──

/** The five Needs-you tiers, in ADR §1 priority order. */
export type NeedsYouTier = "input" | "error" | "blocked" | "ready" | "finished";

const TIER_RANK: Record<NeedsYouTier, number> = {
  input: 0,
  error: 1,
  blocked: 2,
  ready: 3,
  finished: 4,
};

export type NeedsYouItem =
  | {
      kind: "agent";
      tier: "input" | "error" | "finished";
      agent: AgentInfo;
      project: ProjectInfo;
      workspace?: WorkspaceInfo;
    }
  | {
      kind: "pr";
      tier: "blocked" | "ready";
      pr: PrInfo;
      project: ProjectInfo;
      workspace: WorkspaceInfo;
      /** "conflicts" / "checks failing" / "changes requested" / "N unresolved threads" / "ready to merge". */
      reason: string;
      /** What blocks a `blocked` PR (ADR-202); null when it's `ready`. */
      blocker: PrBlocker | null;
    };

export interface NeedsYouInput {
  projects: readonly ProjectInfo[];
  agents: readonly AgentInfo[];
  paneAgentStatus: Readonly<Record<string, PaneAgentStatus>>;
  unseenRespondedAgentIds: ReadonlySet<string>;
}

/**
 * The workspace key (ADR-191) of the workspace `agent` runs in: on the host
 * its terminal runs on, falling back to its project's host when no project on
 * the agent's own host has the path. Mirrors `agentWorkspaceKey`
 * (`src/utils/agent-navigation.ts`) — not imported from there because that
 * module pulls in the Zustand stores at load time, which this file must not.
 * `workspaceKey` throws on a bad host id or a non-POSIX remote path, so it's
 * wrapped in try/catch; a throw just means "can't key it", not a crash.
 */
function resolveAgentWorkspaceKey(
  agent: AgentInfo,
  projects: readonly ProjectInfo[],
): string | null {
  const path = agent.workspacePath;
  if (!path) return null;
  try {
    const onAgentHost = workspaceKey(agent.hostId, path);
    if (projectForWorkspaceKey(projects, onAgentHost)) return onAgentHost;
    const project = projects.find((p) => p.id === agent.projectId);
    return project ? workspaceKey(project.hostId, path) : onAgentHost;
  } catch {
    return null;
  }
}

/** The project (and workspace, when known) `agent` belongs to, or null when neither can be found. */
export function resolveAgentContext(
  agent: AgentInfo,
  projects: readonly ProjectInfo[],
): { project: ProjectInfo; workspace?: WorkspaceInfo } | null {
  const key = resolveAgentWorkspaceKey(agent, projects);
  const project =
    (key ? projectForWorkspaceKey(projects, key) : undefined) ??
    projects.find((p) => p.id === agent.projectId);
  if (!project) return null;
  const path = agent.workspacePath;
  const workspace = path ? project.workspaces.find((w) => w.path === path) : undefined;
  return { project, workspace };
}

/** A delegate to `prVerdict`, kept only for `openPrLabel`; new code reads the verdict. */
export function blockedReason(pr: PrInfo): string {
  const { blocker } = prVerdict(pr);
  return blocker ? blockerLabel(blocker) : "blocked";
}

/**
 * A Needs-you item's stable identity: the agent id or the PR URL. React keys
 * and snoozes (ADR-198 §4) both use it, so a snoozed card stays hidden across
 * re-renders and ranking changes.
 */
export function itemKey(item: NeedsYouItem): string {
  return item.kind === "agent" ? `agent:${item.agent.id}` : `pr:${item.pr.url}`;
}

/**
 * Every agent pane and PR that needs the user, ranked across the five tiers
 * of ADR §1: agent `requires_input`, agent `error`, PR `blocked`, PR `ready`,
 * agent `responded` (unseen). Within the agent tiers, oldest
 * `AgentInfo.updatedAt` first. Within a PR tier, `projects` order, then
 * workspace order. PRs are deduped by `pr.url`. Home agents (no `projectId`)
 * are skipped.
 */
export function needsYouItems(input: NeedsYouInput): NeedsYouItem[] {
  const agentItems: NeedsYouItem[] = [];
  for (const agent of input.agents) {
    if (!agent.projectId || !agent.paneId) continue;
    const status = input.paneAgentStatus[agent.paneId]?.status;
    let tier: "input" | "error" | "finished" | null = null;
    if (status === "requires_input") tier = "input";
    else if (status === "error") tier = "error";
    else if (status === "responded" && input.unseenRespondedAgentIds.has(agent.id)) {
      tier = "finished";
    }
    if (!tier) continue;

    const resolved = resolveAgentContext(agent, input.projects);
    if (!resolved) continue;
    agentItems.push({
      kind: "agent",
      tier,
      agent,
      project: resolved.project,
      workspace: resolved.workspace,
    });
  }

  const prItems: NeedsYouItem[] = [];
  const seenPrUrls = new Set<string>();
  for (const project of input.projects) {
    for (const workspace of project.workspaces) {
      const pr = workspace.pr;
      if (!pr || pr.state !== "open") continue;
      if (seenPrUrls.has(pr.url)) continue;
      const verdict = prVerdict(pr);
      if (verdict.readiness !== "blocked" && verdict.readiness !== "ready") {
        continue;
      }
      seenPrUrls.add(pr.url);
      prItems.push({
        kind: "pr",
        tier: verdict.readiness,
        pr,
        project,
        workspace,
        reason:
          verdict.readiness === "blocked"
            ? blockerLabel(verdict.blocker)
            : "ready to merge",
        blocker: verdict.blocker,
      });
    }
  }

  return [...agentItems, ...prItems].sort((a, b) => {
    const rankDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (rankDiff !== 0) return rankDiff;
    if (a.kind === "agent" && b.kind === "agent") {
      return Date.parse(a.agent.updatedAt) - Date.parse(b.agent.updatedAt);
    }
    // Two PR items in the same tier keep insertion order (projects order,
    // then workspace order) — `Array.prototype.sort` is stable.
    return 0;
  });
}

// ── Counts ──

/**
 * Panes in `thinking` or `working` that belong to a live (`status ===
 * "active"`) agent, counted once per pane.
 */
export function runningAgentCount(
  agents: readonly AgentInfo[],
  paneAgentStatus: Readonly<Record<string, PaneAgentStatus>>,
): number {
  const panes = new Set<string>();
  for (const agent of agents) {
    if (agent.status !== "active" || !agent.paneId) continue;
    const status = paneAgentStatus[agent.paneId]?.status;
    if (status === "thinking" || status === "working") {
      panes.add(agent.paneId);
    }
  }
  return panes.size;
}

/** Open PRs across `projects`, deduped by `pr.url`. */
export function openPrCount(projects: readonly ProjectInfo[]): number {
  const urls = new Set<string>();
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (workspace.pr && workspace.pr.state === "open") urls.add(workspace.pr.url);
    }
  }
  return urls.size;
}

/**
 * The member project a top-level entry is read through: the project itself,
 * or for a linked group the `lastUsedHostId` member (else the first). Up next
 * queries a group once through it, and its card shows that member's path.
 */
export function primaryMember(entry: TopLevelEntry<ProjectInfo>): ProjectInfo | undefined {
  if (entry.kind === "project") return entry.project;
  return (
    entry.sections.find((s) => s.project.hostId === entry.group.lastUsedHostId)?.project ??
    entry.sections[0]?.project
  );
}
