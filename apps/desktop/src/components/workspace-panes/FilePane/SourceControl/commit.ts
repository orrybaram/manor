import { toast } from "../../../../toast";
import { ipcErrorMessage } from "../../../../lib/ipc-error";

/** The `git commit` flags the commit box offers, as the host allows them. */
export const COMMIT_OPTIONS = [
  { flag: "--amend", label: "Amend last commit" },
  { flag: "--no-verify", label: "Skip hooks (--no-verify)" },
  { flag: "--allow-empty", label: "Allow empty commit" },
] as const;

export type CommitFlag = (typeof COMMIT_OPTIONS)[number]["flag"];

/**
 * Why Commit can't run yet, or null when it can. Amend may reuse the last
 * message and needs nothing staged; Allow empty needs nothing staged.
 */
export function commitBlocker(
  message: string,
  stagedCount: number,
  flags: ReadonlySet<CommitFlag>,
): string | null {
  const amend = flags.has("--amend");
  if (stagedCount === 0 && !amend && !flags.has("--allow-empty"))
    return "Stage changes to commit";
  if (!message.trim() && !amend) return "Write a commit message";
  return null;
}

/**
 * Commit what's staged in the workspace at `workspacePath`, on whichever host
 * it lives, and toast how it went. True when it worked.
 */
export async function runCommit(
  workspacePath: string,
  message: string,
  flags: ReadonlySet<CommitFlag>,
): Promise<boolean> {
  const id = `commit-${workspacePath}`;
  try {
    await window.electronAPI.git.commit(
      workspacePath,
      message.trim(),
      Array.from(flags),
    );
    toast.success(flags.has("--amend") ? "Amended last commit" : "Committed", {
      id,
    });
    return true;
  } catch (err) {
    toast.error("Commit failed", { id, detail: ipcErrorMessage(err) });
    return false;
  }
}
