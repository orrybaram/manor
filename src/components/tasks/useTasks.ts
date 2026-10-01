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
import { LOCAL_HOST_ID, normalizeHostId } from "../../lib/workspace-key";

/** Query keys that already logged a failure — a flaky source logs once, not every refetch. */
const loggedFailures = new Set<string>();

/** An IPC rejection's message, without Electron's "Error invoking remote method" prefix. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']*': /, "");
}

/**
 * Run each of `fetches` until one succeeds; if all fail, the first failure is
 * logged once and counted (labelled with `name`), never thrown (ADR-198 §3).
 */
async function settle(
  key: string,
  name: string,
  fetches: (() => Promise<TaskRow[]>)[],
): Promise<SourceResult> {
  let first: unknown;
  for (const fetch of fetches) {
    try {
      return { rows: await fetch(), failed: false };
    } catch (err) {
      first ??= err;
    }
  }
  if (!loggedFailures.has(key)) {
    loggedFailures.add(key);
    console.warn(`[TasksView] source ${key} failed:`, first);
  }
  return { rows: [], failed: true, error: `${name}: ${errorText(first)}` };
}

/** Fold the settled queries with `mergeSources`; still loading while any is pending. */
function combineResults(
  results: { data?: SourceResult; isPending: boolean }[],
): {
  rows: TaskRow[];
  loading: boolean;
  failedCount: number;
  failures: string[];
} {
  return {
    ...mergeSources(results.flatMap((r) => (r.data ? [r.data] : []))),
    loading: results.some((r) => r.isPending),
  };
}

/**
 * One tracker to query: a top-level entry, through one of its members —
 * local checkouts first, then the primary — falling back to the others when
 * that fails (its host is down).
 */
export type TaskSource = {
  key: string;
  provider: TaskProvider;
  ctx: TaskContext;
  /** `ctx` through each other member that can list, in the same order. */
  fallbacks: TaskContext[];
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
 * The members to list an entry through, in order: local checkouts first (no
 * host to be down), `primary` first among its kind.
 */
function fetchOrder(
  entry: TopLevelEntry<ProjectInfo>,
  primary: ProjectInfo,
): ProjectInfo[] {
  if (entry.kind === "project") return [primary];
  return [
    primary,
    ...entry.sections.map((s) => s.project).filter((p) => p !== primary),
  ].sort(
    (a, b) =>
      Number(normalizeHostId(a.hostId) !== LOCAL_HOST_ID) -
      Number(normalizeHostId(b.hostId) !== LOCAL_HOST_ID),
  );
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
      const ctxOf = (project: ProjectInfo): TaskContext => ({
        entryKey: entry.key,
        project,
        projectName: entryName(entry),
        color: member.color,
      });
      const members = fetchOrder(entry, member);
      for (const provider of providers) {
        if (!TRACKERS[provider].canList(member)) continue;
        const [first, ...rest] = members
          .filter((p) => TRACKERS[provider].canList(p))
          .map(ctxOf);
        out.push({
          key: `${provider}:${member.id}`,
          provider,
          ctx: first,
          fallbacks: rest,
        });
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
 * deduped and sorted by last update. A query whose members all fail
 * contributes no rows, is counted in `failedCount` and says why in `failures`.
 */
export function useTasks(options: UseTasksOptions): {
  rows: TaskRow[];
  loading: boolean;
  failedCount: number;
  failures: string[];
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
        const tracker = TRACKERS[source.provider];
        const query = tracker.listQuery(source.ctx, scope);
        const fetches = [
          query.queryFn,
          ...source.fallbacks.map(
            (ctx) => tracker.listQuery(ctx, scope).queryFn,
          ),
        ];
        return {
          ...query,
          queryFn: () =>
            settle(`${source.key}:${scope}`, source.ctx.projectName, fetches),
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
    failures: result.failures,
  };
}
