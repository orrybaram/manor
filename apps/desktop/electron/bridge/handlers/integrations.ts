/**
 * GitHub and Linear, as the `github` and `linear` namespaces of
 * the handler table.
 *
 * Both integrations are the "read and act from anywhere" case at its
 * plainest — an issue list on a phone that cannot start the issue is the
 * read-only state the bridge exists to end — so the whole of `github` and
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
  isLinearAssociation,
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
import { proxyGitHubImage } from "../../github-images";
import { byGhRepo, byHost, byProject, delegated, LOCAL_ROUTE, method, type HandlerCtx } from "../method";
import type { SharedDeps } from "../../ipc/types";

/** What `gh` needs: the host server carries this and no more of `ServerDeps`. */
type GithubDeps = Pick<SharedDeps, "githubManager">;
/** What Linear needs: the host server carries this and no more of `ServerDeps`. */
type LinearDeps = Pick<SharedDeps, "linearManager" | "projectManager">;

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
 * a path, and guessing the host from it picks local. Each `repo`
 * is checked here, for every caller — the handler is the boundary.
 */
export function githubGetPrsForBranches(
  ctx: HandlerCtx<GithubDeps>,
  repo: GhRepo,
  branches: string[],
): Promise<[string, PrInfo | null][]> {
  const r: unknown = repo;
  const b: unknown = branches;
  assertGhRepo(r, "repo");
  assertStringArray(b, "branches");
  return ctx.deps.githubManager.getPrsForBranches(r, b);
}

/** The user's clonable repos, newest push first. */
export function githubListRepos(
  ctx: HandlerCtx<GithubDeps>,
): Promise<GitHubRepo[]> {
  return ctx.deps.githubManager.listRepos();
}

/** The profile's display name, raw; the phone layer picks the first name. */
export function githubGetViewerName(
  ctx: HandlerCtx<GithubDeps>,
): Promise<string | null> {
  return ctx.deps.githubManager.getViewerName();
}

export function githubCheckStatus(
  ctx: HandlerCtx<GithubDeps>,
  _hostId?: string | null,
): Promise<{
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
 * the desktop never had" shape that kept turning up. `GitHubManager` owns the
 * actual defaults; this only says "not given".
 */
export function githubGetMyIssues(
  ctx: HandlerCtx<GithubDeps>,
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
  ctx: HandlerCtx<GithubDeps>,
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
  ctx: HandlerCtx<GithubDeps>,
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
  ctx: HandlerCtx<GithubDeps>,
  repo: GhRepo,
  issueNumber: number,
): Promise<void> {
  assertRepo(repo);
  return ctx.deps.githubManager.assignIssue(repo, issueNumber);
}

export function githubCloseIssue(
  ctx: HandlerCtx<GithubDeps>,
  repo: GhRepo,
  issueNumber: number,
): Promise<void> {
  assertRepo(repo);
  return ctx.deps.githubManager.closeIssue(repo, issueNumber);
}

export function githubCreateIssue(
  ctx: HandlerCtx<GithubDeps>,
  title: string,
  body: string,
  labels: string[],
): Promise<{ url: string } | null> {
  return ctx.deps.githubManager.createIssue(title, body, labels);
}

export function githubUploadFeedbackImages(
  ctx: HandlerCtx<GithubDeps>,
  images: { base64: string; name: string }[],
): Promise<string[]> {
  return ctx.deps.githubManager.uploadFeedbackImages(images);
}

// ── Linear ───────────────────────────────────────────────────────────────────

/**
 * Prove an API key works, then store it, or store nothing.
 *
 * The key is tested before it is saved (`getViewer` takes it directly), so a
 * failed connect writes nothing and emits no `connectionChanged`, and a
 * half-typed key never leaves a connected-looking Linear panel behind.
 */
export async function linearConnect(
  ctx: HandlerCtx<LinearDeps>,
  apiKey: string,
): Promise<{ name: string; email: string }> {
  assertString(apiKey, "apiKey");
  const viewer = await ctx.deps.linearManager.getViewer(apiKey);
  await ctx.deps.linearManager.saveToken(apiKey);
  return viewer;
}

/** Forget the key. Carries no credential in either direction. */
export function linearDisconnect(ctx: HandlerCtx<LinearDeps>): void {
  ctx.deps.linearManager.clearToken();
}

export function linearIsConnected(ctx: HandlerCtx<LinearDeps>): boolean {
  return ctx.deps.linearManager.isConnected();
}

export function linearGetViewer(
  ctx: HandlerCtx<LinearDeps>,
): Promise<{ name: string; email: string }> {
  return ctx.deps.linearManager.getViewer();
}

export function linearGetTeams(
  ctx: HandlerCtx<LinearDeps>,
): Promise<LinearTeam[]> {
  return ctx.deps.linearManager.getTeams();
}

export function linearGetMyIssues(
  ctx: HandlerCtx<LinearDeps>,
  teamIds: string[],
  options?: LinearIssueOptions,
): Promise<LinearIssue[]> {
  return ctx.deps.linearManager.getMyIssues(teamIds, options);
}

export function linearGetIssueDetail(
  ctx: HandlerCtx<LinearDeps>,
  issueId: string,
): Promise<LinearIssueDetail> {
  return ctx.deps.linearManager.getIssueDetail(issueId);
}

export function linearGetAllIssues(
  ctx: HandlerCtx<LinearDeps>,
  teamIds: string[],
  options?: LinearIssueOptions,
): Promise<LinearIssue[]> {
  return ctx.deps.linearManager.getAllIssues(teamIds, options);
}

export function linearStartIssue(
  ctx: HandlerCtx<LinearDeps>,
  issueId: string,
): Promise<void> {
  return ctx.deps.linearManager.startIssue(issueId);
}

export function linearCloseIssue(
  ctx: HandlerCtx<LinearDeps>,
  issueId: string,
): Promise<void> {
  return ctx.deps.linearManager.closeIssue(issueId);
}

export function linearLinkIssueToWorkspace(
  ctx: HandlerCtx<SharedDeps>,
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
  ctx: HandlerCtx<SharedDeps>,
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
  _ctx: HandlerCtx<GithubDeps>,
  url: string,
): Promise<string> {
  assertString(url, "url");
  return proxyGitHubImage(url);
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
  ctx: HandlerCtx<LinearDeps>,
  url: string,
): Promise<string> {
  assertString(url, "url");
  return ctx.deps.linearManager.proxyImage(url);
}

/** A project `linearAutoMatch` is asked to find a team for. */
export interface LinearMatchCandidate {
  id: string;
  name: string;
}

function assertCandidates(value: unknown): asserts value is LinearMatchCandidate[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (p: unknown) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as LinearMatchCandidate).id === "string" &&
        typeof (p as LinearMatchCandidate).name === "string",
    )
  ) {
    throw new Error("projects must be a list of { id, name }");
  }
}

/**
 * Guess a Linear team for each of `projects` by name — by default, this
 * server's own projects that have none yet.
 *
 * A read: it writes nothing. Its caller is the renderer, which may have had
 * it answered by whichever server holds the token and writes
 * each match to its project's own server with `linear.associateProject`.
 */
export async function linearAutoMatch(
  ctx: HandlerCtx<LinearDeps>,
  projects?: LinearMatchCandidate[],
): Promise<Record<string, LinearAssociation>> {
  let candidates: LinearMatchCandidate[];
  if (projects === undefined) {
    candidates = (await ctx.deps.projectManager.getProjects())
      .filter((p) => p.linearAssociations.length === 0)
      .map((p) => ({ id: p.id, name: p.name }));
  } else {
    assertCandidates(projects);
    candidates = projects.map(({ id, name }) => ({ id, name }));
  }
  if (candidates.length === 0) return {};
  const teams = await ctx.deps.linearManager.getTeams();
  return ctx.deps.linearManager.autoMatchProjects(candidates, teams);
}

/**
 * Give `projectId` the Linear team `association`, if it has none yet: an
 * auto-match's write, made on the project's own server. True
 * when it was written.
 */
export async function linearAssociateProject(
  ctx: HandlerCtx<Pick<SharedDeps, "projectManager">>,
  projectId: string,
  association: LinearAssociation,
): Promise<boolean> {
  assertString(projectId, "projectId");
  if (!isLinearAssociation(association)) throw new Error("association must be a Linear team");
  const project = (await ctx.deps.projectManager.getProjects()).find((p) => p.id === projectId);
  if (!project || project.linearAssociations.length > 0) return false;
  await ctx.deps.projectManager.updateProject(projectId, { linearAssociations: [association] });
  return true;
}

// Assigning, closing or opening an issue is a change every viewer's picker
// shows next time it opens, and a feedback upload puts bytes in a public
// release. The PR and issue reads are not audited.
//
// A `GhRepo` call goes to its host with `byGhRepo`, so a remote workspace's
// PR badge and issues use the box's own `gh` sign-in;
// `checkStatus` takes the host it is asking about. The rest ask this
// machine: the clone dialog's repo list, the viewer's name, new issues and
// the feedback flow.
export const github = {
  getPrsForBranches: method(githubGetPrsForBranches, { route: byGhRepo(0) }),
  // The clone dialog's repo list: what `gh` can see, no writes.
  listRepos: method(githubListRepos, { route: LOCAL_ROUTE }),
  checkStatus: method(githubCheckStatus, { route: byHost(0) }),
  // The phone greeting's name, from the signed-in profile: no writes.
  getViewerName: method(githubGetViewerName, { route: LOCAL_ROUTE }),
  getMyIssues: method(githubGetMyIssues, { route: byGhRepo(0) }),
  getAllIssues: method(githubGetAllIssues, { route: byGhRepo(0) }),
  getIssueDetail: method(githubGetIssueDetail, { route: byGhRepo(0) }),
  proxyImage: method(githubProxyImage, { route: LOCAL_ROUTE }),
  assignIssue: method(githubAssignIssue, { mutating: true, route: byGhRepo(0) }),
  closeIssue: method(githubCloseIssue, { mutating: true, route: byGhRepo(0) }),
  createIssue: method(githubCreateIssue, { mutating: true, route: LOCAL_ROUTE }),
  uploadFeedbackImages: method(githubUploadFeedbackImages, {
    mutating: true,
    route: LOCAL_ROUTE,
  }),
};

export const linear = {
  // The one method in the surface that takes a credential. A raw key in
  // flight is the credential itself, so connecting Linear is done at the
  // machine whose keychain will hold it; and it is never `mutating`, because
  // the audit line records the first argument — the key.
  connect: method(linearConnect, { localOnly: true, secretFirstArg: true, route: LOCAL_ROUTE }),
  // Drops the integration for every viewer.
  disconnect: method(linearDisconnect, { mutating: true, route: LOCAL_ROUTE }),
  isConnected: method(linearIsConnected, { route: LOCAL_ROUTE }),
  // Path-free: the renderer's router picks the server that holds the token;
  // main answers them itself.
  getViewer: method(linearGetViewer, { route: delegated("linear") }),
  getTeams: method(linearGetTeams, { route: delegated("linear") }),
  getMyIssues: method(linearGetMyIssues, { route: delegated("linear") }),
  getIssueDetail: method(linearGetIssueDetail, { route: delegated("linear") }),
  getAllIssues: method(linearGetAllIssues, { route: delegated("linear") }),
  proxyImage: method(linearProxyImage, { route: delegated("linear") }),
  // A read: its matches are written by `associateProject`, below.
  autoMatch: method(linearAutoMatch, { route: delegated("linear") }),
  startIssue: method(linearStartIssue, { mutating: true, route: delegated("linear") }),
  closeIssue: method(linearCloseIssue, { mutating: true, route: delegated("linear") }),
  // A workspace's linked issues are its project's record: a remote
  // project's host server's.
  linkIssueToWorkspace: method(linearLinkIssueToWorkspace, {
    mutating: true,
    route: byProject(0),
  }),
  unlinkIssueFromWorkspace: method(linearUnlinkIssueFromWorkspace, {
    mutating: true,
    route: byProject(0),
  }),
  // A project's team is its record too, whichever server matched it.
  associateProject: method(linearAssociateProject, { mutating: true, route: byProject(0) }),
};
