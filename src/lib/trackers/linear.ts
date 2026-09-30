/**
 * ADR-202 §2: the Linear tracker adapter. Lists the open issues of a
 * project's associated teams, maps them to `TaskRow`s and starts work on
 * one. With `github.ts`, the only reader of `row.raw` for the task list.
 */

import type { LinearIssue } from "../../electron.d";
import { startLinearIssueWork } from "../start-issue-work";
import type { TaskContext, TaskRow, TaskStatusTone } from "../tasks";
import { cssHex, sameUrl } from "./shared";
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

/** A Linear list result as a task row, listed through `ctx`. */
export function toRow(issue: LinearIssue, ctx: TaskContext): TaskRow {
  const assignee = issue.assignee?.displayName || issue.assignee?.name;
  const cycle = issue.cycle
    ? issue.cycle.name || `Cycle ${issue.cycle.number}`
    : undefined;
  return {
    key: `linear:${ctx.entryKey}:${issue.id}`,
    provider: "linear",
    displayId: issue.identifier,
    title: issue.title,
    url: issue.url,
    labels: (issue.labels ?? []).map((l) => ({
      name: l.name,
      color: cssHex(l.color),
    })),
    assignees: assignee ? [assignee] : [],
    author: issue.creator?.displayName || issue.creator?.name || undefined,
    status: {
      label: issue.state?.name ?? "Unknown",
      tone: LINEAR_TONE[issue.state?.type ?? ""] ?? "todo",
    },
    priority:
      typeof issue.priority === "number"
        ? {
            value: issue.priority,
            label:
              issue.priorityLabel ||
              (issue.priority === 0 ? "No priority" : `P${issue.priority}`),
          }
        : undefined,
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

  detailQuery: (row) => {
    const issue = issueOf(row);
    return {
      // Same key as the palette's detail view, so they share the cache.
      queryKey: ["linear-issue-detail", issue.id],
      queryFn: async () => {
        const detail = await window.electronAPI.linear.getIssueDetail(issue.id);
        return detail.description ?? null;
      },
      staleTime: STALE_MS,
    };
  },

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
