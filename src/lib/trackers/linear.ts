/**
 * ADR-202 §2: the Linear tracker adapter. Lists the open issues of a
 * project's associated teams, maps them to `TaskRow`s and starts work on
 * one. With `github.ts`, the only reader of `row.raw` for the task list.
 */

import type { LinearIssue } from "../../electron.d";
import { startLinearIssueWork } from "../start-issue-work";
import type { TaskContext, TaskRow, TaskStatusTone } from "../tasks";
import { cssHex, imagesOf, sameUrl, unlinkTask } from "./shared";
import type { TaskTracker } from "./types";

const STALE_MS = 60_000;
const LIMIT = 50;
/** Linear state types that count as "open" work. */
const OPEN_LINEAR_STATES = ["unstarted", "started", "backlog"];

const LINEAR_TONE: Record<string, TaskStatusTone> = {
  started: "started",
  unstarted: "todo",
  triage: "todo",
  backlog: "backlog",
  completed: "closed",
  canceled: "canceled",
};

function linearStatus(
  state: LinearIssue["state"] | undefined,
): TaskRow["status"] {
  return {
    label: state?.name ?? "Unknown",
    tone: LINEAR_TONE[state?.type ?? ""] ?? "todo",
  };
}

function linearPriority(issue: LinearIssue): TaskRow["priority"] {
  if (typeof issue.priority !== "number") return undefined;
  return {
    value: issue.priority,
    label:
      issue.priorityLabel ||
      (issue.priority === 0 ? "No priority" : `P${issue.priority}`),
  };
}

function linearLabels(issue: LinearIssue): TaskRow["labels"] {
  return (issue.labels ?? []).map((l) => ({
    name: l.name,
    color: cssHex(l.color),
  }));
}

function linearAssignees(issue: LinearIssue): string[] {
  const assignee = issue.assignee?.displayName || issue.assignee?.name;
  return assignee ? [assignee] : [];
}

/** A Linear list result as a task row, listed through `ctx`. */
export function toRow(issue: LinearIssue, ctx: TaskContext): TaskRow {
  const cycle = issue.cycle
    ? issue.cycle.name || `Cycle ${issue.cycle.number}`
    : undefined;
  return {
    key: `linear:${ctx.entryKey}:${issue.id}`,
    provider: "linear",
    displayId: issue.identifier,
    title: issue.title,
    url: issue.url,
    labels: linearLabels(issue),
    assignees: linearAssignees(issue),
    author: issue.creator?.displayName || issue.creator?.name || undefined,
    status: linearStatus(issue.state),
    priority: linearPriority(issue),
    trackerProjects: issue.project?.name ? [issue.project.name] : [],
    cycle,
    team: issue.team?.key || undefined,
    estimate: issue.estimate ?? undefined,
    dueDate: issue.dueDate || undefined,
    createdAt: issue.createdAt ?? "",
    updatedAt: issue.updatedAt ?? "",
    projectEntryKey: ctx.entryKey,
    project: ctx.project,
    projectName: ctx.projectName,
    color: ctx.color,
    raw: { provider: "linear", issue },
  };
}

/** The listed issue behind a Linear row; throws for another tracker's row. */
function issueOf(row: TaskRow): LinearIssue {
  if (row.raw.provider !== "linear") {
    throw new Error(`Not a Linear task: ${row.key}`);
  }
  return row.raw.issue;
}

export const linearTracker: TaskTracker = {
  provider: "linear",
  label: "Linear",

  statusQuery: () => ({
    queryKey: ["trackers", "linear", "status"],
    queryFn: () => window.electronAPI.linear.isConnected(),
    staleTime: STALE_MS,
  }),

  canList: (member) => member.linearAssociations.length > 0,

  listQuery: (ctx, scope) => {
    const member = ctx.project;
    const teamIds = member.linearAssociations.map((a) => a.teamId);
    return {
      queryKey: [
        "trackers",
        "linear",
        "list",
        scope,
        member.id,
        teamIds.join(","),
        ctx.entryKey,
      ],
      queryFn: async () => {
        const opts = { stateTypes: OPEN_LINEAR_STATES, limit: LIMIT };
        const issues =
          scope === "assigned"
            ? await window.electronAPI.linear.getMyIssues(teamIds, opts)
            : await window.electronAPI.linear.getAllIssues(teamIds, opts);
        return issues.map((i) => ({
          ...toRow(i, ctx),
          assignedToMe: scope === "assigned",
        }));
      },
      staleTime: STALE_MS,
    };
  },

  refOf: (row) => ({
    provider: "linear",
    project: row.project,
    id: issueOf(row).id,
    displayId: row.displayId,
    title: row.title,
    url: row.url,
  }),

  refFromLink: (link, project) => ({
    provider: "linear",
    project,
    id: link.id,
    displayId: link.identifier,
    title: link.title,
    url: link.url,
  }),

  detailQuery: (ref) => ({
    queryKey: ["task-detail", "linear", ref.id],
    queryFn: async () => {
      const issue = await window.electronAPI.linear.getIssueDetail(ref.id);
      const body = issue.description ?? null;
      return {
        body,
        status: linearStatus(issue.state),
        assignees: linearAssignees(issue),
        labels: linearLabels(issue),
        priority: linearPriority(issue),
        images: imagesOf(body),
      };
    },
    staleTime: STALE_MS,
  }),

  startWork: (row, body, onNewWorkspace) => {
    startLinearIssueWork({
      project: row.project,
      issue: { ...issueOf(row), description: body },
      onNewWorkspace,
    });
  },

  // Anything that isn't a GitHub `gh-N` link is a Linear issue id.
  ownsLink: (link) => !link.id.startsWith("gh-"),

  matchesLink: (link, row) =>
    row.raw.provider === "linear" &&
    (sameUrl(link.url, row.url) || link.id === row.raw.issue.id),

  unlink: unlinkTask,

  close: (ref) => window.electronAPI.linear.closeIssue(ref.id),

  homeUrl: (rows) => {
    for (const row of rows) {
      if (row.provider !== "linear") continue;
      const m =
        /^(https:\/\/linear\.app\/[^/]+)\/issue\/([A-Za-z0-9]+)-\d+/.exec(
          row.url,
        );
      if (m) return `${m[1]}/team/${m[2]}/all`;
    }
    return null;
  },
};
