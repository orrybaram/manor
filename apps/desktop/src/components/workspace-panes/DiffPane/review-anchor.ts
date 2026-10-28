/**
 * Maps a DOM `Selection` inside `DiffLines` output to the diff data it
 * covers. `DiffPane`'s `onCopy` handler and the inline comment chip both need
 * "which lines does this selection span" — this is the one definition, so a
 * selected range always resolves to the same rows and text in either path.
 *
 * Two tiers, because the two callers want very different amounts of work.
 * `selectionRowRange` answers "is this commentable, and where does it start"
 * from the range's own endpoints, touching a constant number of elements —
 * that is the one the chip runs on every frame of a drag. `selectionToAnchor`
 * and `selectionSnippet` additionally read the covered rows' text, which
 * costs a pass over them, and are only called once the user has committed to
 * something (a copy, or a comment).
 */

const ROW = "[data-index]";

function rowIndex(row: HTMLElement): number {
  return Number(row.dataset.index);
}

/** A row's first child is the line-number cell, so this reads what the user sees. */
function rowLineNumber(row: Element): string {
  return row.children[0]?.textContent?.trim() ?? "";
}

/** `"<num>: <content>"`, or just the content when the row has no line number (hunk headers). */
function rowText(row: Element): string | null {
  const numCell = row.children[0];
  const contentCell = row.children[1];
  if (!contentCell) return null;
  const num = numCell?.textContent?.trim() ?? "";
  const content = contentCell.textContent ?? "";
  return num ? `${num}: ${content}` : content;
}

/**
 * The file the selection *started* in. Resolved from `sel.anchorNode` so a
 * selection spanning two files clamps to the one it began in rather than
 * picking whichever is first in document order. Climbing from the common
 * ancestor is the fallback for a selection whose anchor is not itself inside
 * a file (starting in the gap above the first row, say).
 */
function containerFor(sel: Selection): HTMLElement | null {
  const anchorNode = sel.anchorNode;
  const anchorEl =
    anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
  const fromAnchor = anchorEl?.closest<HTMLElement>("[data-diff-lines]");
  if (fromAnchor) return fromAnchor;

  const range = sel.getRangeAt(0);
  const ancestor =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  return (
    ancestor?.closest<HTMLElement>("[data-diff-lines]") ??
    ancestor?.querySelector<HTMLElement>("[data-diff-lines]") ??
    null
  );
}

/**
 * The row a range endpoint sits in, or `null` when that endpoint is outside
 * `container` — which is how a selection running past the end of its file is
 * detected.
 */
function rowAtBoundary(
  node: Node,
  offset: number,
  container: HTMLElement,
): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement;

  // An element boundary points *between* children rather than at one, so
  // descend to the child the offset names; without this a selection that ends
  // on the row list resolves to the list instead of to a row.
  if (node instanceof Element && node.childNodes.length > 0) {
    const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
    if (child instanceof Element) el = child;
  }

  const row = el?.closest<HTMLElement>(ROW) ?? null;
  return row && container.contains(row) ? row : null;
}

function edgeRow(container: HTMLElement, edge: "first" | "last") {
  const rows = container.querySelectorAll<HTMLElement>(ROW);
  return (edge === "first" ? rows[0] : rows[rows.length - 1]) ?? null;
}

/**
 * A file's rows as data, by index. `DiffLines` builds only the rows near the
 * screen, so a selection can span rows that are not in the document; their
 * text comes from here. Text matches `rowText` on a built row.
 */
export type RowSource = {
  count: number;
  /** `"<num>: <content>"` (or the content alone), as `rowText` reads it. */
  text: (index: number) => string | null;
  /** The line number the row shows, or `""` for a hunk header. */
  lineNumber: (index: number) => string;
};

const rowSources = new WeakMap<HTMLElement, RowSource>();

/** Register (or with `null`, forget) the rows behind a `[data-diff-lines]` list. */
export function setRowSource(
  container: HTMLElement,
  source: RowSource | null,
): void {
  if (source) rowSources.set(container, source);
  else rowSources.delete(container);
}

function rowTextAt(container: HTMLElement, index: number): string | null {
  const source = rowSources.get(container);
  if (source) return source.text(index);
  const row = container.querySelector(`[data-index="${index}"]`);
  return row ? rowText(row) : null;
}

function lineNumberAt(container: HTMLElement, index: number): string {
  const source = rowSources.get(container);
  if (source) return source.lineNumber(index);
  const row = container.querySelector(`[data-index="${index}"]`);
  return row ? rowLineNumber(row) : "";
}

type ResolvedRange = {
  container: HTMLElement;
  from: number;
  to: number;
};

/**
 * The first and last diff rows a selection covers, found from the range's own
 * endpoints rather than by testing every row in the file. The old scan was
 * O(rows) and ran on every `selectionchange` — which is once per frame for the
 * whole of a drag — so a long file made its own selection feel heavy.
 *
 * Indices, not elements: the rows between the endpoints may not be built.
 */
function resolveRange(sel: Selection): ResolvedRange | null {
  if (sel.isCollapsed || sel.rangeCount === 0) return null;

  const container = containerFor(sel);
  if (!container) return null;
  const source = rowSources.get(container);

  const range = sel.getRangeAt(0);
  // A `null` row means that endpoint left the file, so clamp to the file's
  // own edge instead of reaching into whatever came next.
  const startRow =
    rowAtBoundary(range.startContainer, range.startOffset, container) ??
    (source ? null : edgeRow(container, "first"));
  const endRow =
    rowAtBoundary(range.endContainer, range.endOffset, container) ??
    (source ? null : edgeRow(container, "last"));

  // A range that merely *touches* a row's edge does not cover it — which is
  // what `containsNode(row, true)` reports, and what the rest of this module
  // has always meant by "covered".
  let from: number;
  if (startRow)
    from = rowIndex(startRow) + (sel.containsNode(startRow, true) ? 0 : 1);
  else if (source) from = 0;
  else return null;

  let to: number;
  if (endRow) to = rowIndex(endRow) - (sel.containsNode(endRow, true) ? 0 : 1);
  else if (source) to = source.count - 1;
  else return null;

  if (from > to) return null;
  return { container, from, to };
}

function coveredText(resolved: ResolvedRange): string[] {
  const lines: string[] = [];
  for (let i = resolved.from; i <= resolved.to; i++) {
    const line = rowTextAt(resolved.container, i);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/** e.g. "L12" / "L12–L18" (en dash), matching the rendered line numbers. */
function labelFor(resolved: ResolvedRange): string {
  const firstNum = lineNumberAt(resolved.container, resolved.from);
  const lastNum = lineNumberAt(resolved.container, resolved.to);
  if (!firstNum && !lastNum) return "";
  return firstNum !== lastNum ? `L${firstNum}–L${lastNum}` : `L${firstNum}`;
}

/**
 * The built `[data-index]` rows of the nearest `[data-diff-lines]` container
 * that `sel` covers. Empty for a collapsed selection or one that touches no
 * rows.
 */
export function rowsInSelection(sel: Selection): HTMLElement[] {
  const resolved = resolveRange(sel);
  if (!resolved) return [];
  return Array.from(
    resolved.container.querySelectorAll<HTMLElement>(ROW),
  ).filter((row) => {
    const index = rowIndex(row);
    return index >= resolved.from && index <= resolved.to;
  });
}

/**
 * The selection's text, one `"<num>: <content>"` line per covered row —
 * matching what a paste of the copied diff looks like. Falls back to the raw
 * selection text when it covers no diff rows (e.g. a selection outside the
 * diff). `null` for a collapsed selection.
 */
export function selectionSnippet(sel: Selection): string | null {
  if (sel.isCollapsed) return null;
  const resolved = resolveRange(sel);
  const lines = resolved ? coveredText(resolved) : [];
  return lines.length > 0 ? lines.join("\n") : sel.toString();
}

/** Which rows a selection covers, and how to name them. No text is read. */
export interface SelectionRowRange {
  startIndex: number;
  endIndex: number;
  startLabel: string;
}

/**
 * The cheap half of `selectionToAnchor`: enough to decide whether to offer a
 * comment and what to call the range, without reading a single row's text.
 * This is what runs while the user is still dragging.
 */
export function selectionRowRange(sel: Selection): SelectionRowRange | null {
  const resolved = resolveRange(sel);
  if (!resolved) return null;
  return {
    startIndex: resolved.from,
    endIndex: resolved.to,
    startLabel: labelFor(resolved),
  };
}

export interface SelectionAnchor extends SelectionRowRange {
  snippet: string;
}

/**
 * Resolves a selection to the anchor a draft comment stores: which lines it
 * covers, a text snapshot, and a display label. `null` for a collapsed
 * selection or one that covers no diff rows.
 */
export function selectionToAnchor(sel: Selection): SelectionAnchor | null {
  const resolved = resolveRange(sel);
  if (!resolved) return null;

  const lines = coveredText(resolved);

  return {
    startIndex: resolved.from,
    endIndex: resolved.to,
    snippet: lines.length > 0 ? lines.join("\n") : sel.toString(),
    startLabel: labelFor(resolved),
  };
}
