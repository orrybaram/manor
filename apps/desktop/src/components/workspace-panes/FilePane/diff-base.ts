/**
 * The old side of a file's diff, rebuilt from the working copy and the
 * file's hunks, so the editor can show the diff without asking the host for
 * the old file (older host servers have no way to).
 */

/** One line of a hunk: kept (` `), removed (`-`) or added (`+`), without its newline. */
type HunkLine = { op: " " | "-" | "+"; text: string };

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
  /** A `\ No newline at end of file` followed the old side's last line. */
  oldNoEol: boolean;
  /** The same, for the new side. */
  newNoEol: boolean;
};

/** One file's section of a raw `git diff`, as far as rebuilding its old side needs. */
export type FileDiff = {
  path: string;
  /** New since the base: its old side is empty. */
  added: boolean;
  /** Gone from the working tree: its old side is all there is. */
  deleted: boolean;
  /** `Binary files … differ`: no lines to show. */
  binary: boolean;
  hunks: Hunk[];
};

const FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * `path`'s section of `raw` (a workspace's `git diff`, untracked files
 * included as new-file diffs), or null when the diff does not name it.
 */
export function fileDiffIn(raw: string | null, path: string): FileDiff | null {
  if (!raw) return null;
  const lines = raw.split("\n");
  let i = lines.findIndex((line) => FILE_HEADER.exec(line)?.[1] === path);
  if (i < 0) return null;
  const file: FileDiff = { path, added: false, deleted: false, binary: false, hunks: [] };
  // The header, up to the first hunk.
  for (i++; i < lines.length && !lines[i].startsWith("@@"); i++) {
    const line = lines[i];
    if (line.startsWith("diff --git")) return file;
    if (line.startsWith("new file mode") || line === "--- /dev/null") file.added = true;
    if (line.startsWith("deleted file mode") || line === "+++ /dev/null") file.deleted = true;
    if (line.startsWith("Binary files")) file.binary = true;
  }
  // Each hunk is read by its counts, so a removed line that looks like a
  // header (`--- x`) or an empty line can't end it early.
  while (i < lines.length) {
    const head = HUNK_HEADER.exec(lines[i]);
    if (!head) break;
    const hunk: Hunk = {
      oldStart: Number(head[1]),
      oldCount: head[2] === undefined ? 1 : Number(head[2]),
      newStart: Number(head[3]),
      newCount: head[4] === undefined ? 1 : Number(head[4]),
      lines: [],
      oldNoEol: false,
      newNoEol: false,
    };
    let oldLeft = hunk.oldCount;
    let newLeft = hunk.newCount;
    i++;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\"))) {
      const line = lines[i++];
      if (line.startsWith("\\")) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last?.op !== "+") hunk.oldNoEol = true;
        if (last?.op !== "-") hunk.newNoEol = true;
        continue;
      }
      const op = line[0] === "-" || line[0] === "+" ? line[0] : " ";
      hunk.lines.push({ op, text: line.slice(1) });
      if (op !== "+") oldLeft--;
      if (op !== "-") newLeft--;
    }
    file.hunks.push(hunk);
  }
  return file;
}

/** `text`'s lines (each keeping a `\r` of its CRLF) and whether it ends in a newline. */
function splitLines(text: string): { lines: string[]; eol: boolean } {
  if (text === "") return { lines: [], eol: true };
  const lines = text.split("\n");
  const eol = lines[lines.length - 1] === "";
  if (eol) lines.pop();
  return { lines, eol };
}

/**
 * The file as it was on the diff's old side, rebuilt by undoing `diff`'s
 * hunks on `working` (the file on disk now, as read). Null when the hunks
 * don't fit `working`: the file has moved on since the diff was read, and
 * guessing would show a wrong diff. A file the diff does not name (null) is
 * unchanged; a new file's old side is empty.
 */
export function baseFromDiff(working: string, diff: FileDiff | null): string | null {
  if (!diff || diff.hunks.length === 0) return diff?.added ? "" : working;
  if (diff.added) return "";
  const { lines: now, eol: nowEol } = splitLines(working);
  const out: string[] = [];
  let pos = 0;
  let last: Hunk | null = null;
  for (const hunk of diff.hunks) {
    // A side with no lines names the line before where it would be.
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (at < pos || at > now.length) return null;
    for (; pos < at; pos++) out.push(now[pos]);
    if (out.length !== (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1)) return null;
    for (const { op, text } of hunk.lines) {
      if (op !== "-") {
        if (now[pos] !== text) return null;
        pos++;
      }
      if (op !== "+") out.push(text);
    }
    last = hunk;
  }
  let oldEol = nowEol;
  if (pos === now.length && last) {
    // The last hunk reaches the end: it says how each side ends.
    if (now.length > 0 && last.newNoEol === nowEol) return null;
    oldEol = !last.oldNoEol;
  } else {
    for (; pos < now.length; pos++) out.push(now[pos]);
  }
  return out.length === 0 ? "" : out.join("\n") + (oldEol ? "\n" : "");
}

/** The old side the editor shows, held across a working copy that moved before the diff did. */
export type HeldBase = {
  diff: FileDiff | null | undefined;
  working: string;
  /** What to diff against; null shows the plain file. */
  base: string | null;
  /** The diff no longer fits the file and a fresher one is awaited. */
  stale: boolean;
};

/**
 * The next old side, for `diff` (undefined until the diff is first read)
 * and `working`. A save or an agent's write moves the working copy before
 * the next diff is read: while the diff itself is the one the last base was
 * built from, the old side has not moved, so that base stands. A diff that
 * doesn't fit says so (`stale`), keeping the last base on show, until one
 * that does arrives.
 */
export function followDiffBase(
  prev: HeldBase | null,
  diff: FileDiff | null | undefined,
  working: string,
): HeldBase {
  if (diff === undefined) return { diff, working, base: prev?.base ?? null, stale: false };
  const base = baseFromDiff(working, diff);
  if (base !== null) return { diff, working, base, stale: false };
  if (prev && prev.diff === diff && prev.base !== null && !prev.stale) {
    return { diff, working, base: prev.base, stale: false };
  }
  return { diff, working, base: prev?.base ?? null, stale: true };
}
