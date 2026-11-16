import type { FileSearchFile, FileSearchMatch } from "../../../electron.d";

/** One row of the Search view's list: a file's header, or one of its matching lines. */
export type SearchRow =
  | {
      kind: "file";
      key: string;
      path: string;
      name: string;
      /** The folder it is in, workspace-relative; "" at the root. */
      dir: string;
      count: number;
      collapsed: boolean;
    }
  | { kind: "match"; key: string; path: string; match: FileSearchMatch };

/** How many matches a file's badge counts: each range, and a line with none as one. */
export function matchCount(file: FileSearchFile): number {
  return file.matches.reduce((n, m) => n + Math.max(1, m.ranges.length), 0);
}

/** The rows shown for `files`, a collapsed file's matches left out. */
export function searchRows(files: FileSearchFile[], collapsed: ReadonlySet<string>): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const folded = collapsed.has(file.path);
    rows.push({
      kind: "file",
      key: `f\u0000${file.path}`,
      path: file.path,
      name: file.path.slice(slash + 1),
      dir: slash < 0 ? "" : file.path.slice(0, slash),
      count: matchCount(file),
      collapsed: folded,
    });
    if (folded) continue;
    for (const match of file.matches) {
      rows.push({
        kind: "match",
        key: `m\u0000${file.path}\u0000${match.line}\u0000${match.col}`,
        path: file.path,
        match,
      });
    }
  }
  return rows;
}

/** "6 results in 4 files". */
export function resultSummary(total: number, files: number): string {
  if (total === 0) return "No results";
  return `${total} result${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
}

/** A line's text cut at its match ranges, each piece marked whether it is a match. */
export function highlightSegments(
  text: string,
  ranges: [number, number][],
): { text: string; match: boolean }[] {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.min(s, text.length)), Math.max(0, Math.min(e, text.length))])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [s, e] of sorted) {
    // Overlapping ranges merge into the one before.
    const start = Math.max(s, at);
    if (e <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), match: false });
    out.push({ text: text.slice(start, e), match: true });
    at = e;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), match: false });
  return out;
}

/**
 * Where ↑/↓ take the cursor from `key` in `rows`: -1 above the first row (back
 * to the input), else the index of the row it lands on. With no cursor yet,
 * ↓ lands on the first match.
 */
export function stepSearchRow(rows: SearchRow[], key: string | null, step: 1 | -1): number {
  if (rows.length === 0) return -1;
  const at = key === null ? -1 : rows.findIndex((r) => r.key === key);
  if (at < 0) {
    if (step < 0) return -1;
    const first = rows.findIndex((r) => r.kind === "match");
    return first < 0 ? 0 : first;
  }
  const next = at + step;
  if (next < 0) return -1;
  return Math.min(next, rows.length - 1);
}
