import { INBOX_TYPES, type InboxKind } from "../../src/lib/inbox";
import type { InboxFetch, InboxItem, InboxSource } from "./inbox-poller";

/** One entry of GitHub's `GET /notifications`. */
export interface GitHubThread {
  id: string;
  reason: string;
  repository: { full_name: string };
  subject: { title: string; type: string; url: string | null };
}

/** What a `GET /notifications` answered. */
export type GitHubInboxResponse =
  | { status: "not-modified"; pollSeconds: number | null }
  | { status: "ok"; threads: GitHubThread[]; lastModified: string | null; pollSeconds: number | null };

/** Lowercase `owner/repo` of every project, and whether every project answered. */
export interface ProjectRepos {
  repos: Set<string>;
  complete: boolean;
}

export interface GitHubSourceDeps {
  isReady(): Promise<boolean>;
  account(): Promise<string | null>;
  fetchInbox(since: string | undefined, ifModifiedSince: string | undefined): Promise<GitHubInboxResponse>;
  projectRepos(): Promise<ProjectRepos>;
}

const KIND_BY_REASON = new Map<string, InboxKind>(
  INBOX_TYPES.filter((t) => t.source === "github").map((t) => [t.upstream, t.kind]),
);

/**
 * The owner and repo of a remote URL, lowercase, whatever its form. Only the
 * path counts, so an SSH alias (`git@github-work:o/r.git`) still matches.
 */
export function repoFromOrigin(origin: string): string | null {
  const match = origin.trim().replace(/\/+$/, "").replace(/\.git$/i, "").match(/([^/:]+)\/([^/:]+)$/);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** The page for a thread: its API URL converted, or else the repo's. */
export function threadPageUrl(thread: GitHubThread): string {
  const repo = thread.repository.full_name;
  const match = thread.subject.url?.match(
    /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(pulls|issues)\/(\d+)$/,
  );
  if (match) {
    return `https://github.com/${repo}/${match[1] === "pulls" ? "pull" : "issues"}/${match[2]}`;
  }
  if (thread.reason === "security_alert") return `https://github.com/${repo}/security`;
  return `https://github.com/${repo}`;
}

function titleFor(kind: InboxKind | undefined, thread: GitHubThread): string {
  const number = thread.subject.url?.match(/\/(\d+)$/)?.[1];
  const ref = number && /pulls|issues/.test(thread.subject.url ?? "") ? `#${number}` : "";
  switch (kind) {
    case "github-review-requested":
      return ["Review requested", ref].filter(Boolean).join(": ");
    case "github-mentioned":
      return ref ? `Mentioned in ${ref}` : "Mentioned";
    case "github-team-mentioned":
      return ref ? `Team mentioned in ${ref}` : "Team mentioned";
    case "github-assigned":
      return ["Assigned", ref].filter(Boolean).join(": ");
    case "github-security-alert":
      return "Security alert";
    default:
      return thread.subject.title;
  }
}

/**
 * A thread as an item. The key includes the reason: GitHub keeps one thread
 * per PR and bumps it on every comment, so the thread alone would either
 * notify on each comment or hide a later, different reason.
 */
export function threadToItem(thread: GitHubThread, repos: ReadonlySet<string>): InboxItem {
  const kind = KIND_BY_REASON.get(thread.reason);
  const repo = thread.repository.full_name;
  return {
    key: `${thread.id}:${thread.reason}`,
    kind: kind ?? null,
    inScope: repos.has(repo.toLowerCase()),
    title: titleFor(kind, thread),
    body: `${repo.split("/")[1] ?? repo} · ${thread.subject.title}`,
    url: threadPageUrl(thread),
  };
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createGitHubSource(deps: GitHubSourceDeps): InboxSource {
  return {
    id: "github",
    intervalMs: DEFAULT_INTERVAL_MS,
    isReady: deps.isReady,
    account: deps.account,
    coverage: async () => (await deps.projectRepos()).repos.size,
    async fetch(since, cursor): Promise<InboxFetch> {
      const response = await deps.fetchInbox(since, cursor);
      // GitHub names the interval it wants; never go faster than our default.
      const nextDelayMs =
        response.pollSeconds !== null
          ? Math.max(response.pollSeconds * 1000, DEFAULT_INTERVAL_MS)
          : DEFAULT_INTERVAL_MS;
      if (response.status === "not-modified") return { status: "not-modified", nextDelayMs };
      const { repos, complete } = await deps.projectRepos();
      // One malformed thread mustn't stop the rest, now or on every retry.
      const items = response.threads.flatMap((thread) => {
        try {
          return [threadToItem(thread, repos)];
        } catch {
          return [];
        }
      });
      return {
        status: "ok",
        items,
        hold: !complete && items.some((item) => !item.inScope),
        ...(response.lastModified ? { cursor: response.lastModified } : {}),
        nextDelayMs,
      };
    },
  };
}

/**
 * How many pages one check reads. Past this, older threads wait for a bump. It
 * only matters on a first check or after a long absence: later checks ask only
 * for what changed, which rarely fills one page.
 */
export const MAX_INBOX_PAGES = 20;
export const INBOX_PAGE_SIZE = 50;

/**
 * Every page of one check, so noise can't push a request off the first. Only
 * the first page is conditional, and its answer speaks for the check.
 */
export async function fetchInboxPages(
  fetchPage: (page: number) => Promise<GitHubInboxResponse>,
): Promise<GitHubInboxResponse> {
  const first = await fetchPage(1);
  if (first.status !== "ok") return first;
  const threads = [...first.threads];
  let last = first.threads.length;
  for (let page = 2; page <= MAX_INBOX_PAGES && last === INBOX_PAGE_SIZE; page += 1) {
    const next = await fetchPage(page);
    if (next.status !== "ok") break;
    threads.push(...next.threads);
    last = next.threads.length;
  }
  return { ...first, threads };
}

/**
 * `gh api --include` output as a response. Pure so a 304, which `gh` reports by
 * exiting 1, reads the same as any other answer. Throws on anything else.
 */
export function parseInboxResponse(raw: string): GitHubInboxResponse {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 2);
  const lines = head.split("\n");
  const statusCode = Number(lines[0]?.match(/^HTTP\/\S+\s+(\d{3})/)?.[1]);
  const header = (name: string): string | null => {
    const line = lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line ? line.slice(line.indexOf(":") + 1).trim() : null;
  };
  const poll = Number(header("x-poll-interval"));
  const pollSeconds = Number.isFinite(poll) && poll > 0 ? poll : null;
  if (statusCode === 304) return { status: "not-modified", pollSeconds };
  if (statusCode !== 200) {
    throw new Error(`GitHub answered ${Number.isNaN(statusCode) ? "unexpectedly" : statusCode}`);
  }
  const threads: unknown = JSON.parse(body);
  if (!Array.isArray(threads)) throw new Error("GitHub's notifications weren't a list");
  return {
    status: "ok",
    threads: threads as GitHubThread[],
    lastModified: header("last-modified"),
    pollSeconds,
  };
}
