/**
 * ADR-198 §3: pure selectors for the Tasks view. GitHub and Linear list
 * results are normalised into one `TaskRow` shape, then searched, sorted and
 * paginated client-side. No store or React imports, so everything here is
 * unit-tested directly (`tasks.test.ts`).
 */

import type { GitHubIssue, LinearIssue } from "../electron.d";
import type { ProjectInfo } from "../store/project-store";

export type TaskProvider = "github" | "linear";

/** Which issues a Tasks query asks for. */
export type TaskFilter = "open" | "assigned";

/**
 * How a status pill is tinted: `open` / `started` green, `todo` neutral,
 * `backlog` / `canceled` dim, `closed` purple.
 */
export type TaskStatusTone = "open" | "started" | "todo" | "backlog" | "closed" | "canceled";

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
  /** The GitHub author login; Linear list results carry none. */
  author?: string;
  status: { label: string; tone: TaskStatusTone };
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

/** A hex colour from `gh` (no `#`) or Linear (with `#`) as CSS; undefined if unusable. */
function cssHex(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const hex = color.startsWith("#") ? color.slice(1) : color;
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex) ? `#${hex}` : undefined;
}

function githubStatus(state: string): TaskRow["status"] {
  return state.toLowerCase() === "closed"
    ? { label: "Closed", tone: "closed" }
    : { label: "Open", tone: "open" };
}

const LINEAR_TONE: Record<string, TaskStatusTone> = {
  started: "started",
  unstarted: "todo",
  triage: "todo",
  backlog: "backlog",
  completed: "closed",
  canceled: "canceled",
};

export function fromGitHub(issue: GitHubIssue, ctx: TaskContext): TaskRow {
  return {
    key: `github:${ctx.entryKey}:${issue.number}`,
    provider: "github",
    displayId: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
    labels: (issue.labels ?? []).map((l) => ({ name: l.name, color: cssHex(l.color) })),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    author: issue.author?.login || undefined,
    status: githubStatus(issue.state ?? "open"),
    updatedAt: issue.updatedAt ?? "",
    projectEntryKey: ctx.entryKey,
    project: ctx.project,
    projectName: ctx.projectName,
    color: ctx.color,
    raw: { provider: "github", issue },
  };
}

export function fromLinear(issue: LinearIssue, ctx: TaskContext): TaskRow {
  const assignee = issue.assignee?.displayName || issue.assignee?.name;
  return {
    key: `linear:${ctx.entryKey}:${issue.id}`,
    provider: "linear",
    displayId: issue.identifier,
    title: issue.title,
    url: issue.url,
    labels: (issue.labels ?? []).map((l) => ({ name: l.name, color: cssHex(l.color) })),
    assignees: assignee ? [assignee] : [],
    status: {
      label: issue.state?.name ?? "Unknown",
      tone: LINEAR_TONE[issue.state?.type ?? ""] ?? "todo",
    },
    updatedAt: issue.updatedAt ?? "",
    projectEntryKey: ctx.entryKey,
    project: ctx.project,
    projectName: ctx.projectName,
    color: ctx.color,
    raw: { provider: "linear", issue },
  };
}

function updatedMs(row: TaskRow): number {
  const ms = Date.parse(row.updatedAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Most recently updated first; rows without a timestamp last; stable otherwise. */
export function sortTasks(rows: readonly TaskRow[]): TaskRow[] {
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

/** Rows whose title, ID or a label contains `query` (case-insensitive); all rows for a blank query. */
export function filterTasks(rows: readonly TaskRow[], query: string): TaskRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(q) ||
      row.displayId.toLowerCase().includes(q) ||
      row.labels.some((l) => l.name.toLowerCase().includes(q)),
  );
}

export const TASKS_PAGE_SIZE = 25;

export interface TaskPage {
  rows: TaskRow[];
  /** 1-based, clamped into `[1, pageCount]`. */
  page: number;
  /** At least 1, so an empty list still has a page. */
  pageCount: number;
}

/** The 1-based `page` of `rows`, clamping an out-of-range page to the nearest real one. */
export function paginate(rows: readonly TaskRow[], page: number, size = TASKS_PAGE_SIZE): TaskPage {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const clamped = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const start = (clamped - 1) * size;
  return { rows: rows.slice(start, start + size), page: clamped, pageCount };
}

/**
 * The page buttons to show: every page when there are few, otherwise the
 * first, the last and the current one's neighbours, with `"gap"` between runs.
 */
export function pageWindow(page: number, pageCount: number): (number | "gap")[] {
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

/**
 * The tracker page for a single project's rows of `provider`, derived from a
 * listed task's URL: a GitHub repo's issues page, or a Linear team's page.
 * Null when no row can tell.
 */
export function trackerHomeUrl(rows: readonly TaskRow[], provider: TaskProvider): string | null {
  for (const row of rows) {
    if (row.provider !== provider) continue;
    if (provider === "github") {
      const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/issues\/\d+/.exec(row.url);
      if (m) return `${m[1]}/issues`;
    } else {
      const m = /^(https:\/\/linear\.app\/[^/]+)\/issue\/([A-Za-z0-9]+)-\d+/.exec(row.url);
      if (m) return `${m[1]}/team/${m[2]}/all`;
    }
  }
  return null;
}
