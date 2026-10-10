/**
 * GitHub and Linear (ADR-180 D8), as the `github` and `linear` namespaces of
 * the handler table.
 *
 * Both integrations are the ADR-178 "read and act from anywhere" case at its
 * plainest — an issue list on a phone that cannot start the issue is the
 * read-and-type state this slice exists to end — so the whole of `github` and
 * all but one of `linear` are ordinary table entries.
 *
 * **Credentials never cross.** `LinearManager` keeps the API key in
 * `safeStorage`, and every method below that needs it hands back the *result*
 * of using it and never the key: `isConnected` a boolean, `proxyImage` a data
 * URL, the rest GraphQL payloads. `linearConnect` is the one that takes a raw
 * key as an argument rather than producing one, and it is `localOnly` for
 * that reason alone — a table entry a device is refused, not a hole in the
 * table. GitHub needs no such care: it shells out to `gh`, which holds its
 * own credential, `checkStatus` reports a username, and `proxyImage` uses
 * `gh`'s token to hand back image bytes, never the token.
 */

import {
  assertGhRepo,
  assertString,
  assertStringArray,
} from "../../ipc-validate";
import type {
  GitHubIssue,
  GitHubIssueDetail,
  GitHubRepo,
} from "../../github";
import type { GhRepo } from "../../../src/lib/gh-repo";
import type {
  LinearAssociation,
  LinearIssue,
  LinearIssueDetail,
  LinearTeam,
  LinkedIssue,
} from "../../linear";
import type { PrInfo } from "../../../src/lib/pr-info";
import { method, type HandlerCtx } from "../method";

type IssueState = "open" | "closed" | "all";
type LinearIssueOptions = { stateTypes?: string[]; limit?: number };

// ── GitHub ───────────────────────────────────────────────────────────────────

/** The wire's `repo`, checked whatever its declared type says. */
function assertRepo(repo: GhRepo): void {
  const value: unknown = repo;
  assertGhRepo(value, "repo");
}

/**
 * Every checkout names its project's host: a local and a remote one can share
 * a path, and guessing the host from it picks local (ADR-191). Each `repo`
 * is checked here, for every caller — the handler is the boundary.
 */
export function githubGetPrsForBranches(
  ctx: HandlerCtx,
  repo: GhRepo,
  branches: string[],
): Promise<[string, PrInfo | null][]> {
  const r: unknown = repo;
  const b: unknown = branches;
  assertGhRepo(r, "repo");
  assertStringArray(b, "branches");
  return ctx.deps.githubManager.getPrsForBranches(r, b);
}

/** The user's clonable repos, newest push first (ADR-194). */
export function githubListRepos(ctx: HandlerCtx): Promise<GitHubRepo[]> {
  return ctx.deps.githubManager.listRepos();
}

export function githubCheckStatus(ctx: HandlerCtx): Promise<{
  installed: boolean;
  authenticated: boolean;
  username?: string;
}> {
  return ctx.deps.githubManager.checkStatus();
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
  ctx: HandlerCtx,
  repo: GhRepo,
  limit?: number | null,
  state?: IssueState | null,
): Promise<GitHubIssue[]> {
  assertRepo(repo);
  return ctx.deps.githubManager.getMyIssues(
    repo,
    limit ?? undefined,
    state ?? undefined,
  );
}

export function githubGetAllIssues(
  ctx: HandlerCtx,
  repo: GhRepo,
  limit?: number | null,
  state?: IssueState | null,
): Promise<GitHubIssue[]> {
  assertRepo(repo);
  return ctx.deps.githubManager.getAllIssues(
    repo,
    limit ?? undefined,
    state ?? undefined,
  );
}

export function githubGetIssueDetail(
  ctx: HandlerCtx,
  repo: GhRepo,
  issueNumber: number,
  issueUrl?: string | null,
): Promise<GitHubIssueDetail> {
  assertRepo(repo);
  return ctx.deps.githubManager.getIssueDetail(
    repo,
    issueNumber,
    issueUrl ?? undefined,
  );
}

export function githubAssignIssue(
  ctx: HandlerCtx,
  repo: GhRepo,
  issueNumber: number,
): Promise<void> {
  assertRepo(repo);
  return ctx.deps.githubManager.assignIssue(repo, issueNumber);
}

export function githubCloseIssue(
  ctx: HandlerCtx,
  repo: GhRepo,
  issueNumber: number,
): Promise<void> {
  assertRepo(repo);
  return ctx.deps.githubManager.closeIssue(repo, issueNumber);
}

export function githubCreateIssue(
  ctx: HandlerCtx,
  title: string,
  body: string,
  labels: string[],
): Promise<{ url: string } | null> {
  return ctx.deps.githubManager.createIssue(title, body, labels);
}

export function githubUploadFeedbackImages(
  ctx: HandlerCtx,
  images: { base64: string; name: string }[],
): Promise<string[]> {
  return ctx.deps.githubManager.uploadFeedbackImages(images);
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
  ctx: HandlerCtx,
  apiKey: string,
): Promise<{ name: string; email: string }> {
  assertString(apiKey, "apiKey");
  ctx.deps.linearManager.saveToken(apiKey);
  try {
    return await ctx.deps.linearManager.getViewer();
  } catch (err) {
    ctx.deps.linearManager.clearToken();
    throw err;
  }
}

/** Forget the key. Carries no credential in either direction. */
export function linearDisconnect(ctx: HandlerCtx): void {
  ctx.deps.linearManager.clearToken();
}

export function linearIsConnected(ctx: HandlerCtx): boolean {
  return ctx.deps.linearManager.isConnected();
}

export function linearGetViewer(
  ctx: HandlerCtx,
): Promise<{ name: string; email: string }> {
  return ctx.deps.linearManager.getViewer();
}

export function linearGetTeams(ctx: HandlerCtx): Promise<LinearTeam[]> {
  return ctx.deps.linearManager.getTeams();
}

export function linearGetMyIssues(
  ctx: HandlerCtx,
  teamIds: string[],
  options?: LinearIssueOptions,
): Promise<LinearIssue[]> {
  return ctx.deps.linearManager.getMyIssues(teamIds, options);
}

export function linearGetIssueDetail(
  ctx: HandlerCtx,
  issueId: string,
): Promise<LinearIssueDetail> {
  return ctx.deps.linearManager.getIssueDetail(issueId);
}

export function linearGetAllIssues(
  ctx: HandlerCtx,
  teamIds: string[],
  options?: LinearIssueOptions,
): Promise<LinearIssue[]> {
  return ctx.deps.linearManager.getAllIssues(teamIds, options);
}

export function linearStartIssue(
  ctx: HandlerCtx,
  issueId: string,
): Promise<void> {
  return ctx.deps.linearManager.startIssue(issueId);
}

export function linearCloseIssue(
  ctx: HandlerCtx,
  issueId: string,
): Promise<void> {
  return ctx.deps.linearManager.closeIssue(issueId);
}

export function linearLinkIssueToWorkspace(
  ctx: HandlerCtx,
  projectId: string,
  workspacePath: string,
  issue: LinkedIssue,
): void {
  return ctx.deps.projectManager.linkIssueToWorkspace(
    projectId,
    workspacePath,
    issue,
  );
}

export function linearUnlinkIssueFromWorkspace(
  ctx: HandlerCtx,
  projectId: string,
  workspacePath: string,
  issueId: string,
): void {
  return ctx.deps.projectManager.unlinkIssueFromWorkspace(
    projectId,
    workspacePath,
    issueId,
  );
}

/**
 * Fetch an issue-body image with `gh`'s token and hand back a data URL, so
 * a private repo's screenshots render. Bytes, never the token — see
 * `linearProxyImage`.
 */
export function githubProxyImage(
  ctx: HandlerCtx,
  url: string,
): Promise<string> {
  assertString(url, "url");
  return ctx.deps.githubManager.proxyImage(url);
}

/**
 * Fetch a Linear-hosted image with the stored token and hand back a data URL.
 *
 * The one place the token is *used* on behalf of the renderer rather than by
 * a GraphQL call, and the result is deliberately the bytes rather than a
 * signed URL: an `Authorization` header a component could replay would be the
 * credential crossing under another name.
 */
export function linearProxyImage(
  ctx: HandlerCtx,
  url: string,
): Promise<string> {
  assertString(url, "url");
  return ctx.deps.linearManager.proxyImage(url);
}

/**
 * Guess a Linear team for every project that has none yet.
 *
 * Writes — it sets `linearAssociations` on the projects it matched — so it is
 * `mutating` alongside the issue actions, not with the reads its name
 * suggests.
 */
export async function linearAutoMatch(
  ctx: HandlerCtx,
): Promise<Record<string, LinearAssociation>> {
  const projects = await ctx.deps.projectManager.getProjects();
  const teams = await ctx.deps.linearManager.getTeams();
  const matches = ctx.deps.linearManager.autoMatchProjects(
    projects.map((p) => ({ id: p.id, name: p.name })),
    teams,
  );
  for (const [projectId, association] of Object.entries(matches)) {
    const project = projects.find((p) => p.id === projectId);
    if (project && project.linearAssociations.length === 0) {
      ctx.deps.projectManager.updateProject(projectId, {
        linearAssociations: [association],
      });
    }
  }
  return matches;
}

// Assigning, closing or opening an issue is a change every viewer's picker
// shows next time it opens, and a feedback upload puts bytes in a public
// release. The PR and issue reads are not audited.
export const github = {
  getPrsForBranches: method(githubGetPrsForBranches),
  // The clone dialog's repo list (ADR-194): what `gh` can see, no writes.
  listRepos: method(githubListRepos),
  checkStatus: method(githubCheckStatus),
  getMyIssues: method(githubGetMyIssues),
  getAllIssues: method(githubGetAllIssues),
  getIssueDetail: method(githubGetIssueDetail),
  proxyImage: method(githubProxyImage),
  assignIssue: method(githubAssignIssue, { mutating: true }),
  closeIssue: method(githubCloseIssue, { mutating: true }),
  createIssue: method(githubCreateIssue, { mutating: true }),
  uploadFeedbackImages: method(githubUploadFeedbackImages, { mutating: true }),
};

export const linear = {
  // The one method in the surface that takes a credential. A raw key in
  // flight is the credential itself, so connecting Linear is done at the
  // machine whose keychain will hold it; and it is never `mutating`, because
  // the audit line records the first argument — the key.
  connect: method(linearConnect, { localOnly: true, secretFirstArg: true }),
  // Drops the integration for every viewer.
  disconnect: method(linearDisconnect, { mutating: true }),
  isConnected: method(linearIsConnected),
  getViewer: method(linearGetViewer),
  getTeams: method(linearGetTeams),
  getMyIssues: method(linearGetMyIssues),
  getIssueDetail: method(linearGetIssueDetail),
  getAllIssues: method(linearGetAllIssues),
  proxyImage: method(linearProxyImage),
  autoMatch: method(linearAutoMatch, { mutating: true }),
  startIssue: method(linearStartIssue, { mutating: true }),
  closeIssue: method(linearCloseIssue, { mutating: true }),
  linkIssueToWorkspace: method(linearLinkIssueToWorkspace, { mutating: true }),
  unlinkIssueFromWorkspace: method(linearUnlinkIssueFromWorkspace, {
    mutating: true,
  }),
};
