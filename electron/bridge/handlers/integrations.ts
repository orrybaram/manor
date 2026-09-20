/**
 * GitHub and Linear, as plain functions over `IpcDeps` (ADR-180 D8).
 *
 * There is no `register()` here any more: `electron/bridge/handlers.ts` calls
 * these directly, for a renderer window and a paired `full` device alike.
 * Both integrations are the ADR-178 "read and act from anywhere" case at its
 * plainest — an issue list on a phone that cannot start the issue is the
 * read-and-type state this slice exists to end — so the whole of `github` and
 * all but one of `linear` are ordinary table entries.
 *
 * **Credentials never cross.** `LinearManager` keeps the API key in
 * `safeStorage`, and every method below that needs it hands back the *result*
 * of using it and never the key: `isConnected` a boolean, `proxyImage` a data
 * URL, the rest GraphQL payloads. `linearConnect` is the one that takes a raw
 * key as an argument rather than producing one, and it is `LOCAL_ONLY` for
 * that reason alone (see `handlers.ts`) — a table entry a device is refused,
 * not a hole in the table. GitHub needs no such care: it shells out to `gh`,
 * which holds its own credential, and `checkStatus` reports a username.
 */

import { assertString } from "../../ipc-validate";
import type { LinkedIssue } from "../../linear";
import type { IpcDeps } from "../../ipc/types";

type IssueState = "open" | "closed" | "all";
type LinearIssueOptions = { stateTypes?: string[]; limit?: number };

// ── GitHub ───────────────────────────────────────────────────────────────────

export function githubGetPrForBranch(
  deps: IpcDeps,
  repoPath: string,
  branch: string,
): unknown {
  return deps.githubManager.getPrForBranch(repoPath, branch);
}

export function githubGetPrsForBranches(
  deps: IpcDeps,
  repoPath: string,
  branches: string[],
): unknown {
  return deps.githubManager.getPrsForBranches(repoPath, branches);
}

export function githubCheckStatus(deps: IpcDeps): unknown {
  return deps.githubManager.checkStatus();
}

/**
 * The two issue lists, and the one place the wire needs a nudge.
 *
 * An omitted optional argument reaches the host as `undefined` over IPC and
 * as `null` over the socket — JSON has no third thing — and a default
 * parameter only fires for `undefined`. Without the coalesce a browser would
 * ask `gh` for `--limit null`, which is precisely the "a browser hits a hole
 * the desktop never had" shape ADR-178 kept finding. `GitHubManager` owns the
 * actual defaults; this only says "not given".
 */
export function githubGetMyIssues(
  deps: IpcDeps,
  repoPath: string,
  limit?: number | null,
  state?: IssueState | null,
): unknown {
  return deps.githubManager.getMyIssues(
    repoPath,
    limit ?? undefined,
    state ?? undefined,
  );
}

export function githubGetAllIssues(
  deps: IpcDeps,
  repoPath: string,
  limit?: number | null,
  state?: IssueState | null,
): unknown {
  return deps.githubManager.getAllIssues(
    repoPath,
    limit ?? undefined,
    state ?? undefined,
  );
}

export function githubGetIssueDetail(
  deps: IpcDeps,
  repoPath: string,
  issueNumber: number,
): unknown {
  return deps.githubManager.getIssueDetail(repoPath, issueNumber);
}

export function githubAssignIssue(
  deps: IpcDeps,
  repoPath: string,
  issueNumber: number,
): unknown {
  return deps.githubManager.assignIssue(repoPath, issueNumber);
}

export function githubCloseIssue(
  deps: IpcDeps,
  repoPath: string,
  issueNumber: number,
): unknown {
  return deps.githubManager.closeIssue(repoPath, issueNumber);
}

export function githubCreateIssue(
  deps: IpcDeps,
  title: string,
  body: string,
  labels: string[],
): unknown {
  return deps.githubManager.createIssue(title, body, labels);
}

export function githubUploadFeedbackImages(
  deps: IpcDeps,
  images: { base64: string; name: string }[],
): Promise<string[]> {
  return deps.githubManager.uploadFeedbackImages(images);
}

// ── Linear ───────────────────────────────────────────────────────────────────

/**
 * Store an API key and prove it works, or store nothing.
 *
 * The key is written before it is tested because testing it *is* using it —
 * `getViewer` reads the stored token — so the failure path has to undo the
 * write. That is the whole of the ceremony here, and it is why a half-typed
 * key never leaves a connected-looking Linear panel behind.
 */
export async function linearConnect(
  deps: IpcDeps,
  apiKey: string,
): Promise<{ name: string; email: string }> {
  assertString(apiKey, "apiKey");
  deps.linearManager.saveToken(apiKey);
  try {
    return await deps.linearManager.getViewer();
  } catch (err) {
    deps.linearManager.clearToken();
    throw err;
  }
}

/** Forget the key. Carries no credential in either direction. */
export function linearDisconnect(deps: IpcDeps): void {
  deps.linearManager.clearToken();
}

export function linearIsConnected(deps: IpcDeps): boolean {
  return deps.linearManager.isConnected();
}

export function linearGetViewer(
  deps: IpcDeps,
): Promise<{ name: string; email: string }> {
  return deps.linearManager.getViewer();
}

export function linearGetTeams(deps: IpcDeps): unknown {
  return deps.linearManager.getTeams();
}

export function linearGetMyIssues(
  deps: IpcDeps,
  teamIds: string[],
  options?: LinearIssueOptions,
): unknown {
  return deps.linearManager.getMyIssues(teamIds, options);
}

export function linearGetIssueDetail(deps: IpcDeps, issueId: string): unknown {
  return deps.linearManager.getIssueDetail(issueId);
}

export function linearGetAllIssues(
  deps: IpcDeps,
  teamIds: string[],
  options?: LinearIssueOptions,
): unknown {
  return deps.linearManager.getAllIssues(teamIds, options);
}

export function linearStartIssue(deps: IpcDeps, issueId: string): unknown {
  return deps.linearManager.startIssue(issueId);
}

export function linearCloseIssue(deps: IpcDeps, issueId: string): unknown {
  return deps.linearManager.closeIssue(issueId);
}

export function linearLinkIssueToWorkspace(
  deps: IpcDeps,
  projectId: string,
  workspacePath: string,
  issue: LinkedIssue,
): unknown {
  return deps.projectManager.linkIssueToWorkspace(
    projectId,
    workspacePath,
    issue,
  );
}

export function linearUnlinkIssueFromWorkspace(
  deps: IpcDeps,
  projectId: string,
  workspacePath: string,
  issueId: string,
): unknown {
  return deps.projectManager.unlinkIssueFromWorkspace(
    projectId,
    workspacePath,
    issueId,
  );
}

/**
 * Fetch a Linear-hosted image with the stored token and hand back a data URL.
 *
 * The one place the token is *used* on behalf of the renderer rather than by
 * a GraphQL call, and the result is deliberately the bytes rather than a
 * signed URL: an `Authorization` header a component could replay would be the
 * credential crossing under another name.
 */
export function linearProxyImage(deps: IpcDeps, url: string): Promise<string> {
  assertString(url, "url");
  return deps.linearManager.proxyImage(url);
}

/**
 * Guess a Linear team for every project that has none yet.
 *
 * Writes — it sets `linearAssociations` on the projects it matched — so it is
 * in `MUTATING` alongside the issue actions, not with the reads its name
 * suggests.
 */
export async function linearAutoMatch(
  deps: IpcDeps,
): Promise<Record<string, unknown>> {
  const projects = await deps.projectManager.getProjects();
  const teams = await deps.linearManager.getTeams();
  const matches = deps.linearManager.autoMatchProjects(
    projects.map((p) => ({ id: p.id, name: p.name })),
    teams,
  );
  for (const [projectId, association] of Object.entries(matches)) {
    const project = projects.find((p) => p.id === projectId);
    if (project && project.linearAssociations.length === 0) {
      deps.projectManager.updateProject(projectId, {
        linearAssociations: [association],
      });
    }
  }
  return matches;
}
