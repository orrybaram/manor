/**
 * The PR card's actions: merging a PR, and the two prompts that hand a PR's
 * problems to an agent — its failing checks with their log tails, and its
 * unresolved review threads with file and line.
 *
 * Pure: the queries `gh` is asked, what its answers reduce to, and the
 * prompts built from them. `GitHubManager` runs `gh`. Nothing here runs on a
 * poll; every query answers one click.
 */

import type { PrMergeMethod, PrMergeOptions } from "../src/lib/pr-info";
import { normalizeRawPr, type RawStatusCheck } from "./github-pr-query";

/** `gh pr merge`'s flag for each method. */
const MERGE_FLAG: Record<PrMergeMethod, string> = {
  squash: "--squash",
  merge: "--merge",
  rebase: "--rebase",
};

const METHOD_OF: Record<string, PrMergeMethod> = {
  SQUASH: "squash",
  MERGE: "merge",
  REBASE: "rebase",
};

/** The order the method menu lists them in, after the repo's default. */
const METHOD_ORDER: PrMergeMethod[] = ["squash", "merge", "rebase"];

/** Lines of failed log kept per job: the error is nearly always at the end. */
export const LOG_TAIL_LINES = 60;

/** The whole prompt's log budget, so ten failing jobs do not make a novel. */
export const LOG_BUDGET_CHARS = 16_000;

/** What the repo answers about merging, as `gh api graphql` asks it. */
export function mergeOptionsQueryArgs(): string[] {
  return [
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-f",
    "query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) " +
      "{ viewerDefaultMergeMethod squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed } }",
  ];
}

/**
 * The repo's allowed methods, its default first. GitHub's default can name a
 * method the repo has since disallowed; the first allowed one stands in.
 */
export function parseMergeOptions(stdout: string): PrMergeOptions {
  const repo = JSON.parse(stdout)?.data?.repository;
  if (!repo) throw new Error("GitHub did not return the repository's merge settings");
  const allowedSet = new Set<PrMergeMethod>();
  if (repo.squashMergeAllowed) allowedSet.add("squash");
  if (repo.mergeCommitAllowed) allowedSet.add("merge");
  if (repo.rebaseMergeAllowed) allowedSet.add("rebase");
  const preferred = METHOD_OF[String(repo.viewerDefaultMergeMethod ?? "").toUpperCase()];
  const ordered = METHOD_ORDER.filter((m) => allowedSet.has(m));
  const defaultMethod = preferred && allowedSet.has(preferred) ? preferred : ordered[0];
  const allowed = defaultMethod
    ? [defaultMethod, ...ordered.filter((m) => m !== defaultMethod)]
    : [];
  return { allowed, autoMergeAllowed: repo.autoMergeAllowed === true };
}

/**
 * `gh pr merge` for one PR. Never `--delete-branch`: from a worktree `gh`
 * would try to check the default branch out locally, and Manor's own
 * workspace cleanup removes the local branch anyway.
 */
export function mergeArgs(number: number, method: PrMergeMethod, auto: boolean): string[] {
  return ["pr", "merge", String(number), MERGE_FLAG[method], ...(auto ? ["--auto"] : [])];
}

const CONTEXT_THREAD_COMMENTS = 10;

/**
 * One PR's checks and review threads, everything the two prompts need, as
 * `gh api graphql` asks it.
 */
export function prContextQueryArgs(number: number): string[] {
  const query =
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) " +
    "{ pullRequest(number: $number) { number title url headRefName " +
    `reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine startLine ` +
    `comments(first: ${CONTEXT_THREAD_COMMENTS}) { nodes { author { login } body url } } } } ` +
    "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { " +
    "__typename " +
    "... on CheckRun { name conclusion status detailsUrl startedAt checkSuite { workflowRun { workflow { name } } } } " +
    "... on StatusContext { context state targetUrl createdAt } " +
    "} } } } } } } }";
  return [
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-F",
    `number=${Number(number)}`,
    "-f",
    `query=${query}`,
  ];
}

export interface PrThreadComment {
  author: string;
  body: string;
  url: string;
}

/** One unresolved review thread, where it hangs and what was said in it. */
export interface PrReviewThread {
  path: string | null;
  /** The line it hangs off now; the original line when the diff moved on. */
  line: number | null;
  startLine: number | null;
  isOutdated: boolean;
  comments: PrThreadComment[];
}

export interface PrContext {
  number: number;
  title: string;
  url: string;
  /** Every check of the head commit, as `gh` flattens the rollup. */
  rollup: RawStatusCheck[];
  /** Unresolved threads only, in GitHub's (file) order. */
  threads: PrReviewThread[];
}

type RawThread = {
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  comments?: { nodes?: Array<{ author?: { login?: string } | null; body?: string; url?: string }> };
};

export function parsePrContext(stdout: string): PrContext {
  const node = JSON.parse(stdout)?.data?.repository?.pullRequest;
  if (!node) throw new Error("GitHub did not return the pull request");
  const { statusCheckRollup } = normalizeRawPr(node);
  const threads: PrReviewThread[] = ((node.reviewThreads?.nodes ?? []) as RawThread[])
    .filter((t) => !t.isResolved)
    .map((t) => ({
      path: t.path ?? null,
      line: t.line ?? t.originalLine ?? null,
      startLine: t.startLine ?? null,
      isOutdated: t.isOutdated === true,
      comments: (t.comments?.nodes ?? [])
        .filter((c) => (c.body ?? "").trim().length > 0)
        .map((c) => ({ author: c.author?.login ?? "", body: c.body ?? "", url: c.url ?? "" })),
    }))
    .filter((t) => t.comments.length > 0);
  return { number: node.number, title: node.title, url: node.url, rollup: statusCheckRollup, threads };
}

/**
 * A GitHub Actions job's id from its check URL
 * (`…/actions/runs/<run>/job/<job>`); null for anything else, whose logs
 * `gh` cannot fetch.
 */
export function actionsJobId(url: string | null | undefined): string | null {
  const m = url?.match(/\/actions\/runs\/\d+\/job\/(\d+)/);
  return m ? m[1] : null;
}

/** `gh run view` for one job's failed steps. */
export function failedLogArgs(jobId: string): string[] {
  return ["run", "view", "--job", jobId, "--log-failed"];
}

/**
 * The end of `gh run view --log-failed`. Each line arrives as
 * `<job>\t<step>\t<timestamp> <text>`; the first two columns and the
 * timestamp say nothing the prompt does not already, so only the text stays.
 */
export function tailFailedLog(raw: string, lines = LOG_TAIL_LINES): string {
  const text = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      const cols = line.split("\t");
      const body = cols.length >= 3 ? cols.slice(2).join("\t") : line;
      return body.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "");
    });
  while (text.length > 0 && text[text.length - 1].trim() === "") text.pop();
  return text.slice(-lines).join("\n");
}

export interface FailingCheck {
  name: string;
  workflow: string | null;
  url: string | null;
  /** The failed log's tail; null when it could not be fetched. */
  logTail: string | null;
}

function header(pr: Pick<PrContext, "number" | "title" | "url">): string {
  return `PR #${pr.number} (${pr.title}), ${pr.url}`;
}

/**
 * The first message for an agent asked to fix a PR's failing checks: each
 * check by name, its link, and the end of its failed log, within one budget.
 */
export function failingChecksPrompt(pr: Pick<PrContext, "number" | "title" | "url">, checks: FailingCheck[]): string {
  let budget = LOG_BUDGET_CHARS;
  const sections = checks.map((check) => {
    const title = check.workflow && check.workflow !== check.name ? `${check.name} (${check.workflow})` : check.name;
    const lines = [`## ${title}`];
    if (check.url) lines.push(check.url);
    if (check.logTail) {
      // `slice(-0)` is the whole string: a spent budget keeps nothing.
      const tail = budget <= 0 ? "" : check.logTail.slice(-budget);
      budget -= tail.length;
      if (tail.length > 0) lines.push("", "Last lines of the failed log:", "```", tail, "```");
      else lines.push("", "The log is left out to keep this message short; open the link above.");
    } else {
      lines.push("", "No log could be fetched for this check; open the link above for details.");
    }
    return lines.join("\n");
  });
  const s = checks.length === 1 ? "" : "s";
  return [
    `${checks.length} check${s} failing on ${header(pr)}.`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    `Find the cause of ${checks.length === 1 ? "the failure" : "each failure"}, fix it on this branch, check it passes locally, then commit and push.`,
  ].join("\n");
}

function where(thread: PrReviewThread): string {
  if (!thread.path) return "General";
  if (thread.line == null) return `\`${thread.path}\``;
  const span = thread.startLine != null && thread.startLine !== thread.line ? `${thread.startLine}-${thread.line}` : `${thread.line}`;
  return `\`${thread.path}:${span}\``;
}

/**
 * The first message for an agent asked to deal with a PR's unresolved review
 * threads: each with its file and line, and every comment in it.
 */
export function reviewThreadsPrompt(pr: Pick<PrContext, "number" | "title" | "url">, threads: PrReviewThread[]): string {
  const sections = threads.map((thread, i) => {
    const lines = [`## ${i + 1}. ${where(thread)}${thread.isOutdated ? " (outdated: the code has changed since)" : ""}`];
    for (const c of thread.comments) {
      lines.push(`@${c.author || "ghost"}: ${c.body.trim()}`);
    }
    const link = thread.comments[0]?.url;
    if (link) lines.push(link);
    return lines.join("\n");
  });
  const s = threads.length === 1 ? "" : "s";
  return [
    `${threads.length} unresolved review thread${s} on ${header(pr)}.`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    "Address each one on this branch: change the code where the reviewer is right, and where you disagree say why in your summary. Then commit and push, and list what you did per thread.",
  ].join("\n");
}
