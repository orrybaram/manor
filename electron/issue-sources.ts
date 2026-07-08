/**
 * Cross-source issue normalization — the shared shape MCP tools and the
 * control server route against, plus the GitHub↔Linear state-vocabulary
 * translation.
 *
 * Pure, Electron-free: no I/O, only `import type` from ./github and ./linear.
 * This module is consumed by issue-backends.ts (which owns the real
 * GitHubManager/LinearManager instances) and by the Electron-free MCP server,
 * which `import type`s McpIssue/McpIssueDetail from here rather than
 * re-declaring them — one shape on the wire, and the compiler sees any drift.
 * The type-only edge erases at runtime, so the MCP process stays Electron-free.
 */

import type { GitHubIssue, GitHubIssueDetail } from "./github";
import type { LinearIssue, LinearIssueDetail } from "./linear";

export type IssueSource = "github" | "linear";
export type IssueState = "open" | "closed" | "all";

export interface McpIssue {
  source: IssueSource;
  /**
   * The one lookup key: "#42" | "ENG-123". Displayed by `list_issues` and fed
   * straight back into `get_issue_detail`, so every backend's `detail()` must
   * accept the `ref` its own `list()` emitted.
   */
  ref: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
}

export interface McpIssueDetail extends McpIssue {
  body: string | null;
  assignees: string[];
}

export function isIssueSource(v: unknown): v is IssueSource {
  return v === "github" || v === "linear";
}

export function parseIssueState(v: string | null): IssueState {
  if (v === "open" || v === "closed" || v === "all") return v;
  return "open";
}

const LINEAR_OPEN_STATE_TYPES = ["triage", "backlog", "unstarted", "started"];
const LINEAR_CLOSED_STATE_TYPES = ["completed", "canceled"];

/** GitHub's open/closed/all → Linear workflow state types. */
export function linearStateTypes(state: IssueState): string[] {
  switch (state) {
    case "open":
      return LINEAR_OPEN_STATE_TYPES;
    case "closed":
      return LINEAR_CLOSED_STATE_TYPES;
    case "all":
      return [...LINEAR_OPEN_STATE_TYPES, ...LINEAR_CLOSED_STATE_TYPES];
  }
}

export function normalizeGitHubIssue(i: GitHubIssue): McpIssue {
  return {
    source: "github",
    ref: `#${i.number}`,
    title: i.title,
    url: i.url,
    state: i.state,
    labels: (i.labels ?? []).map((l) => l.name),
  };
}

export function normalizeLinearIssue(i: LinearIssue): McpIssue {
  return {
    source: "linear",
    ref: i.identifier,
    title: i.title,
    url: i.url,
    state: i.state.name,
    labels: (i.labels ?? []).map((l) => l.name),
  };
}

export function normalizeGitHubIssueDetail(i: GitHubIssueDetail): McpIssueDetail {
  return {
    ...normalizeGitHubIssue(i),
    body: i.body,
    assignees: (i.assignees ?? []).map((a) => a.login),
  };
}

export function normalizeLinearIssueDetail(i: LinearIssueDetail): McpIssueDetail {
  return {
    ...normalizeLinearIssue(i),
    body: i.description,
    assignees: i.assignee ? [i.assignee.displayName] : [],
  };
}
