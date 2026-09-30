import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import {
  buildTopLevelEntries,
  type TopLevelEntry,
} from "../../utils/sidebar-items";
import { primaryMember } from "../../lib/home-dashboard";
import type { TaskContext, TaskProvider, TaskRow } from "../../lib/tasks";
import { mergeSources, type SourceResult } from "../../lib/task-list";
import { TRACKERS, type TrackerScope } from "../../lib/trackers";

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

const PROVIDERS = Object.keys(TRACKERS) as TaskProvider[];

/** One array per set of providers, so callers can memo on it. */
const providerSets = new Map<string, TaskProvider[]>();

function providerSet(providers: TaskProvider[]): TaskProvider[] {
  const key = providers.join(",");
  const cached = providerSets.get(key);
  if (cached) return cached;
  providerSets.set(key, providers);
  return providers;
}

function entryName(entry: TopLevelEntry<ProjectInfo>): string {
  return entry.kind === "project" ? entry.project.name : entry.group.name;
}

/**
 * Which trackers are usable, through each adapter's status query — shared
 * with the Sidebar so both read one cached answer. A tracker is only asked
 * when some project can be listed through it (or there are no projects yet,
 * so the Tasks view can still tell "connected" from "not set up").
 */
export function useTrackerStatus(): {
  /** Usable trackers, in `TRACKERS` order. */
  providers: TaskProvider[];
  /** True until every status check that was asked has answered. */
  checking: boolean;
} {
  const projects = useProjectStore((s) => s.projects);

  const asked = PROVIDERS.map(
    (provider) =>
      projects.length === 0 ||
      projects.some((p) => TRACKERS[provider].canList(p)),
  );
  const results = useQueries({
    queries: PROVIDERS.map((provider, i) => ({
      ...TRACKERS[provider].statusQuery(),
      retry: false,
      enabled: asked[i],
    })),
  });

  const providers = providerSet(
    PROVIDERS.filter((_, i) => asked[i] && results[i].data === true),
  );

  return {
    providers,
    checking: results.some((r, i) => asked[i] && r.isPending),
  };
}

/**
 * Which trackers are usable, and the top-level entries each can be queried
 * through (`tracker.canList` of the entry's primary member).
 */
export function useTrackerSources(): {
  providers: TaskProvider[];
  checking: boolean;
  sources: TaskSource[];
} {
  const projects = useProjectStore((s) => s.projects);
  const entries = useMemo(() => buildTopLevelEntries(projects), [projects]);
  const { providers, checking } = useTrackerStatus();

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
      for (const provider of providers) {
        if (!TRACKERS[provider].canList(member)) continue;
        out.push({ key: `${provider}:${member.id}`, provider, ctx });
      }
    }
    return out;
  }, [entries, providers]);

  return { providers, checking, sources };
}

/**
 * Where the saved choice lands now (ADR-202 §4): the saved tracker if it's
 * still usable, else the first usable one; the saved project if that tracker
 * can still list it, else all projects. The choice itself isn't forgotten.
 * The Tasks view and Up next both resolve their list through this.
 */
export function useTaskScope(
  savedProvider: TaskProvider,
  savedProject: string | null,
): {
  providers: TaskProvider[];
  checking: boolean;
  provider: TaskProvider;
  projectKey: string | null;
  /** The chosen provider's sources — one per project it can list. */
  sources: TaskSource[];
  /** The source of `projectKey`, when one is chosen. */
  selectedSource: TaskSource | undefined;
} {
  const status = useTrackerSources();
  const { providers, checking } = status;
  const provider: TaskProvider = providers.includes(savedProvider)
    ? savedProvider
    : (providers[0] ?? savedProvider);

  const sources = useMemo(
    () => status.sources.filter((s) => s.provider === provider),
    [status.sources, provider],
  );
  const selectedSource =
    savedProject === null
      ? undefined
      : sources.find((s) => s.ctx.entryKey === savedProject);

  return {
    providers,
    checking,
    provider,
    projectKey: selectedSource ? savedProject : null,
    sources,
    selectedSource,
  };
}

export type UseTasksOptions = {
  provider: TaskProvider;
  /** A top-level entry key, or null for every project. */
  projectKey: string | null;
};

const SCOPES: TrackerScope[] = ["assigned", "open"];

/**
 * Tasks for the Tasks view and Up next (ADR-198 §3): for each top-level entry of
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
