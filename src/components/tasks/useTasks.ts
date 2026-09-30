import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import {
  buildTopLevelEntries,
  type TopLevelEntry,
} from "../../utils/sidebar-items";
import { primaryMember } from "../../lib/home-dashboard";
import type { TaskContext, TaskProvider, TaskRow } from "../../lib/tasks";
import { mergeSources, type SourceResult } from "../../lib/task-list";
import { TRACKERS, type TrackerScope } from "../../lib/trackers";

const STALE_MS = 60_000;

/** Query keys that already logged a failure — a flaky source logs once, not every refetch. */
const loggedFailures = new Set<string>();

/** Run `fetch`; a failure is logged once and counted, never thrown (ADR-198 §3). */
async function settle(
  key: string,
  fetch: () => Promise<TaskRow[]>,
): Promise<SourceResult> {
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

/** Fold the settled queries with `mergeSources`; still loading while any is pending. */
function combineResults(
  results: { data?: SourceResult; isPending: boolean }[],
): {
  rows: TaskRow[];
  loading: boolean;
  failedCount: number;
} {
  return {
    ...mergeSources(results.flatMap((r) => (r.data ? [r.data] : []))),
    loading: results.some((r) => r.isPending),
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
 * through. Shares its status query keys with the Sidebar so both read one
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
    queryKey: ["trackers", "github", "status"],
    queryFn: () => window.electronAPI.github.checkStatus(),
    staleTime: Infinity,
    retry: false,
  });
  const ghReady =
    ghStatus.data?.installed === true && ghStatus.data.authenticated === true;

  const anyLinear = projects.some((p) => p.linearAssociations.length > 0);
  const linearStatus = useQuery({
    queryKey: ["trackers", "linear", "status"],
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
        out.push({
          key: `gh:${member.hostId}:${member.path}`,
          provider: "github",
          ctx,
        });
      }
      if (linearConnected && TRACKERS.linear.canList(member)) {
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
};

const SCOPES: TrackerScope[] = ["assigned", "open"];

/**
 * Tasks for the Tasks view (ADR-198 §3): for each top-level entry of
 * `provider` (just the chosen entry when `projectKey` is set), its open tasks
 * and the ones assigned to you — merged, with yours marked `assignedToMe`,
 * deduped and sorted by last update. A failing query contributes no rows and
 * is counted in `failedCount`.
 */
export function useTasks(options: UseTasksOptions): {
  rows: TaskRow[];
  loading: boolean;
  failedCount: number;
} {
  const { provider, projectKey } = options;

  const tracker = useTrackerSources();

  const sources = useMemo(
    () =>
      tracker.sources.filter(
        (s) =>
          s.provider === provider &&
          (projectKey === null || s.ctx.entryKey === projectKey),
      ),
    [tracker.sources, provider, projectKey],
  );

  const result = useQueries({
    // Module-level, so the combined value only changes when a query does.
    combine: combineResults,
    queries: sources.flatMap((source) =>
      SCOPES.map((scope) => {
        const query = TRACKERS[source.provider].listQuery(source.ctx, scope);
        return {
          ...query,
          queryFn: () => settle(`${source.key}:${scope}`, query.queryFn),
          retry: false,
        };
      }),
    ),
  });

  return {
    rows: result.rows,
    // Hold the skeleton while the tracker checks are still out, too.
    loading: result.loading || (tracker.checking && sources.length === 0),
    failedCount: result.failedCount,
  };
}
