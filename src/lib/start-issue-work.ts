/**
 * "Start work on this issue" — shared by the command palette's issue detail
 * views and Home's Up next section (ADR-194 §1).
 *
 * Reuses a workspace already on the issue's branch (select it and link the
 * issue), otherwise opens the New Workspace dialog prefilled with the branch,
 * the agent prompt and the linked issue, then marks the issue as taken
 * (assign on GitHub, start on Linear). The existing-branch path deliberately
 * doesn't assign/start — that's how the palette has always behaved.
 */

import { useProjectStore, type LinkedIssue, type ProjectInfo } from "../store/project-store";
import { addErrorToast } from "../store/toast-store";
import { sanitizeBranchName, branchesEqual } from "../utils/branch-name";
import type { CommandPaletteProps } from "../components/command-palette/types";
import type { GhRepo } from "./gh-repo";

export type NewWorkspaceHandler = CommandPaletteProps["onNewWorkspace"];

/**
 * Assign the issue without blocking the caller — workspace creation and agent
 * launch have already been kicked off and must not wait on `gh`.
 *
 * Deliberately not `.catch(() => {})`: the user asked to be assigned, so a
 * failure is reported even though it is not awaited. Silently dropping it is the
 * bug ADR-152 exists to remove, not a lighter version of it.
 */
export function assignIssueBestEffort(repo: GhRepo, issueNumber: number): void {
  window.electronAPI.github.assignIssue(repo, issueNumber).catch((err) => {
    addErrorToast(
      `assign-issue-error-gh-${issueNumber}`,
      "Failed to assign issue",
      err,
    );
  });
}

/** The branch the palette names a GitHub issue's workspace: `12-fix-the-thing`. */
function githubIssueBranchName(issueNumber: number, title: string): string {
  return `${issueNumber}-${sanitizeBranchName(title)}`;
}

/**
 * Select the workspace of `projectId` already on `branch` and link `linked`
 * to it. Returns false when no workspace is on that branch.
 */
function reuseExistingWorkspace(
  projectId: string,
  branch: string,
  linked: LinkedIssue,
): boolean {
  const store = useProjectStore.getState();
  const current = store.projects.find((p) => p.id === projectId);
  const existingIdx =
    current?.workspaces.findIndex((ws) => branchesEqual(ws.branch, branch)) ?? -1;
  if (existingIdx < 0) return false;
  store.selectWorkspace(projectId, existingIdx);
  const existingWs = current?.workspaces[existingIdx];
  if (existingWs) {
    useProjectStore.getState().linkIssueToWorkspace(projectId, existingWs.path, linked);
  }
  return true;
}

type StartWorkCommon = {
  /** The project (checkout) to create the workspace in. */
  project: Pick<ProjectInfo, "id">;
  onNewWorkspace: NewWorkspaceHandler;
  /** Called once the work is handed off — the palette closes itself here. */
  onClose?: () => void;
};

export function startGitHubIssueWork(
  opts: StartWorkCommon & {
    repo: GhRepo;
    issue: { number: number; title: string; url: string; body?: string | null };
  },
): void {
  const { project, repo, issue, onNewWorkspace, onClose } = opts;
  const branch = githubIssueBranchName(issue.number, issue.title);
  const linkedIssue: LinkedIssue = {
    id: `gh-${issue.number}`,
    identifier: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
  };

  if (reuseExistingWorkspace(project.id, branch, linkedIssue)) {
    onClose?.();
    return;
  }

  onClose?.();
  onNewWorkspace?.({
    projectId: project.id,
    name: issue.title,
    branch,
    agentPrompt: issue.title + "\n\n" + (issue.body ?? ""),
    linkedIssue,
  });
  assignIssueBestEffort(repo, issue.number);
}

export function startLinearIssueWork(
  opts: StartWorkCommon & {
    issue: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      branchName: string;
      description?: string | null;
    };
  },
): void {
  const { project, issue, onNewWorkspace, onClose } = opts;
  const linkedIssue: LinkedIssue = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };

  if (reuseExistingWorkspace(project.id, issue.branchName, linkedIssue)) {
    onClose?.();
    return;
  }

  onClose?.();
  onNewWorkspace?.({
    projectId: project.id,
    name: issue.title,
    branch: issue.branchName,
    agentPrompt: issue.title + "\n\n" + (issue.description ?? ""),
    linkedIssue,
  });
  window.electronAPI.linear.startIssue(issue.id);
}
