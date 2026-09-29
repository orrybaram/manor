/**
 * ADR-194 §1–§2: pure ranking selectors for the Home dashboard and the
 * Projects overview. Everything here is a plain function over data the
 * caller already has in its stores — no store or React imports, so it can be
 * unit-tested the same way `prReadiness` is (`pr-readiness.test.ts`). The
 * components wire store state into these; they own no state of their own.
 */

import type { AgentInfo, GitHubIssue, LinearIssue, PaneAgentStatus } from "../electron.d";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { TopLevelEntry } from "../utils/sidebar-items";
import { prReadiness, type PrReadiness } from "./pr-readiness";
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

/** The first applicable cause of a blocked PR (ADR §1), mirroring `prReadiness`'s own order. */
export function blockedReason(pr: PrInfo): string {
  if (pr.hasConflicts === true) return "conflicts";
  if (pr.checks != null && pr.checks.failing > 0) return "checks failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (pr.unresolvedThreads != null && pr.unresolvedThreads > 0) {
    return `${pr.unresolvedThreads} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"}`;
  }
  return "blocked";
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
      const readiness = prReadiness(pr);
      if (readiness !== "blocked" && readiness !== "ready") continue;
      seenPrUrls.add(pr.url);
      prItems.push({
        kind: "pr",
        tier: readiness,
        pr,
        project,
        workspace,
        reason: readiness === "blocked" ? blockedReason(pr) : "ready to merge",
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

// ── Up next: issues ──

/**
 * `id`, `identifier` or `url` normalized to a comparable ref: `gh-12`, `#12`
 * and `12` all become `"12"`; an issue or PR URL's trailing number becomes
 * that number; anything else (a Linear identifier like `ENG-123`) is
 * lower-cased as is, so it still compares equal to itself.
 */
export function normalizeIssueRef(ref: string): string {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/);
  if (urlMatch) return urlMatch[1];
  const numMatch = /^(?:gh-|#)?(\d+)$/i.exec(trimmed);
  if (numMatch) return numMatch[1];
  return trimmed.toLowerCase();
}

/**
 * Whether `issue` already has a linked workspace somewhere in `projects`:
 * matched by exact URL, or by `normalizeIssueRef` equality between the
 * issue's number and a `WorkspaceInfo.linkedIssues` entry's `id` or
 * `identifier` (`gh-12` ≡ `12` ≡ `#12`, ADR §1).
 */
export function isIssueLinked(
  issue: { url: string; number?: number },
  projects: readonly ProjectInfo[],
): boolean {
  const issueRef = issue.number != null ? normalizeIssueRef(String(issue.number)) : null;
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      for (const linked of workspace.linkedIssues ?? []) {
        if (linked.url === issue.url) return true;
        if (issueRef == null) continue;
        if (normalizeIssueRef(linked.id) === issueRef) return true;
        if (normalizeIssueRef(linked.identifier) === issueRef) return true;
      }
    }
  }
  return false;
}

export interface UpNextIssue {
  source: "github" | "linear";
  /** The top-level entry (project or group) this issue's project belongs to. */
  projectKey: string;
  number?: number;
  identifier: string;
  title: string;
  url: string;
  labels: string[];
  /** Linear priority: 1 Urgent … 4 Low, 0 none. Absent for GitHub issues. */
  priority?: number;
  raw: unknown;
}

/** Sort rank of a Linear priority: 1 Urgent … 4 Low, then none (0 / absent) last. */
function priorityRank(priority: number | undefined): number {
  return priority != null && priority >= 1 && priority <= 4 ? priority : 5;
}

/**
 * `issues` ranked per ADR §1: `ready-for-agent` labelled issues first, then
 * Linear `priority` (ADR-198 §2: Urgent → Low, none last — GitHub issues
 * have none), then `projectOrder` (sidebar order), then lowest issue number
 * (GitHub) or identifier (Linear). The caller is expected to have already dropped linked
 * issues (`isIssueLinked`) — ranking stays pure and doesn't need `projects`.
 */
export function rankUpNext(
  issues: readonly UpNextIssue[],
  projectOrder: readonly string[],
): UpNextIssue[] {
  const orderIndex = new Map(projectOrder.map((key, i) => [key, i]));
  return [...issues].sort((a, b) => {
    const aReady = a.labels.includes("ready-for-agent") ? 0 : 1;
    const bReady = b.labels.includes("ready-for-agent") ? 0 : 1;
    if (aReady !== bReady) return aReady - bReady;

    const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    const aIndex = orderIndex.get(a.projectKey) ?? projectOrder.length;
    const bIndex = orderIndex.get(b.projectKey) ?? projectOrder.length;
    if (aIndex !== bIndex) return aIndex - bIndex;

    if (a.number != null && b.number != null && a.number !== b.number) {
      return a.number - b.number;
    }
    return a.identifier.localeCompare(b.identifier, undefined, { numeric: true });
  });
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

/** A `gh issue list` result as an Up next candidate under `projectKey`. */
export function upNextFromGitHub(issue: GitHubIssue, projectKey: string): UpNextIssue {
  return {
    source: "github",
    projectKey,
    number: issue.number,
    identifier: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
    labels: issue.labels.map((l) => l.name),
    raw: issue,
  };
}

/** A Linear "my issues" result as an Up next candidate under `projectKey`. */
export function upNextFromLinear(issue: LinearIssue, projectKey: string): UpNextIssue {
  return {
    source: "linear",
    projectKey,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    labels: issue.labels.map((l) => l.name),
    priority: issue.priority,
    raw: issue,
  };
}

/**
 * Up next's list: drops issues already linked to a workspace (`isIssueLinked`)
 * and duplicates (two unlinked projects on the same repo list the same issue —
 * the first, in sidebar order, wins), then ranks with `rankUpNext`.
 */
export function upNextList(
  candidates: readonly UpNextIssue[],
  projects: readonly ProjectInfo[],
  projectOrder: readonly string[],
): UpNextIssue[] {
  const ranked = rankUpNext(
    candidates.filter((issue) => !isIssueLinked(issue, projects)),
    projectOrder,
  );
  const seen = new Set<string>();
  return ranked.filter((issue) => {
    if (seen.has(issue.url)) return false;
    seen.add(issue.url);
    return true;
  });
}

/**
 * The first `perProject` items of each project from an already-ranked list,
 * keeping their rank order. Groups come out in `projectOrder` order; keys not
 * in `projectOrder` go last (in first-seen order).
 */
export function topUpNextPerProject<T extends { projectKey: string }>(
  ranked: readonly T[],
  projectOrder: readonly string[],
  perProject: number,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of ranked) {
    const group = groups.get(item.projectKey);
    if (group) group.push(item);
    else groups.set(item.projectKey, [item]);
  }
  const known = new Set(projectOrder);
  const keys = [...projectOrder, ...[...groups.keys()].filter((k) => !known.has(k))];
  return keys.flatMap((key) => (groups.get(key) ?? []).slice(0, perProject));
}

// ── Open PRs ──

export type OpenPrReadiness = Exclude<PrReadiness, "merged" | "closed">;

export interface OpenPrRow {
  pr: PrInfo;
  project: ProjectInfo;
  workspace: WorkspaceInfo;
  readiness: OpenPrReadiness;
  /** "conflicts" / "ready to merge" / "needs review" / "queued to merge" / "draft" / "checks running" / … */
  label: string;
}

const OPEN_PR_RANK: Record<OpenPrReadiness, number> = {
  blocked: 0,
  ready: 1,
  review: 2,
  queued: 3,
  pending: 4,
};

function openPrLabel(pr: PrInfo, readiness: OpenPrReadiness): string {
  switch (readiness) {
    case "blocked":
      return blockedReason(pr);
    case "ready":
      return "ready to merge";
    case "review":
      return "needs review";
    case "queued":
      return "queued to merge";
    case "pending":
      if (pr.isDraft) return "draft";
      if (pr.checks != null && pr.checks.pending > 0) return "checks running";
      return "pending";
  }
}

/**
 * Every open PR across `projects` (deduped by `pr.url`, first wins), ordered
 * blocked, ready, review, queued, pending. Within a rank, `projects` order
 * then workspace order (the sort is stable).
 */
export function openPrRows(projects: readonly ProjectInfo[]): OpenPrRow[] {
  const rows: OpenPrRow[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      const pr = workspace.pr;
      if (!pr || pr.state !== "open") continue;
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      const readiness = prReadiness(pr) as OpenPrReadiness;
      rows.push({ pr, project, workspace, readiness, label: openPrLabel(pr, readiness) });
    }
  }
  return rows.sort((a, b) => OPEN_PR_RANK[a.readiness] - OPEN_PR_RANK[b.readiness]);
}

// ── Project cards ──

export interface ProjectCardSummary {
  key: string;
  name: string;
  color: string | null;
  hostLabel: string;
  path: string;
  needsYou: number;
  workspaceCount: number;
  runningAgents: number;
  openPrs: number;
  pending: { name: string; tier: NeedsYouTier; label: string }[];
}

export interface ProjectCardDeps extends NeedsYouInput {
  hostName: (hostId: string) => string;
}

const AGENT_TIER_LABEL: Record<"input" | "error" | "finished", string> = {
  input: "needs input",
  error: "error",
  finished: "finished",
};

function pendingLabel(item: NeedsYouItem): string {
  if (item.kind === "pr") {
    return item.tier === "blocked" ? item.reason : "ready to merge";
  }
  return AGENT_TIER_LABEL[item.tier];
}

/**
 * The Projects overview card for one top-level entry (a lone project, or a
 * linked group whose sections aggregate). `deps.projects` must be the full
 * project list — it's used to resolve each agent's project the same way
 * `needsYouItems` does — and the result is filtered down to this entry's
 * members.
 */
export function projectCardSummary(
  entry: TopLevelEntry<ProjectInfo>,
  deps: ProjectCardDeps,
): ProjectCardSummary {
  const members: ProjectInfo[] =
    entry.kind === "project" ? [entry.project] : entry.sections.map((s) => s.project);
  const memberIds = new Set(members.map((p) => p.id));

  const workspaceCount = members.reduce(
    (sum, p) => sum + p.workspaces.filter((w) => !w.hidden).length,
    0,
  );

  const memberAgents = deps.agents.filter(
    (a) => a.projectId != null && memberIds.has(a.projectId),
  );
  const runningAgents = runningAgentCount(memberAgents, deps.paneAgentStatus);
  const openPrs = openPrCount(members);

  const scoped = needsYouItems(deps).filter((item) => memberIds.has(item.project.id));

  const pending: ProjectCardSummary["pending"] = [];
  const seenPendingKeys = new Set<string>();
  for (const item of scoped) {
    const dedupeKey = item.workspace?.path ?? `${item.project.id}:${item.kind}:${item.tier}`;
    if (seenPendingKeys.has(dedupeKey)) continue;
    seenPendingKeys.add(dedupeKey);
    pending.push({
      name: item.workspace?.name ?? item.workspace?.path ?? item.project.name,
      tier: item.tier,
      label: pendingLabel(item),
    });
    if (pending.length === 3) break;
  }

  const name = entry.kind === "project" ? entry.project.name : entry.group.name;
  const color = members[0]?.color ?? null;
  const hostLabel = members.map((p) => deps.hostName(p.hostId)).join(" + ");
  const path = primaryMember(entry)?.path ?? "";

  return {
    key: entry.key,
    name,
    color,
    hostLabel,
    path,
    needsYou: scoped.length,
    workspaceCount,
    runningAgents,
    openPrs,
    pending,
  };
}
