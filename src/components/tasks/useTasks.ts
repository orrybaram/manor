import { useCallback, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { buildTopLevelEntries, type TopLevelEntry } from "../../utils/sidebar-items";
import { ghRepoOf } from "../../lib/gh-repo";
import { primaryMember } from "../../lib/home-dashboard";
import {
  collectTasks,
  fromGitHub,
  fromLinear,
  type TaskContext,
  type TaskFilter,
  type TaskProvider,
  type TaskRow,
} from "../../lib/tasks";

const STALE_MS = 60_000;
const LIMIT = 50;
/** Linear state types that count as "open" work. */
const OPEN_LINEAR_STATES = ["unstarted", "started", "backlog"];

/** Query keys that already logged a failure — a flaky source logs once, not every refetch. */
const loggedFailures = new Set<string>();

type SourceResult = { rows: TaskRow[]; failed: boolean };

/** Run `fetch`; a failure is logged once and counted, never thrown (ADR-198 §3). */
async function settle(key: string, fetch: () => Promise<TaskRow[]>): Promise<SourceResult> {
  try {
    return { rows: await fetch(), failed: false };
  } catch (err) {
    if (!loggedFailures.has(key)) {
      loggedFailures.add(key);
      console.warn(`[TasksView] source ${key} failed:`, err);
    }
    return { rows: [], failed: true };
  }
}

function combineResults(results: { data?: SourceResult; isPending: boolean }[]): {
  rows: TaskRow[];
  loading: boolean;
  failedCount: number;
} {
  return {
    rows: collectTasks(results.flatMap((r) => r.data?.rows ?? [])),
    loading: results.some((r) => r.isPending),
    failedCount: results.filter((r) => r.data?.failed).length,
  };
}

/** One tracker to query: a top-level entry, through its primary member. */
export type TaskSource = {
  key: string;
  provider: TaskProvider;
  ctx: TaskContext;
};

function entryName(entry: TopLevelEntry<ProjectInfo>): string {
  return entry.kind === "project" ? entry.project.name : entry.group.name;
}

/**
 * Which trackers are usable, and the top-level entries they can be queried
 * through. Shares its status query keys with Home's Up next so both read one
 * cached answer.
 */
export function useTrackerSources(): {
  entries: TopLevelEntry<ProjectInfo>[];
  ghReady: boolean;
  linearConnected: boolean;
  /** True until both status checks have answered. */
  checking: boolean;
  sources: TaskSource[];
} {
  const projects = useProjectStore((s) => s.projects);
  const entries = useMemo(() => buildTopLevelEntries(projects), [projects]);

  const ghStatus = useQuery({
    queryKey: ["home-up-next", "gh-status"],
    queryFn: () => window.electronAPI.github.checkStatus(),
    staleTime: Infinity,
    retry: false,
  });
  const ghReady = ghStatus.data?.installed === true && ghStatus.data.authenticated === true;

  const anyLinear = projects.some((p) => p.linearAssociations.length > 0);
  const linearStatus = useQuery({
    queryKey: ["home-up-next", "linear-connected"],
    queryFn: () => window.electronAPI.linear.isConnected(),
    staleTime: STALE_MS,
    retry: false,
    enabled: anyLinear,
  });
  const linearConnected = anyLinear && linearStatus.data === true;

  const sources = useMemo(() => {
    const out: TaskSource[] = [];
    for (const entry of entries) {
      const member = primaryMember(entry);
      if (!member) continue;
      const ctx: TaskContext = {
        entryKey: entry.key,
        project: member,
        projectName: entryName(entry),
        color: member.color,
      };
      if (ghReady) {
        out.push({ key: `gh:${member.hostId}:${member.path}`, provider: "github", ctx });
      }
      if (linearConnected && member.linearAssociations.length > 0) {
        out.push({ key: `linear:${member.id}`, provider: "linear", ctx });
      }
    }
    return out;
  }, [entries, ghReady, linearConnected]);

  return {
    entries,
    ghReady,
    linearConnected,
    checking: ghStatus.isPending || (anyLinear && linearStatus.isPending),
    sources,
  };
}

export type UseTasksOptions = {
  provider: TaskProvider;
  /** A top-level entry key, or null for every project. */
  projectKey: string | null;
  filter: TaskFilter;
};

/**
 * Tasks for the Tasks view (ADR-198 §3): one query per top-level entry for
 * `provider` (just the chosen entry when `projectKey` is set), normalised,
 * deduped and sorted by last update. A failing source contributes no rows
 * and is counted in `failedCount`.
 */
export function useTasks(options: UseTasksOptions): {
  rows: TaskRow[];
  loading: boolean;
  failedCount: number;
  refetch: () => void;
} {
  const { provider, projectKey, filter } = options;

  const tracker = useTrackerSources();
  const queryClient = useQueryClient();

  const sources = useMemo(
    () =>
      tracker.sources.filter(
        (s) => s.provider === provider && (projectKey === null || s.ctx.entryKey === projectKey),
      ),
    [tracker.sources, provider, projectKey],
  );

  const result = useQueries({
    // Module-level, so the combined value only changes when a query does.
    combine: combineResults,
    queries: sources.map((source) => {
      const { ctx } = source;
      const member = ctx.project;
      if (source.provider === "github") {
        return {
          queryKey: ["tasks", "github", filter, member.hostId, member.path, ctx.entryKey],
          queryFn: () =>
            settle(`${source.key}:${filter}`, async () => {
              const repo = ghRepoOf(member);
              const issues =
                filter === "assigned"
                  ? await window.electronAPI.github.getMyIssues(repo, LIMIT, "open")
                  : await window.electronAPI.github.getAllIssues(repo, LIMIT, "open");
              return issues.map((i) => fromGitHub(i, ctx));
            }),
          staleTime: STALE_MS,
          retry: false,
        };
      }
      const teamIds = member.linearAssociations.map((a) => a.teamId);
      return {
        queryKey: ["tasks", "linear", filter, member.id, teamIds.join(","), ctx.entryKey],
        queryFn: () =>
          settle(`${source.key}:${filter}`, async () => {
            const opts = { stateTypes: OPEN_LINEAR_STATES, limit: LIMIT };
            const issues =
              filter === "assigned"
                ? await window.electronAPI.linear.getMyIssues(teamIds, opts)
                : await window.electronAPI.linear.getAllIssues(teamIds, opts);
            return issues.map((i) => fromLinear(i, ctx));
          }),
        staleTime: STALE_MS,
        retry: false,
      };
    }),
  });

  const refetch = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: ["tasks", provider, filter] });
  }, [queryClient, provider, filter]);

  return {
    rows: result.rows,
    // Hold the skeleton while the tracker checks are still out, too.
    loading: result.loading || (tracker.checking && sources.length === 0),
    failedCount: result.failedCount,
    refetch,
  };
}
