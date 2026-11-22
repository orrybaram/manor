import { toast } from "../../../../toast";
import { ipcErrorMessage } from "../../../../lib/ipc-error";

/** What a click on a changed file can ask git to do to it. */
export type GitFileAction = "stage" | "unstage" | "discard";

const fileLabel = (count: number) =>
  count === 1 ? "1 file" : `${count} files`;

const COPY: Record<
  GitFileAction,
  { done: (n: number) => string; failed: string }
> = {
  stage: {
    done: (n) => `Staged ${fileLabel(n)}`,
    failed: "Failed to stage files",
  },
  unstage: {
    done: (n) => `Unstaged ${fileLabel(n)}`,
    failed: "Failed to unstage files",
  },
  discard: {
    done: (n) => `Discarded changes in ${fileLabel(n)}`,
    failed: "Failed to discard changes",
  },
};

/**
 * Run `action` on `files` of the workspace at `workspacePath`, on whichever
 * host it lives (the bridge routes by path), and toast how it went. True
 * when it worked, so a caller can roll back its optimistic update otherwise.
 *
 * Discard takes the untracked files apart: the host restores tracked files
 * with one `git checkout HEAD -- …`, which refuses the whole list when one of
 * them is unknown to git, so a mixed list would restore nothing.
 */
export async function runGitFileAction(
  action: GitFileAction,
  workspacePath: string,
  files: string[],
  untracked: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const id = `${action}-${Date.now()}`;
  const batches =
    action === "discard"
      ? [
          files.filter((f) => !untracked.has(f)),
          files.filter((f) => untracked.has(f)),
        ].filter((batch) => batch.length > 0)
      : [files];
  try {
    for (const batch of batches) {
      await window.electronAPI.git[action](workspacePath, batch);
    }
    toast.success(COPY[action].done(files.length), { id });
    return true;
  } catch (err) {
    toast.error(COPY[action].failed, { id, detail: ipcErrorMessage(err) });
    return false;
  }
}
