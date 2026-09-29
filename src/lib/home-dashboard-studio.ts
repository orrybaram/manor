/**
 * ADR-198 §2: pure selectors for the full Home dashboard ("Studio") — the PR
 * pipeline, Needs you cards, the headline sentence, the Open PRs stat tile
 * and the project tiles. Like `home-dashboard.ts` (whose helpers these build
 * on) there are no store or React imports: the components wire store state in.
 */

import type { ActivePort } from "../electron.d";
import type {
  DiffStats,
  ProjectInfo,
  WorkspaceInfo,
} from "../store/project-store";
import type { HostStatusInfo } from "../store/host-store";
import { buildTopLevelEntries } from "../utils/sidebar-items";
import { prReadiness } from "./pr-readiness";
import type { ChecksSummary, PrInfo } from "./pr-info";
import { describeHost, groupHostState, isHostOffline } from "./host-status";
import { workspaceKey } from "./workspace-key";
import {
  blockedReason,
  itemKey,
  needsYouItems,
  openPrCount,
  resolveAgentContext,
  runningAgentCount,
  type NeedsYouInput,
  type NeedsYouItem,
} from "./home-dashboard";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `iso` to `now` (never negative), or null when `iso` is absent or unparseable. */
function ageSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, now - at);
}

// ── Pull requests pipeline ──

/** The pipeline's columns, in display order (ADR-198 §1.6). */
export type PrStage = "checks" | "review" | "blocked" | "ready";

export const PR_STAGES: readonly PrStage[] = [
  "checks",
  "review",
  "blocked",
  "ready",
];

/**
 * The pipeline column an open PR sits in (ADR-198 §2): `blocked` and `ready`
 * follow `prReadiness` (`queued` counts as ready); a `pending` PR with checks
 * still running is in `checks`; everything else — `review`, drafts and
 * pending PRs with nothing running — waits in `review`.
 */
export function prStage(pr: PrInfo): PrStage {
  switch (prReadiness(pr)) {
    case "blocked":
      return "blocked";
    case "ready":
    case "queued":
      return "ready";
    case "review":
      return "review";
    default:
      return pr.checks != null && pr.checks.pending > 0 ? "checks" : "review";
  }
}

export interface PipelineRow {
  pr: PrInfo;
  project: ProjectInfo;
  workspace: WorkspaceInfo;
  /** The blocked reason, "queued" or "draft"; null when the column says it all. */
  label: string | null;
  checks: Pick<
    ChecksSummary,
    "passing" | "failing" | "pending" | "total"
  > | null;
  /** Time since `pr.updatedAt`; null when GitHub didn't report it. */
  ageMs: number | null;
  /** No activity for a day or more. */
  stale: boolean;
}

export interface PipelineColumn {
  stage: PrStage;
  rows: PipelineRow[];
}

function pipelineLabel(pr: PrInfo, stage: PrStage): string | null {
  if (stage === "blocked") return blockedReason(pr);
  if (pr.queuedToMerge) return "queued";
  if (pr.isDraft) return "draft";
  return null;
}

/**
 * Every open PR across `projects` (deduped by `pr.url`, first wins, like
 * `openPrRows`) in its `prStage` column, columns in `PR_STAGES` order. Within
 * a column the oldest `updatedAt` comes first; PRs of unknown age go last in
 * `projects` then workspace order.
 */
export function prPipeline(
  projects: readonly ProjectInfo[],
  now: number,
): PipelineColumn[] {
  const columns = new Map<PrStage, PipelineRow[]>(
    PR_STAGES.map((stage) => [stage, []]),
  );
  const seen = new Set<string>();
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      const pr = workspace.pr;
      if (!pr || pr.state !== "open") continue;
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      const stage = prStage(pr);
      const ageMs = ageSince(pr.updatedAt, now);
      columns.get(stage)!.push({
        pr,
        project,
        workspace,
        label: pipelineLabel(pr, stage),
        checks: pr.checks
          ? {
              passing: pr.checks.passing,
              failing: pr.checks.failing,
              pending: pr.checks.pending,
              total: pr.checks.total,
            }
          : null,
        ageMs,
        stale: ageMs != null && ageMs >= DAY_MS,
      });
    }
  }
  return PR_STAGES.map((stage) => ({
    stage,
    // Stable sort: unknown ages tie with each other and keep insertion order.
    rows: columns.get(stage)!.sort((a, b) => {
      if (a.ageMs == null || b.ageMs == null) {
        return (a.ageMs == null ? 1 : 0) - (b.ageMs == null ? 1 : 0);
      }
      return b.ageMs - a.ageMs;
    }),
  }));
}

export interface OpenPrStats {
  total: number;
  /** The oldest known PR age; null when no PR has one. */
  oldestAgeMs: number | null;
  byStage: Record<PrStage, number>;
}

/** The Open PRs stat tile: count, oldest age and the stacked stage bar. */
export function openPrStats(pipeline: readonly PipelineColumn[]): OpenPrStats {
  const byStage: Record<PrStage, number> = {
    checks: 0,
    review: 0,
    blocked: 0,
    ready: 0,
  };
  let total = 0;
  let oldestAgeMs: number | null = null;
  for (const column of pipeline) {
    byStage[column.stage] += column.rows.length;
    total += column.rows.length;
    for (const row of column.rows) {
      if (
        row.ageMs != null &&
        (oldestAgeMs == null || row.ageMs > oldestAgeMs)
      ) {
        oldestAgeMs = row.ageMs;
      }
    }
  }
  return { total, oldestAgeMs, byStage };
}

// ── Needs you cards ──

/** What a Needs you card shows under its title (ADR-198 §2). */
export type NeedsYouCardContext =
  | { kind: "input" }
  | { kind: "error"; paneTitle?: string }
  | {
      kind: "checks";
      /** Named failing runs from `pr.checkRuns` — may be fewer than `failingCount`. */
      failing: { name: string; url: string | null }[];
      failingCount: number;
      passing: number;
      total: number;
    }
  | { kind: "conflicts" }
  | { kind: "changes-requested" }
  | { kind: "threads"; count: number }
  | { kind: "finished"; diff?: DiffStats }
  | {
      kind: "ready";
      approved: boolean;
      checksPassing: number;
      checksTotal: number;
    };

export type NeedsYouCard = NeedsYouItem & {
  /** `itemKey(item)` — the React key and the snooze key. */
  key: string;
  context: NeedsYouCardContext;
  /** How long the item has waited: since the agent's last update, or the PR's `updatedAt`. */
  ageMs: number | null;
};

export interface NeedsYouCardsInput extends NeedsYouInput {
  /** Live pane titles, for an errored agent's card. */
  paneTitle?: Readonly<Record<string, string>>;
  /** Item keys the user snoozed (ADR-198 §4); those cards are dropped. */
  snoozed?: ReadonlySet<string>;
}

/** A blocked PR's context, in `blockedReason`'s order. */
function blockedContext(pr: PrInfo): NeedsYouCardContext {
  if (pr.hasConflicts === true) return { kind: "conflicts" };
  if (pr.checks != null && pr.checks.failing > 0) {
    return {
      kind: "checks",
      failing: (pr.checkRuns ?? [])
        .filter((run) => run.status === "failing")
        .map((run) => ({ name: run.name, url: run.url ?? null })),
      failingCount: pr.checks.failing,
      passing: pr.checks.passing,
      total: pr.checks.total,
    };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { kind: "changes-requested" };
  return { kind: "threads", count: pr.unresolvedThreads ?? 0 };
}

function cardContext(
  item: NeedsYouItem,
  input: NeedsYouCardsInput,
): NeedsYouCardContext {
  if (item.kind === "pr") {
    if (item.tier === "blocked") return blockedContext(item.pr);
    return {
      kind: "ready",
      approved: item.pr.reviewDecision === "APPROVED",
      checksPassing: item.pr.checks?.passing ?? 0,
      checksTotal: item.pr.checks?.total ?? 0,
    };
  }
  switch (item.tier) {
    case "input":
      return { kind: "input" };
    case "error": {
      const paneTitle = item.agent.paneId
        ? input.paneTitle?.[item.agent.paneId]
        : undefined;
      return paneTitle ? { kind: "error", paneTitle } : { kind: "error" };
    }
    case "finished": {
      const diff = item.workspace?.diffStats;
      return diff
        ? {
            kind: "finished",
            diff: { added: diff.added, removed: diff.removed },
          }
        : { kind: "finished" };
    }
  }
}

/**
 * `needsYouItems` (same tier order) as dashboard cards with their context
 * block and age, minus anything in `input.snoozed`.
 */
export function needsYouCards(
  input: NeedsYouCardsInput,
  now: number,
): NeedsYouCard[] {
  const cards: NeedsYouCard[] = [];
  for (const item of needsYouItems(input)) {
    const key = itemKey(item);
    if (input.snoozed?.has(key)) continue;
    cards.push({
      ...item,
      key,
      context: cardContext(item, input),
      ageMs:
        item.kind === "agent"
          ? ageSince(item.agent.updatedAt, now)
          : ageSince(item.pr.updatedAt, now),
    });
  }
  return cards;
}

// ── Headline ──

export interface HeadlineCounts {
  needsYou: number;
  running: number;
  /** PRs in the review stage: the "N PRs are with reviewers" clause. */
  inReview: number;
  /** Every open PR, whatever its stage: decides whether "no open PRs" is true. */
  openPrs: number;
}

/**
 * The header sentence (ADR-198 §1.1): "3 things need you." then "3 agents
 * are working and 5 PRs are with reviewers." Zero clauses are left out; when
 * both are zero the sentence says what is actually true — "No agents
 * running." while PRs are open in other stages, and "All clear." only when
 * nothing at all is going on.
 */
export function headline(counts: HeadlineCounts): {
  lead: string;
  rest: string;
} {
  const clauses: string[] = [];
  if (counts.running > 0) {
    clauses.push(
      counts.running === 1
        ? "1 agent is working"
        : `${counts.running} agents are working`,
    );
  }
  if (counts.inReview > 0) {
    clauses.push(
      counts.inReview === 1
        ? "1 PR is with reviewers"
        : `${counts.inReview} PRs are with reviewers`,
    );
  }
  const idle = counts.running === 0 && counts.openPrs === 0;
  const rest =
    clauses.length > 0
      ? `${clauses.join(" and ")}.`
      : idle
        ? "No agents running and no open PRs."
        : "No agents running.";

  if (counts.needsYou > 0) {
    const lead =
      counts.needsYou === 1
        ? "1 thing needs you."
        : `${counts.needsYou} things need you.`;
    return { lead, rest };
  }
  return { lead: idle ? "All clear." : "Nothing needs you.", rest };
}

// ── Project tiles ──

/** A workspace block's colour, most urgent first (ADR-198 §2). */
export type WorkspaceTileState =
  | "needs-you"
  | "running"
  | "pr-ready"
  | "pr-open"
  | "idle";

export type HostTileState = "online" | "partial" | "offline";

/** The port fields a tile reads — `ActivePort`-shaped, supplied by the shared ports store. */
export type TilePort = Pick<
  ActivePort,
  "port" | "processName" | "workspacePath" | "hostId"
>;

export interface ProjectTile {
  /** The top-level entry key: a project id or a group id. */
  key: string;
  name: string;
  color: string | null;
  host: {
    /** Host names, joined " + " for a group spread over several hosts. */
    label: string;
    state: HostTileState;
    /** The first away host's `describeHost` status ("Reconnecting in 4s"); absent when online. */
    status?: string;
  };
  workspaces: {
    /** ADR-191 workspace key (falls back to the path when it can't be keyed). */
    key: string;
    projectId: string;
    name: string;
    path: string;
    state: WorkspaceTileState;
  }[];
  diff: DiffStats;
  needsYou: number;
  running: number;
  openPrs: number;
  port?: { port: number; label: string };
}

export interface ProjectTileDeps extends NeedsYouInput {
  hosts: readonly HostStatusInfo[];
  hostName: (hostId: string) => string;
  /** Listening dev-server ports; the lowest one on a member workspace is shown. */
  ports?: readonly TilePort[];
  snoozed?: ReadonlySet<string>;
  /** Drives the reconnect countdown in `host.status`. */
  now: number;
}

const HOST_TILE_STATE = {
  connected: "online",
  "partially-offline": "partial",
  offline: "offline",
} as const;

/** `project.id` + NUL + path: a workspace's identity within the full project list. */
function wsId(projectId: string, path: string): string {
  return `${projectId}\u0000${path}`;
}

function safeWorkspaceKey(hostId: string, path: string): string {
  try {
    return workspaceKey(hostId, path);
  } catch {
    return path;
  }
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * One tile per top-level sidebar entry (a lone project, or an ADR-192 linked
 * group whose members aggregate), keyed like Up next's entries. `projects`
 * must be the full list: agents are resolved against it the same way
 * `needsYouItems` does. Hidden workspaces are left out of the blocks and the
 * diff totals.
 */
export function projectTiles(
  projects: readonly ProjectInfo[],
  deps: ProjectTileDeps,
): ProjectTile[] {
  const input: NeedsYouInput = { ...deps, projects };
  const items = needsYouItems(input).filter(
    (item) => !deps.snoozed?.has(itemKey(item)),
  );

  const needsYouWs = new Set<string>();
  for (const item of items) {
    if (item.workspace)
      needsYouWs.add(wsId(item.project.id, item.workspace.path));
  }

  const runningWs = new Set<string>();
  for (const agent of deps.agents) {
    if (agent.status !== "active" || !agent.paneId) continue;
    const status = deps.paneAgentStatus[agent.paneId]?.status;
    if (status !== "thinking" && status !== "working") continue;
    const resolved = resolveAgentContext(agent, projects);
    if (resolved?.workspace)
      runningWs.add(wsId(resolved.project.id, resolved.workspace.path));
  }

  return buildTopLevelEntries(projects).map((entry) => {
    const members =
      entry.kind === "project"
        ? [entry.project]
        : entry.sections.map((s) => s.project);
    const memberIds = new Set(members.map((p) => p.id));

    const workspaces: ProjectTile["workspaces"] = [];
    const diff: DiffStats = { added: 0, removed: 0 };
    for (const project of members) {
      for (const ws of project.workspaces) {
        if (ws.hidden) continue;
        const id = wsId(project.id, ws.path);
        const pr = ws.pr && ws.pr.state === "open" ? ws.pr : null;
        let state: WorkspaceTileState = "idle";
        if (needsYouWs.has(id)) state = "needs-you";
        else if (runningWs.has(id)) state = "running";
        else if (pr && prStage(pr) === "ready") state = "pr-ready";
        else if (pr) state = "pr-open";
        workspaces.push({
          key: safeWorkspaceKey(project.hostId, ws.path),
          projectId: project.id,
          name: ws.name ?? basename(ws.path),
          path: ws.path,
          state,
        });
        diff.added += ws.diffStats?.added ?? 0;
        diff.removed += ws.diffStats?.removed ?? 0;
      }
    }

    const hostIds = members.map((p) => p.hostId);
    const state = HOST_TILE_STATE[groupHostState(hostIds, deps.hosts)];
    const awayHost = hostIds.find((id) => isHostOffline(id, deps.hosts));
    const status = awayHost
      ? describeHost(
          deps.hosts.find((h) => h.hostId === awayHost),
          deps.now,
        )?.status
      : undefined;

    let port: ProjectTile["port"];
    for (const candidate of deps.ports ?? []) {
      if (!candidate.workspacePath) continue;
      const owned = members.some(
        (p) =>
          p.hostId === candidate.hostId &&
          p.workspaces.some(
            (ws) => !ws.hidden && ws.path === candidate.workspacePath,
          ),
      );
      if (owned && (port == null || candidate.port < port.port)) {
        port = { port: candidate.port, label: candidate.processName };
      }
    }

    const memberAgents = deps.agents.filter(
      (a) => a.projectId != null && memberIds.has(a.projectId),
    );

    return {
      key: entry.key,
      name: entry.kind === "project" ? entry.project.name : entry.group.name,
      color: members[0]?.color ?? null,
      host: {
        label: [...new Set(hostIds.map((id) => deps.hostName(id)))].join(" + "),
        state,
        ...(status ? { status } : {}),
      },
      workspaces,
      diff,
      needsYou: items.filter((item) => memberIds.has(item.project.id)).length,
      running: runningAgentCount(memberAgents, deps.paneAgentStatus),
      openPrs: openPrCount(members),
      ...(port ? { port } : {}),
    };
  });
}
