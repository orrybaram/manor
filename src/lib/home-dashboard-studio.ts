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
import {
  blockerLabel,
  PR_STAGES,
  prVerdict,
  type PrBlocker,
  type PrStage,
  type PrVerdict,
} from "./pr-readiness";
import type { ChecksSummary, PrInfo } from "./pr-info";
import { describeHost, groupHostState, isHostOffline } from "./host-status";
import { workspaceKey } from "./workspace-key";
import {
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

function pipelineLabel(pr: PrInfo, verdict: PrVerdict): string | null {
  if (verdict.blocker) return blockerLabel(verdict.blocker);
  if (pr.queuedToMerge) return "queued";
  if (pr.isDraft) return "draft";
  return null;
}

/**
 * Every open PR across `projects` (deduped by `pr.url`, first wins, like
 * `openPrRows`) in its `prVerdict` stage column, columns in `PR_STAGES` order. Within
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
      const verdict = prVerdict(pr);
      // An open PR always has a stage; this narrows away the merged/closed arm.
      if (verdict.stage == null) continue;
      const ageMs = ageSince(pr.updatedAt, now);
      columns.get(verdict.stage)!.push({
        pr,
        project,
        workspace,
        label: pipelineLabel(pr, verdict),
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
  | PrBlocker
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

function cardContext(
  item: NeedsYouItem,
  input: NeedsYouCardsInput,
): NeedsYouCardContext {
  if (item.kind === "pr") {
    if (item.tier === "blocked") {
      const { blocker } = prVerdict(item.pr);
      if (blocker) return blocker;
    }
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
  /** PRs in the review stage: the "N PRs are out for review" clause. */
  inReview: number;
  /** Every open PR, whatever its stage: decides whether "all quiet" is true. */
  openPrs: number;
}

/** One line per variant; `n` is the count the clause is about. */
type Lines = readonly ((n: number) => string)[];

const NEEDS_YOU_ONE: Lines = [
  () => "One thing's waiting on you.",
  () => "Someone wants a word.",
  () => "One knock at the door.",
];
const NEEDS_YOU_MANY: Lines = [
  (n) => `${n} things are waiting on you.`,
  (n) => `${n} things want your eyes.`,
  (n) => `You're popular... ${n} things need you.`,
];
const FREE: Lines = [
  () => "You're off the hook.",
  () => "Nothing's on your plate.",
  () => "Your queue is empty.",
];
const IDLE_LEAD: Lines = [
  () => "All quiet.",
  () => "Blank slate.",
  () => "Nothing's on fire.",
];
const IDLE_REST: Lines = [
  () => "Good time to start something new.",
  () => "Pick something from Up next?",
  () => "Enjoy it while it lasts.",
];
const RUNNING_ONE: Lines = [
  () => "an agent is heads-down",
  () => "an agent is cooking",
  () => "one agent is hard at work",
];
const RUNNING_MANY: Lines = [
  (n) => `${n} agents are heads-down`,
  (n) => `${n} agents are cooking`,
  (n) => `${n} agents are hard at work`,
];
const REVIEW_ONE: Lines = [
  () => "a PR is out for review",
  () => "a PR is waiting on reviewers",
  () => "one PR is in someone else's hands",
];
const REVIEW_MANY: Lines = [
  (n) => `${n} PRs are out for review`,
  (n) => `${n} PRs are waiting on reviewers`,
  (n) => `${n} PRs are in reviewers' hands`,
];
const NO_AGENTS: Lines = [
  () => "Your agents are taking five.",
  () => "The agents are on standby.",
  () => "No agents running right now.",
];

/**
 * Pick a line from `lines` by `seed`, salted per pool so every clause
 * doesn't land on the same index.
 */
function pick(lines: Lines, seed: number, salt: number, n: number): string {
  const i = Math.abs((seed * 31 + salt * 17) % lines.length);
  return lines[i]!(n);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The header sentence (ADR-198 §1.1): a lead about Needs you, then what's
 * in flight — "3 things want your eyes." then "2 agents are cooking and a
 * PR is out for review." Each situation has a few phrasings; `seed` picks
 * one, so the caller holds a line steady by holding the seed (Home passes
 * the day). Zero clauses are left out; with neither agents nor PRs in
 * review it says what is actually true — the agents are idle while PRs are
 * open in other stages, and the "all quiet" lines only when nothing at all
 * is going on.
 */
export function headline(
  counts: HeadlineCounts,
  seed = 0,
): {
  lead: string;
  rest: string;
} {
  const clauses: string[] = [];
  if (counts.running > 0) {
    clauses.push(
      counts.running === 1
        ? pick(RUNNING_ONE, seed, 1, 1)
        : pick(RUNNING_MANY, seed, 1, counts.running),
    );
  }
  if (counts.inReview > 0) {
    clauses.push(
      counts.inReview === 1
        ? pick(REVIEW_ONE, seed, 2, 1)
        : pick(REVIEW_MANY, seed, 2, counts.inReview),
    );
  }
  const idle = counts.running === 0 && counts.openPrs === 0;
  const rest =
    clauses.length > 0
      ? `${capitalize(clauses.join(" and "))}.`
      : idle && counts.needsYou === 0
        ? pick(IDLE_REST, seed, 3, 0)
        : pick(NO_AGENTS, seed, 3, 0);

  if (counts.needsYou > 0) {
    const lead =
      counts.needsYou === 1
        ? pick(NEEDS_YOU_ONE, seed, 0, 1)
        : pick(NEEDS_YOU_MANY, seed, 0, counts.needsYou);
    return { lead, rest };
  }
  return {
    lead: idle ? pick(IDLE_LEAD, seed, 0, 0) : pick(FREE, seed, 0, 0),
    rest,
  };
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
        else if (pr && prVerdict(pr).stage === "ready") state = "pr-ready";
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
