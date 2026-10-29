import { getChunks, getOriginalDoc } from "@codemirror/merge";
import type { ChangeDesc, EditorState, Text } from "@codemirror/state";

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
 * `anchor` after `changes`, read against the documents before (`before`) and
 * after (`after`) them. Typing in its lines grows them, a line inserted
 * above pushes it down, and deleting its lines leaves it on the line that
 * took their place. A wholesale replacement (the file reloaded from disk)
 * would put every comment at the top, so it keeps each on its line number.
 */
export function mapAnchor(anchor: Anchor, changes: ChangeDesc, before: Text, after: Text): Anchor {
  if (replacesAll(changes, before.length)) return anchorFor(after, spanOf(before, anchor));
  const from = changes.mapPos(anchor.from, 1);
  const to = changes.mapPos(anchor.to, -1);
  return { from: Math.min(from, to), to };
}

function replacesAll(changes: ChangeDesc, length: number): boolean {
  if (length === 0) return false;
  let whole = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === length) whole = true;
  });
  return whole;
}

/**
 * The text a comment on `from`..`to` quotes to the agent, one
 * `"<num>: <content>"` line per working-copy line, as the Diff pane's
 * snippet reads. Removed lines the selection takes in (the diff shows them
 * above the line that replaced them) come in as `"-<old num>: <content>"`,
 * so a comment on a deletion still says what was deleted.
 */
export function snippetFor(state: EditorState, from: number, to: number): string {
  const doc = state.doc;
  const span = selectedLines(doc, from, to);
  const rows: { pos: number; order: number; text: string }[] = [];
  for (let n = span.startLine; n <= span.endLine; n++) {
    const line = doc.line(n);
    rows.push({ pos: line.from, order: 1, text: `${n}: ${line.text}` });
  }
  const chunks = getChunks(state)?.chunks ?? [];
  if (chunks.length > 0) {
    const original = getOriginalDoc(state);
    const startsAtLine = from === doc.line(span.startLine).from;
    for (const chunk of chunks) {
      const deletes = chunk.toA > chunk.fromA;
      const inside = (startsAtLine ? chunk.fromB >= from : chunk.fromB > from) && chunk.fromB <= to;
      if (!deletes || !inside) continue;
      const first = original.lineAt(chunk.fromA).number;
      const last = original.lineAt(Math.min(chunk.toA, original.length + 1) - 1).number;
      for (let n = first; n <= last; n++) {
        rows.push({ pos: chunk.fromB, order: 0, text: `-${n}: ${original.line(n).text}` });
      }
    }
  }
  rows.sort((a, b) => a.pos - b.pos || a.order - b.order);
  return rows.map((r) => r.text).join("\n");
}
