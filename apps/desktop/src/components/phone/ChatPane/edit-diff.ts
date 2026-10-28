/**
 * What an edit card shows, kept as pure functions: the file's name and
 * folder, the five-block add/remove bar, and the hunk lines as drawn.
 */

import type { ChatDiffHunk } from "../../../electron.d";

/** How many blocks the ratio bar has. */
const BLOCKS = 5;
/** A folder deeper than this keeps only its last segments. */
const MAX_FOLDER_SEGMENTS = 4;

/**
 * The file name and the folder it sits in. A home directory shows as `~`,
 * and a deep folder keeps its last few segments behind `…/`.
 */
export function editPathParts(path: string): { name: string; folder: string } {
  const home = path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
  const cut = home.lastIndexOf("/");
  if (cut === -1) return { name: home, folder: "" };
  const name = home.slice(cut + 1);
  const folder = cut === 0 ? "/" : home.slice(0, cut);
  const segments = folder.split("/").filter(Boolean);
  if (segments.length <= MAX_FOLDER_SEGMENTS) return { name, folder };
  return { name, folder: `…/${segments.slice(-MAX_FOLDER_SEGMENTS).join("/")}` };
}

export type RatioBlock = "add" | "del" | "none";

/**
 * The five blocks of the add/remove bar, added first. Each side that changed
 * gets at least one block; nothing changed leaves all five grey.
 */
export function ratioBlocks(added: number, removed: number): RatioBlock[] {
  const total = added + removed;
  if (total <= 0) return Array<RatioBlock>(BLOCKS).fill("none");
  let adds = Math.round((BLOCKS * added) / total);
  if (added > 0 && adds === 0) adds = 1;
  if (removed > 0 && adds === BLOCKS) adds = BLOCKS - 1;
  return Array.from({ length: BLOCKS }, (_, i) => (i < adds ? "add" : "del"));
}

export type DiffLineKind = "add" | "del" | "context" | "meta";

export type DiffLine = { kind: DiffLineKind; sign: string; text: string };

/** A hunk's header, as unified diffs write it: `@@ -10,4 +10,5 @@`. */
export function hunkHeader(h: ChatDiffHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

/**
 * A hunk's lines as drawn: the sign split off, and the indent the lines
 * share removed so a narrow screen isn't spent on leading spaces.
 */
export function diffLines(h: ChatDiffHunk): DiffLine[] {
  const lines = h.lines.map((raw): DiffLine => {
    const sign = raw.charAt(0);
    const text = raw.slice(1);
    if (sign === "+") return { kind: "add", sign: "+", text };
    if (sign === "-") return { kind: "del", sign: "−", text };
    if (sign === "\\") return { kind: "meta", sign: "", text: raw };
    return { kind: "context", sign: " ", text: sign === " " ? text : raw };
  });
  let indent = Infinity;
  for (const l of lines) {
    if (l.kind === "meta" || !l.text.trim()) continue;
    indent = Math.min(indent, l.text.length - l.text.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((l) => (l.kind === "meta" ? l : { ...l, text: l.text.slice(indent) }));
}
