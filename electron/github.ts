import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  ChecksSummary,
  PrCheckRun,
  PrCheckStatus,
  PrComment,
  PrInfo,
} from "../src/lib/pr-info";
import { LOCAL_HOST_ID } from "./backend/types";
import { normalizeHostId, workspaceKey, type WorkspaceKey } from "../src/lib/workspace-key";
import type { GhRepo } from "../src/lib/gh-repo";
import {
  conversationsQueryArgs,
  graphqlTarget,
  normalizeRawPr,
  prReviewers,
  prsQueryArgs,
  type RawPr,
  type RawStatusCheck,
  type RepoPrNumbers,
} from "./github-pr-query";

const execFileAsync = promisify(execFile);

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  updatedAt: string;
  author: { login: string };
  createdAt?: string;
  closedAt?: string | null;
  milestone?: { title: string } | null;
  /** Comment count; `gh` sends the comments themselves, dropped before IPC. */
  commentCount?: number;
  stateReason?: string | null;
  /** GitHub Projects v2 membership (needs the `read:project` scope). */
  projectItems?: Array<{ title: string; status?: string }>;
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string | null;
  milestone: { title: string } | null;
}

/** `gh issue list --json` fields shared by `getMyIssues` and `getAllIssues`. */
const ISSUE_LIST_FIELDS =
  "number,title,url,state,labels,assignees,updatedAt,author," +
  "createdAt,closedAt,milestone,comments,stateReason";

/** True when `gh` failed for want of the `read:project` scope. */
function isProjectScopeError(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string } | null;
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  return /read:project|projectItems|missing required scopes?|required scopes?/i.test(
    text,
  );
}

/** `gh`'s `projectItems` (`{title, status: {name}}`) as `{title, status?}[]`. */
function normalizeProjectItems(
  items: unknown,
): Array<{ title: string; status?: string }> {
  if (!Array.isArray(items)) return [];
  const out: Array<{ title: string; status?: string }> = [];
  for (const item of items) {
    const title = item?.title;
    if (typeof title !== "string" || !title) continue;
    const status = item?.status;
    const name = typeof status === "string" ? status : status?.name;
    out.push(
      typeof name === "string" && name ? { title, status: name } : { title },
    );
  }
  return out;
}

/** Parse `gh issue list` output, replacing `comments` with `commentCount`. */
function parseIssueList(stdout: string): GitHubIssue[] {
  const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
  return raw.map((entry) => {
    const { comments, projectItems, ...rest } = entry;
    const issue = { ...rest } as unknown as GitHubIssue;
    if (Array.isArray(comments)) issue.commentCount = comments.length;
    if (projectItems !== undefined) {
      issue.projectItems = normalizeProjectItems(projectItems);
    }
    return issue;
  });
}

/** A repo the signed-in user can clone, from `GitHubManager.listRepos`. */
export interface GitHubRepo {
  nameWithOwner: string;
  description: string | null;
  private: boolean;
  sshUrl: string;
  httpsUrl: string;
  pushedAt: string | null;
  /** `sshUrl` or `httpsUrl`, whichever `gh config get git_protocol` prefers. */
  cloneUrl: string;
}

const REPOS_CACHE_MS = 5 * 60_000;

/**
 * How stale an open PR's cached conversation may get before it is re-fetched
 * even though the PR's `updatedAt` has not moved. Resolving a review thread
 * does not bump `updatedAt`, so this bounds how long a fixed thread keeps the
 * badge blocked.
 */
const CONVERSATION_MAX_AGE_MS = 5 * 60_000;

interface ConversationCacheEntry {
  updatedAt: string | undefined;
  fetchedAt: number;
  /** Merged and closed PRs never change again: fetched once, kept forever. */
  final: boolean;
  state: PrConversationState;
}

/**
 * `[HOST/]OWNER/REPO` for `gh --repo`, from a git remote URL — https, `ssh://`
 * or scp-style (`git@github.com:owner/repo.git`). Null when the URL has no
 * owner/repo path to take one from.
 */
export function ghRepoFromRemoteUrl(url: string): string | null {
  const match =
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url) ??
    /^(?:[^@/]+@)?([^@/:]+):(.+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return null;
  const [, host, path] = match;
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const slug = segments.join("/");
  return host === "github.com" ? slug : `${host}/${slug}`;
}

/**
 * Names the repo `gh` should target for a checkout that `gh` cannot run
 * inside: `[HOST/]OWNER/REPO` for the checkout at `path` on the remote
 * `hostId` (ADR-160), which exists only over there. Throws when its repo
 * cannot be determined.
 */
export type RemoteRepoResolver = (hostId: string, path: string) => Promise<string>;

/** Where and how to run `gh` for a checkout: see `RemoteRepoResolver`. */
interface GhTarget {
  cwd: string | undefined;
  repoArgs: string[];
}

export class GitHubManager {
  /**
   * Remote checkouts' repos, keyed by workspace key (ADR-191), so the same
   * path on two hosts keeps two entries. A checkout's origin rarely moves, and
   * resolving it is an ssh round trip — once per project per poll otherwise.
   */
  private remoteRepoCache = new Map<WorkspaceKey, string>();

  /** Set once `gh` refuses `projectItems` for want of `read:project`. */
  private projectScopeMissing = false;

  /** Without a resolver every checkout is local. */
  constructor(private readonly resolveRemoteRepo?: RemoteRepoResolver) {}

  /**
   * A local checkout runs `gh` in its directory, which reads the repo from
   * it, as before; a remote one runs here against its origin's repo.
   */
  private async ghTarget({ path, hostId }: GhRepo): Promise<GhTarget> {
    const resolve = this.resolveRemoteRepo;
    if (!resolve || normalizeHostId(hostId) === LOCAL_HOST_ID) {
      return { cwd: path, repoArgs: [] };
    }
    const key = workspaceKey(hostId, path);
    let repo = this.remoteRepoCache.get(key);
    if (!repo) {
      repo = await resolve(hostId, path);
      this.remoteRepoCache.set(key, repo);
    }
    return { cwd: undefined, repoArgs: ["--repo", repo] };
  }

  private readyPromise: Promise<boolean> | null = null;

  private reposCache: { at: number; repos: GitHubRepo[] } | null = null;

  /** See `setPrMergedListener`. */
  private onPrMerged: ((prUrl: string) => void) | undefined;

  /**
   * Merged and closed PRs by repo and head branch: they never change again,
   * so their branches are not queried again (#303).
   */
  private settledPrs = new Map<string, PrInfo>();

  /** `getPrsForBranches` lookups still running, by repo and branches. */
  private prLookupsInFlight = new Map<string, Promise<Map<string, PrInfo | null>>>();

  /**
   * Keyed by PR URL. The conversation query is the expensive half of a poll —
   * one GraphQL call per branch, every tick — and it doubled the load that
   * pushed the account past GitHub's 5,000/hour limit with eight worktrees
   * and two app instances (see the popover ADR-167 follow-ups). Now it runs
   * only when the PR reports a change, or after `CONVERSATION_MAX_AGE_MS`.
   */
  private conversationCache = new Map<string, ConversationCacheEntry>();

  /**
   * Memoized: is `gh` installed and authenticated? `checkStatus()` shells out,
   * so this is cached for the process lifetime rather than re-checked per
   * request — the tradeoff being that installing/authenticating `gh` mid-session
   * requires a restart for `list_issues` to notice. Still strictly better than
   * not checking at all.
   */
  async isReady(): Promise<boolean> {
    this.readyPromise ??= this.checkStatus().then(
      (s) => s.installed && s.authenticated,
      () => false,
    );
    return this.readyPromise;
  }

  /**
   * Notified with the PR URL when a poll queries a merged PR — once per
   * process, since a merged PR is not queried again (see `settledPrs`), but
   * again after a restart. Counting it once is the listener's job
   * (`StatsStore.recordOnce`); this side just reports what it saw, since the
   * poll is the only place in the app that learns a PR merged without anyone
   * pressing a button in Manor.
   */
  setPrMergedListener(listener: ((prUrl: string) => void) | undefined): void {
    this.onPrMerged = listener;
  }

  async getPrForBranch(
    repo: GhRepo,
    branch: string,
  ): Promise<PrInfo | null> {
    const [[, pr]] = await this.getPrsForBranches(repo, [branch]);
    return pr;
  }

  /**
   * Every branch's PR in one `gh api graphql` call for the repo, however many
   * branches (#303). A branch whose PR has merged or closed is answered from
   * `settledPrs` and never asked about again. Concurrent calls for the same
   * repo and branches share one lookup rather than each running their own.
   */
  async getPrsForBranches(
    repo: GhRepo,
    branches: string[],
  ): Promise<[string, PrInfo | null][]> {
    const key = `${repoCacheKey(repo)}\0${[...branches].sort().join("\0")}`;
    let pending = this.prLookupsInFlight.get(key);
    if (!pending) {
      pending = this.lookUpPrs(repo, branches).finally(() => {
        this.prLookupsInFlight.delete(key);
      });
      this.prLookupsInFlight.set(key, pending);
    }
    const found = await pending;
    return branches.map((branch) => [branch, found.get(branch) ?? null]);
  }

  /**
   * Each branch's PR: settled ones from `settledPrs`, the rest from GitHub
   * (`fetchPrsFromGitHub`), with their conversations.
   */
  private async lookUpPrs(
    repo: GhRepo,
    branches: string[],
  ): Promise<Map<string, PrInfo | null>> {
    const result = new Map<string, PrInfo | null>();
    const toAsk: string[] = [];
    for (const branch of new Set(branches)) {
      const settled = this.settledPrs.get(settledPrKey(repo, branch));
      if (settled) result.set(branch, settled);
      else toAsk.push(branch);
    }
    if (toAsk.length === 0) return result;

    const raw = await this.fetchPrsFromGitHub(repo, toAsk);
    const conversations = await this.conversationsFor(
      Array.from(raw.values()).filter((pr): pr is RawPr => pr !== null),
    );
    for (const branch of toAsk) {
      const pr = raw.get(branch) ?? null;
      const info = pr ? this.toPrInfo(pr, conversations.get(pr.url) ?? {}) : null;
      // Merged and closed PRs never change again: kept, never re-queried.
      if (info && info.state !== "open") {
        this.settledPrs.set(settledPrKey(repo, branch), info);
      }
      result.set(branch, info);
    }
    return result;
  }

  /**
   * The newest PR (any state) of each branch, as `gh pr list --head` picks
   * it, all in one GraphQL query. Every branch maps to null when the query
   * fails.
   */
  private async fetchPrsFromGitHub(
    repo: GhRepo,
    branches: string[],
  ): Promise<Map<string, RawPr | null>> {
    const result = new Map<string, RawPr | null>(branches.map((b) => [b, null]));
    try {
      const { cwd, repoArgs } = await this.ghTarget(repo);
      const target = graphqlTarget(repoArgs);
      const { stdout } = await execFileAsync(
        "gh",
        ["api", "graphql", ...target.args, ...prsQueryArgs(branches)],
        {
          cwd,
          encoding: "utf-8",
          timeout: 15000,
          env: target.env,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const repository = JSON.parse(stdout)?.data?.repository;
      branches.forEach((branch, i) => {
        const node = repository?.[`b${i}`]?.nodes?.[0];
        if (node) result.set(branch, normalizeRawPr(node));
      });
    } catch {
      // Rate limit, network, no repo: no PRs this time round.
    }
    return result;
  }

  private toPrInfo(pr: RawPr, conversation: PrConversationState): PrInfo {
    const { checks, checkRuns } = parseStatusCheckRollup(pr.statusCheckRollup);
    const {
      unresolvedThreads,
      commentCount,
      latestComment,
      recentComments,
    } = conversation;

    // "Queued to merge" covers both of GitHub's flavours: auto-merge armed
    // on the PR (merges itself once requirements pass) and a merge-queue
    // entry (the repo's queue will merge it). Either way, nobody needs to
    // press the button — which is what the badge exists to say.
    const queuedToMerge =
      pr.autoMergeRequest != null || pr.isInMergeQueue === true;

    const state = pr.state.toLowerCase();

    // GitHub answers MERGEABLE, CONFLICTING, or UNKNOWN while it is still
    // computing the test merge. Only a definite CONFLICTING counts: an
    // UNKNOWN resolves on a later poll rather than flashing the badge.
    const hasConflicts = state === "open" && pr.mergeable === "CONFLICTING";

    if (state === "merged" && this.onPrMerged) {
      try {
        this.onPrMerged(pr.url);
      } catch (err) {
        // A stats listener must never cost the caller its PR info.
        console.error(
          "[GitHubManager] onPrMerged listener threw:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      number: pr.number,
      state,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      additions: pr.additions,
      deletions: pr.deletions,
      reviewDecision: pr.reviewDecision || null,
      reviewers: prReviewers(pr),
      checks,
      unresolvedThreads,
      commentCount,
      latestComment,
      recentComments,
      checkRuns,
      queuedToMerge,
      hasConflicts,
      updatedAt: pr.updatedAt,
    };
  }

  /**
   * Each PR's conversation, by URL: from the cache while it is fresh (or the
   * PR is final), the rest in one query.
   */
  private async conversationsFor(
    prs: RawPr[],
  ): Promise<Map<string, PrConversationState>> {
    const result = new Map<string, PrConversationState>();
    const stale: RawPr[] = [];
    for (const pr of prs) {
      const cached = this.conversationCache.get(pr.url);
      if (cached) {
        const fresh =
          cached.updatedAt === pr.updatedAt &&
          Date.now() - cached.fetchedAt < CONVERSATION_MAX_AGE_MS;
        if (cached.final || fresh) {
          result.set(pr.url, cached.state);
          continue;
        }
      }
      stale.push(pr);
    }
    if (stale.length === 0) return result;

    const fetched = await this.getPrConversationStates(stale);
    for (const pr of stale) {
      const state = fetched?.get(pr.url);
      // A failed query (rate limit, network) is not worth remembering: the
      // next poll should try again rather than serve "no comments" for five
      // minutes — or, for a merged PR, forever.
      if (!state) {
        result.set(pr.url, this.conversationCache.get(pr.url)?.state ?? {});
        continue;
      }
      this.conversationCache.set(pr.url, {
        updatedAt: pr.updatedAt,
        fetchedAt: Date.now(),
        final: pr.state.toUpperCase() !== "OPEN",
        state,
      });
      result.set(pr.url, state);
    }
    return result;
  }

  /**
   * Every PR's conversation state by URL, in one GraphQL query. Null when
   * the query itself failed, as opposed to PRs with no comments; a PR whose
   * URL names no github.com repo maps to `{}`.
   */
  private async getPrConversationStates(
    prs: RawPr[],
  ): Promise<Map<string, PrConversationState> | null> {
    const result = new Map<string, PrConversationState>();
    const byRepo = new Map<string, RawPr[]>();
    for (const pr of prs) {
      const match = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\//);
      if (!match) {
        result.set(pr.url, {});
        continue;
      }
      const slug = `${match[1]}/${match[2]}`;
      byRepo.set(slug, [...(byRepo.get(slug) ?? []), pr]);
    }
    if (byRepo.size === 0) return result;

    const repos: RepoPrNumbers[] = Array.from(byRepo, ([slug, repoPrs]) => {
      const [owner, name] = slug.split("/");
      return { owner, name, numbers: repoPrs.map((pr) => pr.number) };
    });

    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["api", "graphql", ...conversationsQueryArgs(repos)],
        {
          encoding: "utf-8",
          timeout: 15000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const data = JSON.parse(stdout)?.data;
      Array.from(byRepo.values()).forEach((repoPrs, r) => {
        repoPrs.forEach((pr, p) => {
          result.set(
            pr.url,
            parsePrConversationState(data?.[`r${r}`]?.[`p${p}`], data?.viewer?.login),
          );
        });
      });
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Throws when `gh` fails. Deliberately: swallowing the error and returning
   * `[]` makes a broken `gh`, an unauthenticated user, and a genuinely empty
   * backlog indistinguishable — an agent asking for issues reads "no issues
   * found" and concludes there is no work. Callers already expect a rejection
   * (`WorkspaceEmptyState` catches, react-query surfaces `isError`), and the
   * MCP issue route maps it to a 502. Matches `getIssueDetail`, which has
   * always thrown.
   */
  async getMyIssues(
    repo: GhRepo,
    limit = 50,
    state: "open" | "closed" | "all" = "open",
  ): Promise<GitHubIssue[]> {
    return this.listIssues(repo, ["--assignee", "@me"], limit, state);
  }

  /** Throws when `gh` fails — see `getMyIssues`. */
  async getAllIssues(
    repo: GhRepo,
    limit = 50,
    state: "open" | "closed" | "all" = "open",
  ): Promise<GitHubIssue[]> {
    return this.listIssues(repo, [], limit, state);
  }

  /**
   * `projectItems` needs the `read:project` scope; on a scope error the call
   * is retried once without it, and later calls leave it out. Any other
   * failure throws.
   */
  private async listIssues(
    repo: GhRepo,
    filterArgs: string[],
    limit: number,
    state: "open" | "closed" | "all",
  ): Promise<GitHubIssue[]> {
    const { cwd, repoArgs } = await this.ghTarget(repo);
    const run = async (fields: string) => {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "issue",
          "list",
          ...repoArgs,
          ...filterArgs,
          "--state",
          state,
          "--json",
          fields,
          "--limit",
          String(limit),
        ],
        { cwd, encoding: "utf-8", timeout: 10000 },
      );
      return parseIssueList(stdout);
    };
    if (this.projectScopeMissing) return run(ISSUE_LIST_FIELDS);
    try {
      return await run(`${ISSUE_LIST_FIELDS},projectItems`);
    } catch (err) {
      if (!isProjectScopeError(err)) throw err;
      // Skip `projectItems` from now on; `gh auth refresh` needs a restart to show.
      this.projectScopeMissing = true;
      return run(ISSUE_LIST_FIELDS);
    }
  }

  /**
   * Prefer `issueUrl` when the caller has one: a bare number resolves against
   * whatever repo `repo`'s remote points at, so an issue linked from
   * another repo (or a checkout whose default remote is a fork) fails to load.
   */
  async getIssueDetail(
    repo: GhRepo,
    issueNumber: number,
    issueUrl?: string,
  ): Promise<GitHubIssueDetail> {
    const { cwd, repoArgs } = await this.ghTarget(repo);
    const { stdout } = await execFileAsync(
      "gh",
      [
        "issue",
        "view",
        issueUrl || String(issueNumber),
        ...repoArgs,
        "--json",
        "number,title,url,state,body,labels,assignees,milestone,updatedAt,author",
      ],
      { cwd, encoding: "utf-8", timeout: 10000 },
    );
    return JSON.parse(stdout);
  }

  /** Throws when `gh` fails — see `getMyIssues`; a caller that requested an assignment is entitled to know it didn't happen. */
  async assignIssue(repo: GhRepo, issueNumber: number): Promise<void> {
    const { cwd, repoArgs } = await this.ghTarget(repo);
    await execFileAsync(
      "gh",
      ["issue", "edit", String(issueNumber), ...repoArgs, "--add-assignee", "@me"],
      {
        cwd,
        encoding: "utf-8",
        timeout: 10000,
      },
    );
  }

  /** Throws when `gh` fails — see `getMyIssues`; a caller that told the user the issue is closed must be right. */
  async closeIssue(repo: GhRepo, issueNumber: number): Promise<void> {
    const { cwd, repoArgs } = await this.ghTarget(repo);
    await execFileAsync("gh", ["issue", "close", String(issueNumber), ...repoArgs], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
  }

  /**
   * Create an issue. With no `repo` this targets Manor's own repo — the
   * in-app feedback form, its original and only renderer caller. `repo`
   * (passed by `POST /projects/:projectId/issues`, ADR-171) instead runs `gh`
   * inside that checkout, so the issue lands on whatever repo the project is.
   */
  async createIssue(
    title: string,
    body: string,
    labels: string[],
    repo?: GhRepo,
  ): Promise<{ url: string } | null> {
    const target: GhTarget | null = repo
      ? await this.ghTarget(repo).catch(() => null)
      : { cwd: undefined, repoArgs: ["--repo", "orrybaram/manor"] };
    if (target === null) return null;
    const baseArgs = [
      "issue",
      "create",
      ...target.repoArgs,
      "--title",
      title,
      "--body",
      body,
    ];
    const execOptions = {
      cwd: target.cwd,
      encoding: "utf-8" as const,
      timeout: 15000,
    };

    // Try with labels first, fall back to without if labels don't exist
    const labelArgs: string[] = [];
    for (const label of labels) {
      labelArgs.push("--label", label);
    }

    try {
      const { stdout } = await execFileAsync(
        "gh",
        [...baseArgs, ...labelArgs],
        execOptions,
      );
      return { url: stdout.trim() };
    } catch {
      // Labels may not exist — retry without them
      try {
        const { stdout } = await execFileAsync("gh", baseArgs, execOptions);
        return { url: stdout.trim() };
      } catch {
        return null;
      }
    }
  }

  async uploadFeedbackImages(
    images: { base64: string; name: string }[],
  ): Promise<string[]> {
    const REPO = "orrybaram/manor";
    const TAG = "feedback-assets";

    // Ensure the release exists
    try {
      await execFileAsync("gh", ["release", "view", TAG, "--repo", REPO], {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      await execFileAsync(
        "gh",
        [
          "release",
          "create",
          TAG,
          "--repo",
          REPO,
          "--title",
          "Feedback Assets",
          "--notes",
          "Auto-created for feedback screenshots",
        ],
        { encoding: "utf-8", timeout: 15000 },
      );
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "manor-feedback-"));
    const urls: string[] = [];

    for (const img of images) {
      const filePath = join(tmpDir, img.name);
      await writeFile(filePath, Buffer.from(img.base64, "base64"));

      try {
        await execFileAsync(
          "gh",
          ["release", "upload", TAG, filePath, "--repo", REPO, "--clobber"],
          { encoding: "utf-8", timeout: 30000 },
        );
        urls.push(
          `https://github.com/${REPO}/releases/download/${TAG}/${img.name}`,
        );
      } finally {
        await unlink(filePath).catch(() => {});
      }
    }

    return urls;
  }

  /**
   * The repos the signed-in user can clone, most recently pushed first. Any
   * failure (gh missing, not signed in, offline) yields `[]` rather than
   * throwing: the caller falls back to pasting a URL. Cached for 5 minutes.
   */
  async listRepos(): Promise<GitHubRepo[]> {
    if (this.reposCache && Date.now() - this.reposCache.at < REPOS_CACHE_MS) {
      return this.reposCache.repos;
    }
    try {
      let protocol = "";
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["config", "get", "git_protocol"],
          { encoding: "utf-8", timeout: 5000 },
        );
        protocol = stdout.trim();
      } catch {
        // Unset or unreadable: default to https.
      }
      // `--paginate` joins pages as `][`; one object per line sidesteps it.
      const { stdout } = await execFileAsync(
        "gh",
        [
          "api",
          "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
          "--paginate",
          "--jq",
          ".[] | {full_name, description, private, ssh_url, clone_url, pushed_at}",
        ],
        { encoding: "utf-8", timeout: 60000, maxBuffer: 50 * 1024 * 1024 },
      );
      const repos: GitHubRepo[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const raw = JSON.parse(line) as {
          full_name: string;
          description: string | null;
          private: boolean;
          ssh_url: string;
          clone_url: string;
          pushed_at: string | null;
        };
        repos.push({
          nameWithOwner: raw.full_name,
          description: raw.description,
          private: raw.private,
          sshUrl: raw.ssh_url,
          httpsUrl: raw.clone_url,
          pushedAt: raw.pushed_at,
          cloneUrl: protocol === "ssh" ? raw.ssh_url : raw.clone_url,
        });
      }
      repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
      this.reposCache = { at: Date.now(), repos };
      return repos;
    } catch (err) {
      console.error("[github] listRepos failed:", err);
      return [];
    }
  }

  async checkStatus(): Promise<{
    installed: boolean;
    authenticated: boolean;
    username?: string;
  }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        "gh",
        ["auth", "status", "--hostname", "github.com"],
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      // gh auth status outputs to stdout, parse username from "Logged in to github.com account username ..."
      const combined = stdout + stderr;
      const match = combined.match(/account\s+(\S+)/);
      return { installed: true, authenticated: true, username: match?.[1] };
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string };
      // gh exists but not authenticated → exit code 1
      if (
        e.stderr?.includes("not logged in") ||
        e.stdout?.includes("not logged in")
      ) {
        return { installed: true, authenticated: false };
      }
      // gh not found → ENOENT
      return { installed: false, authenticated: false };
    }
  }
}

interface PrConversationState {
  unresolvedThreads?: number;
  commentCount?: number;
  latestComment?: PrComment | null;
  recentComments?: PrComment[];
}

interface RawConversationNode {
  author?: { login?: string; __typename?: string } | null;
  body?: string;
  url?: string;
  createdAt?: string;
  submittedAt?: string;
  state?: string;
}

interface RawReviewThread {
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  comments?: { nodes?: RawConversationNode[] };
}

/** How many conversation entries the popover keeps after interleaving. */
const RECENT_COMMENT_LIMIT = 12;

/** What `getPrsForBranches` caches by: one checkout on one host. */
function repoCacheKey({ path, hostId }: GhRepo): string {
  return `${normalizeHostId(hostId)}\0${path}`;
}

/** `GitHubManager.settledPrs`' key: one branch of one checkout. */
function settledPrKey(repo: GhRepo, branch: string): string {
  return `${repoCacheKey(repo)}\0${branch}`;
}

const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);

/** Conclusions that mean "this run had nothing to say" — never a blocker. */
const SKIPPED_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL"]);

function checkStatusOf(check: RawStatusCheck): PrCheckStatus {
  const verdict = (check.conclusion || check.state || "").toUpperCase();
  if (verdict === "SUCCESS") return "passing";
  if (FAILING_CONCLUSIONS.has(verdict)) return "failing";
  if (SKIPPED_CONCLUSIONS.has(verdict)) return "skipped";
  return "pending";
}

/**
 * The rollup lists every run on the head commit, so a workflow that was
 * cancelled and run again (or a job re-run after failing) leaves its old
 * attempt behind, still failing, next to the new one. Like `gh pr checks`,
 * keep only the newest run of each check, a check being a name within a
 * workflow. A run with no start time is still queued: newer than any that
 * started.
 */
function latestAttempts(rollup: RawStatusCheck[]): RawStatusCheck[] {
  const startOf = (check: RawStatusCheck) => {
    const at = check.startedAt ?? check.createdAt;
    if (at == null) return Infinity;
    const time = Date.parse(at);
    return Number.isNaN(time) ? -Infinity : time;
  };
  const latest = new Map<string, RawStatusCheck>();
  for (const check of rollup) {
    const key = `${check.workflowName ?? ""}\0${check.name ?? check.context ?? ""}`;
    const seen = latest.get(key);
    if (!seen || startOf(check) >= startOf(seen)) latest.set(key, check);
  }
  return Array.from(latest.values());
}

/**
 * Exported for tests. Returns both the counts the badge reads and the named
 * runs the popover lists, ordered failing → pending → passing → skipped so
 * the UI can truncate from the end and still show what matters.
 */
export function parseStatusCheckRollup(rollup: unknown): {
  checks: ChecksSummary | null;
  checkRuns?: PrCheckRun[];
} {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { checks: null };
  }
  const latest = latestAttempts(rollup as RawStatusCheck[]);

  const rank: Record<PrCheckStatus, number> = {
    failing: 0,
    pending: 1,
    passing: 2,
    skipped: 3,
  };
  const counts: Required<ChecksSummary> = {
    total: latest.length,
    passing: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
  };
  const runs: PrCheckRun[] = [];

  for (const raw of latest) {
    const status = checkStatusOf(raw);
    counts[status]++;
    runs.push({
      name: raw.name || raw.context || "check",
      status,
      url: raw.detailsUrl || raw.targetUrl || null,
      workflow: raw.workflowName || null,
    });
  }

  runs.sort((a, b) => rank[a.status] - rank[b.status]);
  return { checks: counts, checkRuns: runs };
}

/**
 * Reduce the `pullRequest` object of the conversation query to what the UI
 * keeps. Exported for tests; the network half above is not worth mocking.
 *
 * `commentCount` is issue comments plus reviews — one number for "did anyone
 * say anything" — so `latestComment` is drawn from the same two connections:
 * whichever of the newest comment and the newest review is more recent.
 */
export function parsePrConversationState(
  pullRequest: unknown,
  viewerLogin?: string | null,
): PrConversationState {
  if (!pullRequest || typeof pullRequest !== "object") return {};
  const pr = pullRequest as {
    reviewThreads?: { nodes?: RawReviewThread[] };
    comments?: { totalCount?: number; nodes?: RawConversationNode[] };
    reviews?: { totalCount?: number; nodes?: RawConversationNode[] };
  };

  const threads = pr.reviewThreads?.nodes;
  const unresolvedThreads = Array.isArray(threads)
    ? threads.filter((t) => !t.isResolved).length
    : undefined;

  const commentsTotal = pr.comments?.totalCount;
  const reviewsTotal = pr.reviews?.totalCount;
  const commentCount =
    typeof commentsTotal === "number" && typeof reviewsTotal === "number"
      ? commentsTotal + reviewsTotal
      : undefined;

  const comments = pr.comments?.nodes ?? [];
  const reviews = pr.reviews?.nodes ?? [];
  const newest = <T>(nodes: T[]): T | undefined => nodes[nodes.length - 1];

  const candidates = [
    toPrComment(newest(comments), viewerLogin),
    toPrComment(newest(reviews), viewerLogin),
  ].filter((c): c is PrComment => c !== null);
  const latestComment =
    commentCount === undefined
      ? undefined
      : (candidates.sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        )[0] ?? null);

  const recentComments = collectRecentComments(
    comments,
    reviews,
    threads,
    viewerLogin,
  );
  return {
    unresolvedThreads,
    commentCount,
    latestComment,
    recentComments,
  };
}

/**
 * Interleave the three places a human can say something on a PR — issue
 * comments, submitted reviews, and inline review threads — newest first.
 *
 * Anything without text is dropped: a bodiless review is the empty wrapper
 * GitHub creates around inline comments (and a bare approval is already the
 * "Approved" summary row), and a bodiless comment or thread head has nothing
 * to read. Without this the list is half "No comment text." rows.
 */
function collectRecentComments(
  comments: RawConversationNode[],
  reviews: RawConversationNode[],
  threads: RawReviewThread[] | undefined,
  viewerLogin?: string | null,
): PrComment[] {
  const entries: PrComment[] = [];

  for (const node of comments) {
    const c = toPrComment(node, viewerLogin);
    if (!c || !c.body.trim()) continue;
    entries.push({ ...c, kind: "comment" });
  }

  for (const node of reviews) {
    const c = toPrComment(node, viewerLogin);
    if (!c || !c.body.trim()) continue;
    const state = typeof node.state === "string" ? node.state : null;
    entries.push({ ...c, kind: "review", reviewState: state });
  }

  for (const thread of threads ?? []) {
    const c = toPrComment(thread.comments?.nodes?.[0], viewerLogin);
    if (!c || !c.body.trim()) continue;
    entries.push({
      ...c,
      kind: "thread",
      path: thread.path ?? null,
      isResolved: thread.isResolved === true,
      isOutdated: thread.isOutdated === true,
    });
  }

  return entries
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECENT_COMMENT_LIMIT);
}

function toPrComment(
  node: RawConversationNode | undefined,
  viewerLogin?: string | null,
): PrComment | null {
  if (!node || typeof node.url !== "string") return null;
  const createdAt = node.createdAt ?? node.submittedAt;
  if (typeof createdAt !== "string") return null;
  const author = node.author?.login ?? "";
  const comment: PrComment = {
    author,
    body: typeof node.body === "string" ? node.body : "",
    url: node.url,
    createdAt,
  };
  // Set only when true: the flags read as "known to be a bot" / "known to be
  // yours", and an absent flag is the same "no" a pre-tagging payload gives.
  if (isBotAuthor(node.author)) comment.isBot = true;
  if (
    author &&
    viewerLogin &&
    author.toLowerCase() === viewerLogin.toLowerCase()
  ) {
    comment.isViewer = true;
  }
  return comment;
}

/**
 * GraphQL answers this outright — an App author is a `Bot`, not a `User` — but
 * the login suffix is checked too: a bot acting through a machine *user*
 * account (`some-ci[bot]`, `renovate[bot]`) types as `User` and would slip
 * past `__typename` alone.
 */
function isBotAuthor(
  author: { login?: string; __typename?: string } | null | undefined,
): boolean {
  if (!author) return false;
  if (author.__typename === "Bot") return true;
  return (author.login ?? "").toLowerCase().endsWith("[bot]");
}
