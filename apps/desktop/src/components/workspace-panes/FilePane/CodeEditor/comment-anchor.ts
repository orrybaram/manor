import { diff, getChunks, getOriginalDoc } from "@codemirror/merge";
import { ChangeSet, type ChangeDesc, type EditorState, type Text } from "@codemirror/state";

/** The working copy's lines a comment covers: 1-based, inclusive. */
export type LineSpan = { startLine: number; endLine: number };

/**
 * Where a comment sits in the open document: `from` is its first line's
 * start and `to` its last line's end, so edits inside the lines keep them,
 * and edits above or below move them.
 */
export type Anchor = { from: number; to: number };

/** e.g. "L12" / "L12–L18" (en dash), as the Diff pane labels a range. */
export function lineLabel({ startLine, endLine }: LineSpan): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine}`;
}

/**
 * The lines a selection from `from` to `to` covers. One that ends at a line's
 * very start (a drag down to the next line's gutter) doesn't take that line.
 */
export function selectedLines(doc: Text, from: number, to: number): LineSpan {
  const start = doc.lineAt(from);
  let end = doc.lineAt(to);
  if (to > from && to === end.from && end.number > start.number) end = doc.line(end.number - 1);
  return { startLine: start.number, endLine: end.number };
}

/** `span`'s place in `doc`, its lines clamped to the ones `doc` has. */
export function anchorFor(doc: Text, { startLine, endLine }: LineSpan): Anchor {
  const clamp = (n: number) => Math.min(Math.max(Math.round(n), 1), doc.lines);
  const first = doc.line(clamp(startLine));
  const last = doc.line(Math.max(clamp(endLine), first.number));
  return { from: first.from, to: last.to };
}

/** The lines `anchor` is on in `doc`. */
export function spanOf(doc: Text, anchor: Anchor): LineSpan {
  return {
    startLine: doc.lineAt(Math.min(anchor.from, doc.length)).number,
    endLine: doc.lineAt(Math.min(anchor.to, doc.length)).number,
  };
}

/**
 * `anchor` after `changes`. Typing in its lines grows them (text typed at
 * its last line's end too: it is drawn under the whole line, `cardPos`), a
 * line inserted above pushes it down, and deleting its lines leaves it on
 * the line that took their place.
 */
export function mapAnchor(anchor: Anchor, changes: ChangeDesc): Anchor {
  const from = changes.mapPos(anchor.from, 1);
  const to = changes.mapPos(anchor.to, -1);
  return { from: Math.min(from, to), to };
}

/** Where a comment's card hangs: under the whole of its last line. */
export function cardPos(doc: Text, anchor: Anchor): number {
  return doc.lineAt(Math.min(anchor.to, doc.length)).to;
}

/**
 * The changes to map comments through for `changes`, which took `before` to
 * `after`. A wholesale replacement (the file reloaded from disk) would put
 * every comment at the top, so it is mapped as the smallest edit between
 * the two instead, and each comment follows its own text.
 */
export function changesToMap(changes: ChangeSet, before: Text, after: Text): ChangeDesc {
  if (!replacesAll(changes, before.length)) return changes;
  const a = before.toString();
  const b = after.toString();
  const minimal = diff(a, b, { scanLimit: 500, timeout: 200 }).map((c) => ({
    from: c.fromA,
    to: c.toA,
    insert: b.slice(c.fromB, c.toB),
  }));
  return ChangeSet.of(minimal, a.length).desc;
}

function replacesAll(changes: ChangeDesc, length: number): boolean {
  if (length === 0) return false;
  let whole = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === length) whole = true;
  });
  return whole;
}

/** The lines a chunk's side covers, from its start to the end of its range. */
function chunkLines(doc: Text, from: number, to: number): [number, number] | null {
  if (to <= from) return null;
  return [doc.lineAt(from).number, doc.lineAt(Math.min(to, doc.length + 1) - 1).number];
}

/**
 * The text a comment on `from`..`to` quotes to the agent, row for row as the
 * Diff pane's snippet reads (`DiffLines`' row source): `"<num>: <prefix><content>"`,
 * the prefix `+` for an added line, a space for an unchanged one, both
 * numbered in the working copy, and `-` for a removed one, numbered in the
 * old side. Removed lines the selection takes in (the diff shows them above
 * the line that replaced them) are quoted too, so a comment on a deletion
 * still says what was deleted.
 */
export function snippetFor(state: EditorState, from: number, to: number): string {
  const doc = state.doc;
  const span = selectedLines(doc, from, to);
  const chunks = getChunks(state)?.chunks ?? [];
  const added = new Set<number>();
  for (const chunk of chunks) {
    const lines = chunkLines(doc, chunk.fromB, chunk.toB);
    if (lines) for (let n = lines[0]; n <= lines[1]; n++) added.add(n);
  }
  const rows: { pos: number; order: number; text: string }[] = [];
  for (let n = span.startLine; n <= span.endLine; n++) {
    const line = doc.line(n);
    rows.push({ pos: line.from, order: 1, text: `${n}: ${added.has(n) ? "+" : " "}${line.text}` });
  }
  if (chunks.length > 0) {
    const original = getOriginalDoc(state);
    const startsAtLine = from === doc.line(span.startLine).from;
    for (const chunk of chunks) {
      const removed = chunkLines(original, chunk.fromA, chunk.toA);
      const inside = (startsAtLine ? chunk.fromB >= from : chunk.fromB > from) && chunk.fromB <= to;
      if (!removed || !inside) continue;
      for (let n = removed[0]; n <= removed[1]; n++) {
        rows.push({ pos: chunk.fromB, order: 0, text: `${n}: -${original.line(n).text}` });
      }
    }
  }
  rows.sort((a, b) => a.pos - b.pos || a.order - b.order);
  return rows.map((r) => r.text).join("\n");
}
