/**
 * ADR-202 §2: the GitHub tracker adapter. Lists a checkout's open issues
 * through `gh`, maps them to `TaskRow`s and starts work on one. With
 * `linear.ts`, the only reader of `row.raw` for the task list.
 */

import type { GitHubIssue } from "../../electron.d";
import { ghRepoOf } from "../gh-repo";
import { startGitHubIssueWork } from "../start-issue-work";
import type { TaskContext, TaskRow } from "../tasks";
import { cssHex, sameUrl } from "./shared";
import type { TaskTracker } from "./types";

const STALE_MS = 60_000;
const LIMIT = 50;

function githubStatus(
  state: string,
  stateReason?: string | null,
): TaskRow["status"] {
  if (state.toLowerCase() !== "closed") return { label: "Open", tone: "open" };
  return stateReason?.toUpperCase() === "NOT_PLANNED"
    ? { label: "Closed (not planned)", tone: "canceled" }
    : { label: "Closed", tone: "closed" };
}

/** A `gh` list result as a task row, listed through `ctx`. */
export function toRow(issue: GitHubIssue, ctx: TaskContext): TaskRow {
  return {
    key: `github:${ctx.entryKey}:${issue.number}`,
    provider: "github",
    displayId: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
    labels: (issue.labels ?? []).map((l) => ({
      name: l.name,
      color: cssHex(l.color),
    })),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    author: issue.author?.login || undefined,
    status: githubStatus(issue.state ?? "open", issue.stateReason),
    trackerProjects: (issue.projectItems ?? []).map((p) => p.title),
    milestone: issue.milestone?.title || undefined,
    createdAt: issue.createdAt ?? "",
    commentCount: issue.commentCount,
    updatedAt: issue.updatedAt ?? "",
    projectEntryKey: ctx.entryKey,
    project: ctx.project,
    projectName: ctx.projectName,
    color: ctx.color,
    raw: { provider: "github", issue },
  };
}

/** The listed issue behind a GitHub row; throws for another tracker's row. */
function issueOf(row: TaskRow): GitHubIssue {
  if (row.raw.provider !== "github") {
    throw new Error(`Not a GitHub task: ${row.key}`);
  }
  return row.raw.issue;
}

export const githubTracker: TaskTracker = {
  provider: "github",
  label: "GitHub",

  statusQuery: () => ({
    queryKey: ["trackers", "github", "status"],
    queryFn: async () => {
      const status = await window.electronAPI.github.checkStatus();
      return status.installed && status.authenticated;
    },
    staleTime: Infinity,
  }),

  // Any checkout can be asked; the status query is the ready check.
  canList: () => true,

  listQuery: (ctx, scope) => {
    const member = ctx.project;
    return {
      queryKey: [
        "trackers",
        "github",
        "list",
        scope,
        member.hostId,
        member.path,
        ctx.entryKey,
      ],
      queryFn: async () => {
        const repo = ghRepoOf(member);
        const issues =
          scope === "assigned"
            ? await window.electronAPI.github.getMyIssues(repo, LIMIT, "open")
            : await window.electronAPI.github.getAllIssues(repo, LIMIT, "open");
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
    const repo = ghRepoOf(row.project);
    return {
      // Same key as the palette's detail view, so they share the cache.
      queryKey: [
        "github-issue-detail",
        repo.hostId,
        repo.path,
        issue.number,
        issue.url,
      ],
      queryFn: async () => {
        const detail = await window.electronAPI.github.getIssueDetail(
          repo,
          issue.number,
          issue.url,
        );
        return detail.body ?? null;
      },
      staleTime: STALE_MS,
    };
  },

  startWork: (row, body, onNewWorkspace) => {
    startGitHubIssueWork({
      project: row.project,
      repo: ghRepoOf(row.project),
      issue: { ...issueOf(row), body },
      onNewWorkspace,
    });
  },

  ownsLink: (link) => link.id.startsWith("gh-"),

  // By URL only: `gh-N` ids aren't unique across repos.
  matchesLink: (link, row) =>
    row.provider === "github" && sameUrl(link.url, row.url),

  homeUrl: (rows) => {
    for (const row of rows) {
      if (row.provider !== "github") continue;
      const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/issues\/\d+/.exec(row.url);
      if (m) return `${m[1]}/issues`;
    }
    return null;
  },
};
