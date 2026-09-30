/**
 * ADR-202 §3: the Task list module. One pure pipeline from fetched tracker
 * rows to the list both views show — merge the per-source results, drop rows
 * a workspace link claims, add the linked rows, scope to provider / project,
 * filter, search, sort and page. The Tasks view pages it; Up next takes its
 * top. No React or store imports (types only), so it's tested directly
 * against the in-memory tracker (`task-list.test.ts`).
 */

import type { LinkedIssue, ProjectInfo } from "../store/project-store";
import { buildTopLevelEntries } from "../utils/sidebar-items";
import {
  TASKS_PAGE_SIZE,
  applyTaskFilters,
  paginate,
  sortTasksBy,
  type EntryOf,
  type LinkedTask,
  type TaskFilters,
  type TaskPage,
  type TaskProvider,
  type TaskRow,
  type TaskSort,
} from "./tasks";
import { TRACKERS, type TaskTracker } from "./trackers";

/** One list query's outcome: its rows, or a failure that contributed none. */
export type SourceResult = { rows: TaskRow[]; failed: boolean };

/** A row of the list: a fetched task, or one linked to a workspace. */
type ListRow = TaskRow | LinkedTask;

/** The fields the list helpers (sort, search) read. */
type Listable = Pick<TaskRow, "updatedAt" | "title" | "displayId" | "labels">;

function updatedMs(row: Listable): number {
  const ms = Date.parse(row.updatedAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Most recently updated first; rows without a timestamp last; stable otherwise. */
function sortTasks<T extends Listable>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index, ms: updatedMs(row) }))
    .sort((a, b) => (b.ms === a.ms ? a.index - b.index : b.ms > a.ms ? 1 : -1))
    .map((x) => x.row);
}

/**
 * Drop repeats of the same task (two entries linked to one Linear team, or
 * one repo checked out twice), keeping the first — then sort.
 */
function collectTasks(rows: readonly TaskRow[]): TaskRow[] {
  const seen = new Set<string>();
  const unique: TaskRow[] = [];
  for (const row of rows) {
    const id = `${row.provider}:${row.url || row.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }
  return sortTasks(unique);
}

/**
 * Merge the per-source query results (ADR-198 §3): a task the "assigned"
 * query listed is marked `assignedToMe` wherever it appears, repeats are
 * dropped keeping the first, and rows come most recently updated first.
 * `failedCount` is how many sources failed.
 */
export function mergeSources(results: readonly SourceResult[]): {
  rows: TaskRow[];
  failedCount: number;
} {
  const rows = results.flatMap((r) => r.rows);
  const mine = new Set(
    rows.filter((row) => row.assignedToMe).map((row) => row.url || row.key),
  );
  return {
    rows: collectTasks(
      rows.map((row) =>
        !row.assignedToMe && mine.has(row.url || row.key)
          ? { ...row, assignedToMe: true }
          : row,
      ),
    ),
    failedCount: results.filter((r) => r.failed).length,
  };
}

/** Each project's sidebar entry: a linked group's key, name and colour, or its own. */
export function entryLookup(projects: readonly ProjectInfo[]): EntryOf {
  const byProject = new Map<string, ReturnType<EntryOf>>();
  for (const entry of buildTopLevelEntries(projects)) {
    if (entry.kind === "project") {
      byProject.set(entry.project.id, {
        entryKey: entry.key,
        projectName: entry.project.name,
        color: entry.project.color,
      });
    } else {
      for (const section of entry.sections) {
        byProject.set(section.project.id, {
          entryKey: entry.key,
          projectName: entry.group.name,
          color: section.project.color,
        });
      }
    }
  }
  return (project) =>
    byProject.get(project.id) ?? {
      entryKey: project.id,
      projectName: project.name,
      color: project.color,
    };
}

/** Every workspace link, across projects. */
function allLinks(projects: readonly ProjectInfo[]): LinkedIssue[] {
  return projects.flatMap((p) =>
    p.workspaces.flatMap((ws) => ws.linkedIssues ?? []),
  );
}

/**
 * A task linked to a workspace, one row per link. Built from the link (id,
 * title, URL); tracker fields come from a fetched row the owning tracker
 * matches, and fall back to empty / "In progress".
 */
function linkedTask(
  link: LinkedIssue,
  provider: TaskProvider,
  match: TaskRow | undefined,
  project: ProjectInfo,
  ws: ProjectInfo["workspaces"][number],
  entry: ReturnType<EntryOf>,
): LinkedTask {
  return {
    key: `linked:${ws.path}:${link.id}`,
    provider,
    displayId: link.identifier,
    title: match?.title ?? link.title,
    url: link.url,
    labels: match?.labels ?? [],
    assignees: match?.assignees ?? [],
    author: match?.author,
    status: match?.status ?? { label: "In progress", tone: "started" },
    // Linking it to your workspace makes it yours, even unlisted.
    assignedToMe: match?.assignedToMe ?? true,
    inProgress: true,
    priority: match?.priority,
    trackerProjects: match?.trackerProjects ?? [],
    milestone: match?.milestone,
    cycle: match?.cycle,
    team: match?.team,
    estimate: match?.estimate,
    dueDate: match?.dueDate,
    createdAt: match?.createdAt ?? "",
    commentCount: match?.commentCount,
    updatedAt: match?.updatedAt ?? "",
    projectEntryKey: entry.entryKey,
    projectName: entry.projectName,
    color: entry.color,
    projectId: project.id,
    workspacePath: ws.path,
    workspaceName: ws.name || ws.branch,
  };
}

/** Every workspace link whose tracker is `provider` and whose entry is in scope. */
function linkedTasks(
  projects: readonly ProjectInfo[],
  entryOf: EntryOf,
  fetched: readonly TaskRow[],
  inScope: (provider: TaskProvider, entryKey: string) => boolean,
  trackers: Record<TaskProvider, TaskTracker>,
): LinkedTask[] {
  const all = Object.values(trackers);
  const out: LinkedTask[] = [];
  for (const project of projects) {
    const entry = entryOf(project);
    for (const ws of project.workspaces) {
      for (const link of ws.linkedIssues ?? []) {
        const tracker = all.find((t) => t.ownsLink(link));
        if (!tracker || !inScope(tracker.provider, entry.entryKey)) continue;
        const match = fetched.find((row) => tracker.matchesLink(link, row));
        out.push(linkedTask(link, tracker.provider, match, project, ws, entry));
      }
    }
  }
  return sortTasks(out);
}

/** Rows whose title, ID or a label contains `query` (case-insensitive); all rows for a blank query. */
function filterTasks<T extends Listable>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(q) ||
      row.displayId.toLowerCase().includes(q) ||
      row.labels.some((l) => l.name.toLowerCase().includes(q)),
  );
}

/** What a list shows: which tracker and project, and the user's filters, sort and search. */
export interface TaskListPrefs {
  provider: TaskProvider;
  /** A top-level entry key; null = all projects. */
  projectKey: string | null;
  filters: TaskFilters;
  sort: TaskSort;
  search?: string;
}

/** The inputs a list is built from: merged rows, the projects (for links) and their entries. */
export interface TaskListInput {
  rows: readonly TaskRow[];
  projects: readonly ProjectInfo[];
  entryOf: EntryOf;
}

export interface TaskList {
  /** In scope, before filters — facet counts come from here. */
  listed: ListRow[];
  /** `listed` through the filters, before search — "N of M tasks". */
  filtered: ListRow[];
  /** Filtered, searched and sorted: the list itself. */
  matching: ListRow[];
  /** The 1-based page `n` of `matching`. */
  page(n: number, size?: number): TaskPage<ListRow>;
  /** The first `n` of `matching` — Up next. Always a prefix of `page(1)`. */
  top(n: number): ListRow[];
}

/**
 * The task list for `prefs` (ADR-202 §3): fetched rows of the chosen
 * provider / project that no workspace link (in any project) claims, then
 * the linked rows in the same scope, through filters, search and sort.
 */
export function taskList(
  input: TaskListInput,
  prefs: TaskListPrefs,
  trackers: Record<TaskProvider, TaskTracker> = TRACKERS,
): TaskList {
  const { rows, projects, entryOf } = input;
  const inScope = (provider: TaskProvider, entryKey: string) =>
    provider === prefs.provider &&
    (prefs.projectKey === null || entryKey === prefs.projectKey);

  const links = allLinks(projects);
  const unlinked = rows.filter(
    (row) =>
      inScope(row.provider, row.projectEntryKey) &&
      !links.some((link) => trackers[row.provider].matchesLink(link, row)),
  );
  const linked = linkedTasks(projects, entryOf, rows, inScope, trackers);

  const listed: ListRow[] = [...unlinked, ...linked];
  const filtered = applyTaskFilters(listed, prefs.filters);
  const matching = sortTasksBy(
    filterTasks(filtered, prefs.search ?? ""),
    prefs.sort,
  );
  return {
    listed,
    filtered,
    matching,
    page: (n, size = TASKS_PAGE_SIZE) => paginate(matching, n, size),
    top: (n) => matching.slice(0, n),
  };
}
