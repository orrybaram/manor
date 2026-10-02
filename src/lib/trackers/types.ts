/**
 * ADR-202 §2: the tracker port. Each task tracker (GitHub, Linear) is one
 * adapter behind `TaskTracker`, so the task list never branches on the
 * provider. Query descriptors are plain objects — hooks run them; no React
 * here.
 */

import type { LinkedIssue, ProjectInfo } from "../../store/project-store";
import type { NewWorkspaceHandler } from "../start-issue-work";
import type {
  TaskContext,
  TaskDetail,
  TaskProvider,
  TaskRef,
  TaskRow,
} from "../tasks";

/** A query for a hook to run: key, fetcher and freshness. `queryFn` throws on failure. */
export interface TrackerQuery<T> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  staleTime: number;
}

/** Which issues a list query asks for: every open one, or the open ones assigned to you. */
export type TrackerScope = "open" | "assigned";

export interface TaskTracker {
  provider: TaskProvider;
  /** "GitHub" / "Linear". */
  label: string;
  /** Is it usable at all (gh installed + authed / Linear connected). */
  statusQuery(): TrackerQuery<boolean>;
  /** Can `member` be queried through this tracker (Linear: has a team association). */
  canList(member: ProjectInfo): boolean;
  /** The open, or assigned-to-me, rows of one source, already mapped to TaskRow. */
  listQuery(ctx: TaskContext, scope: TrackerScope): TrackerQuery<TaskRow[]>;
  /** The ref of a listed row. */
  refOf(row: TaskRow): TaskRef;
  /** The ref of a workspace link this tracker owns, acted on through `project`. */
  refFromLink(link: LinkedIssue, project: ProjectInfo): TaskRef;
  /**
   * The task's normalised detail, under `["task-detail", provider, …]` — a
   * key nothing else caches a different shape under (ADR-207 §1).
   */
  detailQuery(ref: TaskRef): TrackerQuery<TaskDetail>;
  /** Open the New Workspace dialog prefilled, or reuse a workspace on the branch. */
  startWork(
    row: TaskRow,
    body: string | null,
    onNewWorkspace?: NewWorkspaceHandler,
  ): void;
  /** Does this tracker own a workspace link (`gh-N` ids are GitHub's). */
  ownsLink(link: LinkedIssue): boolean;
  /** Is `row` the task `link` points at. GitHub: URL. Linear: URL or issue id. */
  matchesLink(link: LinkedIssue, row: TaskRow): boolean;
  /** Tracker page for one project's rows (repo issues / Linear team). */
  homeUrl(rows: readonly TaskRow[]): string | null;
  /** Unlink the task from a workspace, then reload projects. Throws on failure. */
  unlink?(
    ref: TaskRef,
    projectId: string,
    workspacePath: string,
  ): Promise<void>;
  /** Close the task in the tracker. Throws on failure. */
  close?(ref: TaskRef): Promise<void>;
}

