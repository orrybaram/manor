import type { PrInfo } from "../../../lib/pr-info";

export type CiTone = "passing" | "failing" | "pending";

export type PrStatusChips = {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  /** Absent when GitHub reports no checks for the PR. */
  ci: { tone: CiTone; label: string; url: string } | null;
  /** Absent when the payload carries no diff stat. */
  diff: { additions: number; deletions: number; url: string } | null;
};

/**
 * What the chat's status line shows for the workspace's pull request: only an
 * open (or draft) one — a merged or closed PR has nothing left to act on from
 * the chat. CI links to the first failing run when there is one, so the chip
 * goes straight to what broke.
 */
export function prStatusChips(pr: PrInfo | null | undefined): PrStatusChips | null {
  if (!pr || pr.state !== "open") return null;

  let ci: PrStatusChips["ci"] = null;
  const checks = pr.checks;
  if (checks && checks.total - (checks.skipped ?? 0) > 0) {
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

  const diff =
    pr.additions != null && pr.deletions != null
      ? { additions: pr.additions, deletions: pr.deletions, url: `${pr.url}/files` }
      : null;

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    draft: pr.isDraft === true,
    ci,
    diff,
  };
}
