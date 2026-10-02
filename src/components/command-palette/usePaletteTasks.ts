import { useDeferredValue, useMemo } from "react";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { entryLookup, taskList } from "../../lib/task-list";
import {
  DEFAULT_TASK_SORT,
  sortTasksBy,
  type LinkedTask,
  type TaskProvider,
  type TaskRef,
  type TaskRow,
} from "../../lib/tasks";
import { trackerFor } from "../../lib/trackers";
import { useTasks, useTrackerStatus } from "../tasks/useTasks";

/** How many matching tasks the palette lists; "See all" covers the rest. */
const PALETTE_TASK_LIMIT = 5;

/** A row of the palette's Tasks group: a tracker task, or one linked to a workspace. */
export type PaletteTask = TaskRow | LinkedTask;

type UsePaletteTasksOptions = {
  search: string;
  /** The ADR-200 scope chip's project, or null for every project. */
  scopeProjectId: string | null;
  /** The palette is open on its root view. */
  enabled: boolean;
};

type PaletteTasks = {
  /** The top matches, most recently updated first. */
  rows: PaletteTask[];
  /**
   * The tracker "See all" opens: the top match's. The Tasks view lists one
   * tracker at a time.
   */
  seeAllProvider: TaskProvider | null;
  /** Every match in `seeAllProvider` — the "See all N" count. */
  total: number;
  /** The scoped project's top-level entry key, for "See all". */
  projectKey: string | null;
};

const NONE: PaletteTask[] = [];

/**
 * ADR-207 §4: the tasks matching the palette's query, across every usable
 * tracker, through the Tasks view's list pipeline (and query cache). Nothing
 * is fetched until the query is non-empty.
 */
export function usePaletteTasks(options: UsePaletteTasksOptions): PaletteTasks {
  const { search, scopeProjectId, enabled } = options;

  const projects = useProjectStore((s) => s.projects);
  const deferredSearch = useDeferredValue(search);
  const query = deferredSearch.trim();
  const active = enabled && query !== "";

  const projectKey = useMemo(() => {
    const project = scopeProjectId
      ? projects.find((p) => p.id === scopeProjectId)
      : undefined;
    return project ? entryLookup(projects)(project).entryKey : null;
  }, [projects, scopeProjectId]);

  const { providers } = useTrackerStatus();
  const { rows } = useTasks({ provider: null, projectKey, enabled: active });

  return useMemo(() => {
    if (!active) {
      return { rows: NONE, seeAllProvider: null, total: 0, projectKey };
    }
    const input = { rows, projects, entryOf: entryLookup(projects) };
    // Unfiltered, like the Tasks view after "See all" clears its filters.
    const byProvider = new Map(
      providers.map((provider) => [
        provider,
        taskList(input, {
          provider,
          projectKey,
          filters: {},
          sort: DEFAULT_TASK_SORT,
          search: query,
        }).matching,
      ]),
    );
    const matching = sortTasksBy(
      [...byProvider.values()].flat(),
      DEFAULT_TASK_SORT,
    );
    const seeAllProvider = matching[0]?.provider ?? null;
    return {
      rows: matching.slice(0, PALETTE_TASK_LIMIT),
      seeAllProvider,
      total: seeAllProvider ? (byProvider.get(seeAllProvider)?.length ?? 0) : 0,
      projectKey,
    };
  }, [active, rows, projects, providers, projectKey, query]);
}

/**
 * The ref to fetch and act on a palette task through: a tracker row's own, or
 * a linked task's from its workspace link. Null when the link is gone.
 */
export function paletteTaskRef(
  task: PaletteTask,
  projects: readonly ProjectInfo[],
): TaskRef | null {
  const tracker = trackerFor(task.provider);
  if (!("workspacePath" in task)) return tracker.refOf(task);
  const project = projects.find((p) => p.id === task.projectId);
  const ws = project?.workspaces.find((w) => w.path === task.workspacePath);
  const link = ws?.linkedIssues?.find(
    (l) => task.key === `linked:${ws.path}:${l.id}`,
  );
  return project && link ? tracker.refFromLink(link, project) : null;
}
