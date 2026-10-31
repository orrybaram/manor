import type { PrInfo } from "../../../lib/pr-info";
import type { DiffStats } from "../../../store/project-store";
import { branchesEqual } from "../../../utils/branch-name";

export type CiTone = "passing" | "failing" | "pending";

export type StatusLineModel = {
  /** The workspace's open (or draft) PR; null without one. */
  pr: PrInfo | null;
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
export function statusLineModel(input: {
  pr: PrInfo | null | undefined;
  diffStats: DiffStats | null | undefined;
}): StatusLineModel {
  const { diffStats } = input;
  const pr = input.pr?.state === "open" ? input.pr : null;

  let ci: StatusLineModel["ci"] = null;
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

  let diff: StatusLineModel["diff"] = null;
  if (diffStats && (diffStats.added > 0 || diffStats.removed > 0)) {
    diff = { additions: diffStats.added, deletions: diffStats.removed };
  } else if (pr && pr.additions != null && pr.deletions != null) {
    diff = { additions: pr.additions, deletions: pr.deletions };
  }

  return { pr, ci, diff };
}

/** A context size as the status line shows it: `8k`, `100k`, `420k`. */
export function formatContextTokens(n: number): string {
  if (n < 1000) return "<1k";
  return `${Math.round(n / 1000)}k`;
}

/** The status line's running-tasks chip: "2 running", or null with none. */
export function runningChipLabel(count: number): string | null {
  return count > 0 ? `${count} running` : null;
}

/**
 * A model id as people say it: `claude-opus-5-5` is "Opus 5.5",
 * `claude-haiku-4-5-20251001` "Haiku 4.5", `claude-3-5-sonnet-20241022`
 * "Sonnet 3.5". A date suffix and a context tag (`[1m]`) are dropped.
 * Anything else (another vendor's model) is shown as written.
 */
export function modelDisplayName(model: string): string {
  const id = model
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  const familyFirst = /^claude-([a-z]+)((?:-\d+)+)$/i.exec(id);
  const versionFirst = /^claude((?:-\d+)+)-([a-z]+)$/i.exec(id);
  const family = familyFirst?.[1] ?? versionFirst?.[2];
  const digits = familyFirst?.[2] ?? versionFirst?.[1];
  if (!family || !digits) return model;
  const version = digits.slice(1).split("-").join(".");
  return `${family[0].toUpperCase()}${family.slice(1).toLowerCase()} ${version}`;
}

/** A branch as the phone's chip shows it: the part after the last "/". */
export function shortBranchName(branch: string): string {
  const i = branch.lastIndexOf("/");
  return i === -1 || i === branch.length - 1 ? branch : branch.slice(i + 1);
}

export type BranchChip = {
  /** The workspace's live branch. */
  branch: string;
  /**
   * The branch the agent's transcript last named, when it differs from the
   * workspace's; null when they agree or the transcript names none.
   */
  agentBranch: string | null;
};

/**
 * The status line's branch chip: the workspace's live branch, flagged when
 * the transcript's newest line says the agent is on another. Null without a
 * workspace branch.
 */
export function branchChip(
  workspaceBranch: string | null | undefined,
  transcriptBranch: string | null | undefined,
): BranchChip | null {
  if (!workspaceBranch) return null;
  // Claude Code writes "HEAD" on a detached checkout, where Manor shows the
  // commit: that names no branch, so it can't disagree.
  const named = transcriptBranch && transcriptBranch !== "HEAD" ? transcriptBranch : null;
  const differs = !!named && !branchesEqual(named, workspaceBranch);
  return { branch: workspaceBranch, agentBranch: differs ? named : null };
}
