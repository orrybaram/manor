import type { PrInfo } from "../../../lib/pr-info";
import type { DiffStats } from "../../../store/project-store";

export type CiTone = "passing" | "failing" | "pending";

export type PrStatusChips = {
  /** The open PR's number, title and draft state; null without an open PR. */
  pr: { number: number; title: string; draft: boolean } | null;
  /** Absent when GitHub reports no checks for the PR. */
  ci: { tone: CiTone; label: string; url: string } | null;
  /** Absent when there is neither a local nor a PR diff stat. */
  diff: { additions: number; deletions: number } | null;
};

/**
 * What the chat's status line shows: the workspace's open (or draft) pull
 * request and its CI — a merged or closed PR has nothing left to act on from
 * the chat — and the diff stat. CI links to the first failing run when there
 * is one, so the chip goes straight to what broke. The diff is the local
 * working tree's when it has changes, else the open PR's, so the line works
 * without a PR.
 */
export function prStatusChips(input: {
  pr: PrInfo | null | undefined;
  diffStats: DiffStats | null | undefined;
}): PrStatusChips {
  const { diffStats } = input;
  const pr = input.pr?.state === "open" ? input.pr : null;

  let ci: PrStatusChips["ci"] = null;
  const checks = pr?.checks;
  if (pr && checks && checks.total - (checks.skipped ?? 0) > 0) {
    const checksUrl = `${pr.url}/checks`;
    if (checks.failing > 0) {
      const firstFailing = pr.checkRuns?.find((run) => run.status === "failing");
      ci = {
        tone: "failing",
        label: `${checks.failing} failing`,
        url: firstFailing?.url || checksUrl,
      };
    } else if (checks.pending > 0) {
      ci = { tone: "pending", label: "CI", url: checksUrl };
    } else {
      ci = { tone: "passing", label: "CI", url: checksUrl };
    }
  }

  let diff: PrStatusChips["diff"] = null;
  if (diffStats && (diffStats.added > 0 || diffStats.removed > 0)) {
    diff = { additions: diffStats.added, deletions: diffStats.removed };
  } else if (pr && pr.additions != null && pr.deletions != null) {
    diff = { additions: pr.additions, deletions: pr.deletions };
  }

  return {
    pr: pr ? { number: pr.number, title: pr.title, draft: pr.isDraft === true } : null,
    ci,
    diff,
  };
}
