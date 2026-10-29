import { parseDiff } from "../DiffPane/parser";
import type { DiffLine } from "../DiffPane/types";

/** How a file differs from the base the diff pane shows by default (HEAD). */
export type ChangeStatus = "added" | "modified" | "renamed" | "deleted";

/** Lines `from` to `to` of the file as it is now, 1-based and inclusive. */
export type LineRange = { from: number; to: number };

/** One changed file of a workspace, by workspace-relative path. */
export type FileChange = {
  path: string;
  status: ChangeStatus;
  /**
   * The lines that differ from the base, one range per run of them: what
   * the gutter marks and the header jumps between. A deletion marks the line
   * after it (or before it, at the end of the file).
   */
  ranges: LineRange[];
};

/** The letter a changed file shows beside its name. */
export function changeBadge(status: ChangeStatus): "A" | "M" | "R" | "D" {
  switch (status) {
    case "added":
      return "A";
    case "renamed":
      return "R";
    case "deleted":
      return "D";
    default:
      return "M";
  }
}

/**
 * The runs of changed lines in one file's diff lines (as `parseDiff` reads
 * them), in the file's new line numbers.
 */
export function changedLineRanges(lines: readonly DiffLine[]): LineRange[] {
  const marked: number[] = [];
  /** The new-file line last seen, for a deletion at the end of a hunk. */
  let lastNew = 0;
  let deletion = false;
  /** The last line that was not a deletion added one: a deletion after it is part of that run. */
  let afterAdd = false;
  const markDeletion = (line: number) => {
    if (!deletion) return;
    marked.push(Math.max(1, line));
    deletion = false;
  };
  for (const line of lines) {
    switch (line.type) {
      case "hunk":
        markDeletion(lastNew);
        afterAdd = false;
        break;
      case "del":
        if (!afterAdd) deletion = true;
        break;
      case "add":
        if (line.newNum === undefined) break;
        // The added lines replace what was deleted; they carry the mark.
        deletion = false;
        afterAdd = true;
        marked.push(line.newNum);
        lastNew = line.newNum;
        break;
      case "context":
        if (line.newNum === undefined) break;
        markDeletion(line.newNum);
        afterAdd = false;
        lastNew = line.newNum;
        break;
    }
  }
  markDeletion(lastNew);
  return toRanges(marked);
}

/** Sorted, merged runs of the line numbers in `lines`. */
function toRanges(lines: number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.to + 1) last.to = n;
    else ranges.push({ from: n, to: n });
  }
  return ranges;
}

/**
 * A workspace's changed files from its raw `git diff` (with untracked files
 * as new-file diffs, as `diffs.getLocalDiff` returns it), by path.
 */
export function fileChangesFromDiff(raw: string | null): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  if (!raw) return out;
  const { added, renamed } = headerMarks(raw);
  // The diff's last newline would read as one more, empty, context line.
  for (const file of parseDiff(raw.replace(/\n$/, ""))) {
    const status: ChangeStatus = file.deleted
      ? "deleted"
      : added.has(file.path)
        ? "added"
        : renamed.has(file.path)
          ? "renamed"
          : "modified";
    out.set(file.path, {
      path: file.path,
      status,
      ranges: status === "deleted" ? [] : changedLineRanges(file.lines),
    });
  }
  return out;
}

/** The files a diff's headers say are new, or renamed, which `parseDiff` does not keep. */
function headerMarks(raw: string): { added: Set<string>; renamed: Set<string> } {
  const added = new Set<string>();
  const renamed = new Set<string>();
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      current = line.match(/^diff --git a\/.+ b\/(.+)$/)?.[1] ?? null;
    } else if (current !== null && line.startsWith("new file mode")) {
      added.add(current);
    } else if (current !== null && line.startsWith("rename to ")) {
      renamed.add(current);
    } else if (line.startsWith("@@")) {
      current = null;
    }
  }
  return { added, renamed };
}

/** Every folder that holds one of `paths`, however deep: the folders the tree dots. */
export function foldersWithChanges(paths: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const folder = path.slice(0, slash);
      if (folders.has(folder)) break;
      folders.add(folder);
      slash = folder.lastIndexOf("/");
    }
  }
  return folders;
}

/**
 * The edit to show after `current` going `direction` through `count` edits,
 * wrapping at either end. With none shown yet, down starts at the first and
 * up at the last. Null when there are none.
 */
export function stepEdit(count: number, current: number | null, direction: 1 | -1): number | null {
  if (count <= 0) return null;
  if (current === null || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
