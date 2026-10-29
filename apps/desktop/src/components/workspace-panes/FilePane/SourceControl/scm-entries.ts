import { changeBadge, type FileChange } from "../file-changes";

/** Source Control's list: working changes vs. HEAD, or the branch vs. the project's default branch. */
export type ScmView = "local" | "branch";

/** The letter a row ends with: Untracked is a new file git does not know yet. */
export type ScmLetter = "M" | "A" | "R" | "D" | "U";

/** One changed file as a Source Control row lists it. */
export type ScmEntry = { change: FileChange; letter: ScmLetter };

/**
 * A row's letter. A new file in the Local view that is not staged is
 * untracked (`git diff HEAD` lists it only through Manor's own untracked
 * diff), so it reads U, as VS Code shows it; once staged, it is A.
 */
export function scmLetter(
  change: FileChange,
  staged: boolean,
  view: ScmView,
): ScmLetter {
  if (view === "local" && change.status === "added" && !staged) return "U";
  return changeBadge(change.status);
}

/**
 * The Local view's two groups. A file is Staged when `git diff --cached`
 * names it, as the diff pane decides it: a partly staged file is Staged,
 * and unstaging it unstages all of it. Each group is by path.
 *
 * A staged file the working diff doesn't list (staged, then reverted or
 * deleted on disk) still shows in Staged, so it can be unstaged. All that is
 * known of it is its path, so it reads M.
 */
export function localGroups(
  changes: Iterable<FileChange>,
  staged: ReadonlySet<string>,
): { staged: ScmEntry[]; changes: ScmEntry[] } {
  const out = { staged: [] as ScmEntry[], changes: [] as ScmEntry[] };
  const listed = new Set<string>();
  for (const change of changes) {
    listed.add(change.path);
    const isStaged = staged.has(change.path);
    (isStaged ? out.staged : out.changes).push({
      change,
      letter: scmLetter(change, isStaged, "local"),
    });
  }
  for (const path of staged) {
    if (listed.has(path)) continue;
    out.staged.push({
      change: { path, status: "modified", ranges: [] },
      letter: "M",
    });
  }
  out.staged.sort(byPath);
  out.changes.sort(byPath);
  return out;
}

/** The Branch view's one group, by path. */
export function branchEntries(changes: Iterable<FileChange>): ScmEntry[] {
  return sortedByPath(changes).map((change) => ({
    change,
    letter: scmLetter(change, false, "branch"),
  }));
}

/** `staged` with `files` staged (`on`) or unstaged: the optimistic answer to a click. */
export function withStaged(
  staged: ReadonlySet<string>,
  files: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(staged);
  for (const file of files) {
    if (on) next.add(file);
    else next.delete(file);
  }
  return next;
}

function sortedByPath(changes: Iterable<FileChange>): FileChange[] {
  return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}

function byPath(a: ScmEntry, b: ScmEntry): number {
  return a.change.path.localeCompare(b.change.path);
}
