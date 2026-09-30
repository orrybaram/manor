/**
 * ADR-198 §3: pure selectors for the Tasks view. GitHub and Linear list
 * results are normalised into one `TaskRow` shape, then searched, sorted and
 * paginated client-side. No store or React imports, so everything here is
 * unit-tested directly (`tasks.test.ts`).
 */

import type { GitHubIssue, LinearIssue } from "../electron.d";
import type { ProjectInfo } from "../store/project-store";

export type TaskProvider = "github" | "linear";

/**
 * How a status pill is tinted: `open` / `started` green, `todo` neutral,
 * `backlog` / `canceled` dim, `closed` purple.
 */
export type TaskStatusTone =
  | "open"
  | "started"
  | "todo"
  | "backlog"
  | "closed"
  | "canceled";

export interface TaskLabel {
  name: string;
  /** A CSS colour from the tracker (`#rrggbb`), when it has one. */
  color?: string;
}

export interface TaskRow {
  /** Unique across providers and projects. */
  key: string;
  provider: TaskProvider;
  /** `#123` / `ENG-45`. */
  displayId: string;
  title: string;
  url: string;
  labels: TaskLabel[];
  /** Display names (GitHub logins, Linear names), in tracker order. */
  assignees: string[];
  /** The GitHub author login, or the Linear creator's display name. */
  author?: string;
  status: { label: string; tone: TaskStatusTone };
  /** Linear only; `value` 0 is "No priority" and sorts last. */
  priority?: { value: number; label: string };
  /** Linear project, or GitHub Projects v2 titles. */
  trackerProjects: string[];
  /** GitHub milestone title. */
  milestone?: string;
  /** Linear cycle: its name, else "Cycle N". */
  cycle?: string;
  /** Linear team key. */
  team?: string;
  estimate?: number;
  /** ISO date (Linear). */
  dueDate?: string;
  /** ISO timestamp; `""` when the tracker didn't send one. */
  createdAt: string;
  /** GitHub comment count. */
  commentCount?: number;
  /** Listed by the tracker's "assigned to me" query (or linked to one of your workspaces). */
  assignedToMe?: boolean;
  /** Linked to a workspace — being worked on. */
  inProgress?: boolean;
  /** ISO timestamp; `""` when the tracker didn't send one. */
  updatedAt: string;
  /** The top-level sidebar entry (project id or group id) the row belongs to. */
  projectEntryKey: string;
  /** The member checkout the task was listed through — work starts here. */
  project: ProjectInfo;
  /** The entry's display name (the group name for a linked group). */
  projectName: string;
  color: string | null;
  raw:
    | { provider: "github"; issue: GitHubIssue }
    | { provider: "linear"; issue: LinearIssue };
}

/** Where a row was listed from: the sidebar entry and the member it went through. */
export interface TaskContext {
  entryKey: string;
  project: ProjectInfo;
  projectName: string;
  color: string | null;
}

/** The fields the list helpers (sort, search, paginate) read. */
type Listable = Pick<TaskRow, "updatedAt" | "title" | "displayId" | "labels">;

function updatedMs(row: Listable): number {
  const ms = Date.parse(row.updatedAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Most recently updated first; rows without a timestamp last; stable otherwise. */
export function sortTasks<T extends Listable>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index, ms: updatedMs(row) }))
    .sort((a, b) => (b.ms === a.ms ? a.index - b.index : b.ms > a.ms ? 1 : -1))
    .map((x) => x.row);
}

/**
 * Drop repeats of the same task (two entries linked to one Linear team, or
 * one repo checked out twice), keeping the first — then sort.
 */
export function collectTasks(rows: readonly TaskRow[]): TaskRow[] {
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
 * Rows not already linked to some workspace (in any project). A link is
 * matched by URL — GitHub link ids (`gh-N`) aren't unique across repos — or,
 * for Linear, by issue id.
 */
export function withoutLinkedTasks(
  rows: readonly TaskRow[],
  projects: readonly Pick<ProjectInfo, "workspaces">[],
): TaskRow[] {
  const urls = new Set<string>();
  const linearIds = new Set<string>();
  for (const project of projects) {
    for (const ws of project.workspaces) {
      for (const linked of ws.linkedIssues ?? []) {
        if (linked.url) urls.add(normalizeUrl(linked.url));
        linearIds.add(linked.id);
      }
    }
  }
  if (urls.size === 0 && linearIds.size === 0) return [...rows];
  return rows.filter(
    (row) =>
      !(row.url && urls.has(normalizeUrl(row.url))) &&
      !(row.raw.provider === "linear" && linearIds.has(row.raw.issue.id)),
  );
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

/**
 * A task linked to a workspace — the In progress list. Built from the
 * workspace's link (id, title, URL); tracker fields (labels, assignees,
 * status, updated) come from a fetched row for the same task when one is
 * loaded, and fall back to empty / "In progress".
 */
export interface LinkedTask extends Omit<TaskRow, "raw" | "project"> {
  projectId: string;
  workspacePath: string;
  /** The workspace's name, else its branch. */
  workspaceName: string;
}

/** Where a project's rows sit in the sidebar: its entry key, name and colour. */
export type EntryOf = (project: ProjectInfo) => {
  entryKey: string;
  projectName: string;
  color: string | null;
};

/**
 * Every task linked to a workspace, across projects, one row per link.
 * GitHub links have `gh-N` ids; anything else is a Linear issue id.
 */
export function linkedTasks(
  projects: readonly ProjectInfo[],
  entryOf: EntryOf,
  fetched: readonly TaskRow[],
): LinkedTask[] {
  const byUrl = new Map<string, TaskRow>();
  for (const row of fetched) if (row.url) byUrl.set(normalizeUrl(row.url), row);
  const out: LinkedTask[] = [];
  for (const project of projects) {
    const entry = entryOf(project);
    for (const ws of project.workspaces) {
      for (const linked of ws.linkedIssues ?? []) {
        const match = linked.url
          ? byUrl.get(normalizeUrl(linked.url))
          : undefined;
        const provider: TaskProvider = linked.id.startsWith("gh-")
          ? "github"
          : "linear";
        out.push({
          key: `linked:${ws.path}:${linked.id}`,
          provider,
          displayId: linked.identifier,
          title: match?.title ?? linked.title,
          url: linked.url,
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
        });
      }
    }
  }
  return sortTasks(out);
}

/** Rows whose title, ID or a label contains `query` (case-insensitive); all rows for a blank query. */
export function filterTasks<T extends Listable>(
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

/*
 * ADR-201 §4: the field model. Every column the trackers give us is described
 * once in `TASK_FIELDS` — which providers have it, how to read its filter
 * values (`facet`) and how to order rows by it (`sortKey` / `compare`) — and
 * the filter / sort helpers below are generic over that table.
 */

/** Every field the Tasks view can filter or sort by. `project` is the Manor sidebar entry; `trackerProject` the Linear project / GitHub Projects v2. */
export type TaskFieldId =
  | "status"
  | "priority"
  | "assignee"
  | "author"
  | "label"
  | "trackerProject"
  | "milestone"
  | "cycle"
  | "team"
  | "project"
  | "id"
  | "title"
  | "updated"
  | "created"
  | "dueDate"
  | "estimate"
  | "comments"
  | "progress";

/** The fields the field model reads — both `TaskRow` and `LinkedTask` carry them. */
type FieldRow = Omit<TaskRow, "raw" | "project">;

/** A value rows are ordered by; arrays compare element by element. `undefined` = missing. */
type SortKey = number | string | readonly (number | string)[] | undefined;

export interface TaskFieldDef {
  label: string;
  providers: readonly TaskProvider[];
  /** Filter values for a row; `[]` means "None" (`NONE_VALUE`). Filterable iff set. */
  facet?: (row: FieldRow) => string[];
  /** Order of this field's facet values; alphabetical when absent. */
  optionOrder?: (a: string, b: string) => number;
  /** What rows are ordered by; `undefined` is a missing value. Set iff `compare` is. */
  sortKey?: (row: FieldRow) => SortKey;
  /** Ascending order, missing values last. Sortable iff set. */
  compare?: (a: FieldRow, b: FieldRow) => number;
}

/** The facet value for a row with nothing in a field ("No priority", "No label"…). */
export const NONE_VALUE = "__none__";

/** The assignee facet value for tasks assigned to you, whatever your tracker name. */
export const ME_VALUE = "__me__";

const PROGRESS_NAMES: Record<string, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
};

const BOTH: readonly TaskProvider[] = ["github", "linear"];
const GITHUB: readonly TaskProvider[] = ["github"];
const LINEAR: readonly TaskProvider[] = ["linear"];

/**
 * Status sort order, by tone: to do (Linear triage / unstarted), backlog,
 * started, open (GitHub), closed (GitHub closed, Linear completed), canceled
 * (Linear canceled, GitHub closed as not planned). Ties order by the label.
 */
const STATUS_RANK: Record<TaskStatusTone, number> = {
  todo: 0,
  backlog: 1,
  started: 2,
  open: 3,
  closed: 4,
  canceled: 5,
};

/** Linear's fixed priority names; 0 is "No priority" and faceted as None. */
const PRIORITY_NAMES: Record<string, string> = {
  "1": "Urgent",
  "2": "High",
  "3": "Medium",
  "4": "Low",
};

function textOrder(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareKeys(a: SortKey & {}, b: SortKey & {}): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return textOrder(String(a), String(b));
}

/** `dir` (1 / -1) times the key order, but a missing key after a present one either way. */
function compareMissingLast(a: SortKey, b: SortKey, dir: number): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  return dir * compareKeys(a, b);
}

/** Parsed ms of an ISO date, or undefined when missing / unparseable. */
function dateKey(iso: string | undefined): number | undefined {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

function present(value: string | undefined): string[] {
  return value ? [value] : [];
}

/** A field sorted by `sortKey`, with the matching ascending, missing-last `compare`. */
function sortedBy(
  sortKey: (row: FieldRow) => SortKey,
): Pick<TaskFieldDef, "sortKey" | "compare"> {
  return {
    sortKey,
    compare: (a, b) => compareMissingLast(sortKey(a), sortKey(b), 1),
  };
}

/** Which fields apply to which provider, and how each filters and sorts (ADR-201 §4 table). In display order. */
export const TASK_FIELDS: Record<TaskFieldId, TaskFieldDef> = {
  progress: {
    label: "Progress",
    providers: BOTH,
    facet: (row) => [row.inProgress ? "in-progress" : "not-started"],
    optionOrder: (a, b) => (a === b ? 0 : a === "not-started" ? -1 : 1),
  },
  status: {
    label: "Status",
    providers: BOTH,
    facet: (row) => [row.status.label],
    ...sortedBy((row) => [STATUS_RANK[row.status.tone], row.status.label]),
  },
  priority: {
    label: "Priority",
    providers: LINEAR,
    facet: (row) =>
      row.priority && row.priority.value > 0
        ? [String(row.priority.value)]
        : [],
    optionOrder: (a, b) => Number(a) - Number(b),
    ...sortedBy((row) =>
      row.priority && row.priority.value > 0 ? row.priority.value : undefined,
    ),
  },
  assignee: {
    label: "Assignee",
    providers: BOTH,
    facet: (row) =>
      row.assignedToMe ? [ME_VALUE, ...row.assignees] : row.assignees,
    optionOrder: (a, b) =>
      a === ME_VALUE ? -1 : b === ME_VALUE ? 1 : textOrder(a, b),
    ...sortedBy((row) => row.assignees[0]),
  },
  author: {
    label: "Author",
    providers: BOTH,
    facet: (row) => present(row.author),
    ...sortedBy((row) => row.author),
  },
  label: {
    label: "Label",
    providers: BOTH,
    facet: (row) => row.labels.map((l) => l.name),
  },
  trackerProject: {
    label: "Project",
    providers: BOTH,
    facet: (row) => row.trackerProjects,
    ...sortedBy((row) => row.trackerProjects[0]),
  },
  milestone: {
    label: "Milestone",
    providers: GITHUB,
    facet: (row) => present(row.milestone),
    ...sortedBy((row) => row.milestone),
  },
  cycle: {
    label: "Cycle",
    providers: LINEAR,
    facet: (row) => present(row.cycle),
    ...sortedBy((row) => row.cycle),
  },
  team: {
    label: "Team",
    providers: LINEAR,
    facet: (row) => present(row.team),
    ...sortedBy((row) => row.team),
  },
  project: {
    label: "Manor project",
    providers: BOTH,
    facet: (row) => present(row.projectName),
    ...sortedBy((row) => row.projectName || undefined),
  },
  id: {
    label: "ID",
    providers: BOTH,
    ...sortedBy((row) => row.displayId || undefined),
  },
  title: {
    label: "Title",
    providers: BOTH,
    ...sortedBy((row) => row.title || undefined),
  },
  updated: {
    label: "Updated",
    providers: BOTH,
    ...sortedBy((row) => dateKey(row.updatedAt)),
  },
  created: {
    label: "Created",
    providers: BOTH,
    ...sortedBy((row) => dateKey(row.createdAt)),
  },
  dueDate: {
    label: "Due date",
    providers: LINEAR,
    ...sortedBy((row) => dateKey(row.dueDate)),
  },
  estimate: {
    label: "Estimate",
    providers: LINEAR,
    ...sortedBy((row) => row.estimate),
  },
  comments: {
    label: "Comments",
    providers: GITHUB,
    ...sortedBy((row) => row.commentCount),
  },
};

const FIELD_IDS = Object.keys(TASK_FIELDS) as TaskFieldId[];

/** The fields that apply to `provider`, in `TASK_FIELDS` order. */
export function fieldsFor(provider: TaskProvider): TaskFieldId[] {
  return FIELD_IDS.filter((id) => TASK_FIELDS[id].providers.includes(provider));
}

/** The fields of `provider` that can be filtered on. */
export function filterableFields(provider: TaskProvider): TaskFieldId[] {
  return fieldsFor(provider).filter((id) => TASK_FIELDS[id].facet);
}

/** The fields of `provider` that can be sorted by. */
export function sortableFields(provider: TaskProvider): TaskFieldId[] {
  return fieldsFor(provider).filter((id) => TASK_FIELDS[id].compare);
}

/** How a facet value reads: "No priority" for `NONE_VALUE`, "Urgent" for priority 1, else the value. */
export function facetLabel(fieldId: TaskFieldId, value: string): string {
  if (value === NONE_VALUE) {
    return `No ${TASK_FIELDS[fieldId].label.toLowerCase()}`;
  }
  if (fieldId === "priority") return PRIORITY_NAMES[value] ?? `P${value}`;
  if (fieldId === "assignee" && value === ME_VALUE) return "Me";
  if (fieldId === "progress") return PROGRESS_NAMES[value] ?? value;
  return value;
}

/**
 * The values `fieldId` takes across `rows`, each with how many rows carry it,
 * plus `NONE_VALUE` when some row has none. Ordered by the field's
 * `optionOrder`, else alphabetically; `NONE_VALUE` last. `[]` for a field
 * that can't be filtered.
 */
export function facetOptions(
  rows: readonly FieldRow[],
  fieldId: TaskFieldId,
): { value: string; count: number }[] {
  const { facet, optionOrder = textOrder } = TASK_FIELDS[fieldId];
  if (!facet) return [];
  const counts = new Map<string, number>();
  let none = 0;
  for (const row of rows) {
    const values = new Set(facet(row));
    if (values.size === 0) none++;
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const options = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => optionOrder(a.value, b.value));
  if (none > 0) options.push({ value: NONE_VALUE, count: none });
  return options;
}

/** Chosen facet values per field; an absent or empty list doesn't filter. */
export type TaskFilters = Partial<Record<TaskFieldId, string[]>>;

/** What the Tasks view opens on: your tasks nobody has started. */
export const DEFAULT_TASK_FILTERS: TaskFilters = {
  assignee: [ME_VALUE],
  progress: ["not-started"],
};

/**
 * Rows matching every filtered field (AND), where a field matches when the
 * row has any of its chosen values (OR) — `NONE_VALUE` matching a row with
 * none. Fields that can't be filtered are ignored.
 */
export function applyTaskFilters<T extends FieldRow>(
  rows: readonly T[],
  filters: TaskFilters,
): T[] {
  const active = FIELD_IDS.flatMap((id) => {
    const facet = TASK_FIELDS[id].facet;
    const chosen = filters[id];
    return facet && chosen?.length ? [{ facet, chosen: new Set(chosen) }] : [];
  });
  if (active.length === 0) return [...rows];
  return rows.filter((row) =>
    active.every(({ facet, chosen }) => {
      const values = facet(row);
      return values.length === 0
        ? chosen.has(NONE_VALUE)
        : values.some((v) => chosen.has(v));
    }),
  );
}

export interface TaskSort {
  field: TaskFieldId;
  direction: "asc" | "desc";
}

/** Most recently updated first — the Tasks view's order before ADR-201. */
export const DEFAULT_TASK_SORT: TaskSort = {
  field: "updated",
  direction: "desc",
};

/**
 * `rows` ordered by `sort.field`. Rows missing the value go last in either
 * direction; ties fall back to most recently updated, then input order
 * (stable). A field that can't be sorted leaves just the fallback order.
 */
export function sortTasksBy<T extends FieldRow>(
  rows: readonly T[],
  sort: TaskSort,
): T[] {
  const { sortKey } = TASK_FIELDS[sort.field];
  const updatedKey = TASK_FIELDS.updated.sortKey as (row: FieldRow) => SortKey;
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({
      row,
      index,
      key: sortKey?.(row),
      updated: updatedKey(row),
    }))
    .sort(
      (a, b) =>
        compareMissingLast(a.key, b.key, sign) ||
        compareMissingLast(a.updated, b.updated, -1) ||
        a.index - b.index,
    )
    .map((x) => x.row);
}

export const TASKS_PAGE_SIZE = 25;

export interface TaskPage<T = TaskRow> {
  rows: T[];
  /** 1-based, clamped into `[1, pageCount]`. */
  page: number;
  /** At least 1, so an empty list still has a page. */
  pageCount: number;
}

/** The 1-based `page` of `rows`, clamping an out-of-range page to the nearest real one. */
export function paginate<T>(
  rows: readonly T[],
  page: number,
  size = TASKS_PAGE_SIZE,
): TaskPage<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const clamped = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const start = (clamped - 1) * size;
  return { rows: rows.slice(start, start + size), page: clamped, pageCount };
}

/**
 * The page buttons to show: every page when there are few, otherwise the
 * first, the last and the current one's neighbours, with `"gap"` between runs.
 */
export function pageWindow(
  page: number,
  pageCount: number,
): (number | "gap")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const shown = new Set([1, pageCount, page - 1, page, page + 1]);
  const out: (number | "gap")[] = [];
  let prev = 0;
  for (let p = 1; p <= pageCount; p++) {
    if (!shown.has(p)) continue;
    if (p - prev > 1) out.push("gap");
    out.push(p);
    prev = p;
  }
  return out;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** "just now" / "5 minutes ago" / "2 hours ago" / "3 days ago" / "2 months ago" / "1 year ago"; `""` when unparseable. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, now - then);
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hour");
  const days = Math.floor(diff / DAY);
  if (days < 30) return plural(days, "day");
  if (days < 365) return plural(Math.floor(days / 30), "month");
  return plural(Math.floor(days / 365), "year");
}

/** "A" for "alice", "?" for an empty name — the avatar's letter. */
export function initialOf(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}
