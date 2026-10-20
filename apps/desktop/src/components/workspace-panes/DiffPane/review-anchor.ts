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

function stepRow(row: HTMLElement, direction: 1 | -1): HTMLElement | null {
  let cur =
    direction === 1 ? row.nextElementSibling : row.previousElementSibling;
  while (cur) {
    if (cur instanceof HTMLElement && cur.hasAttribute("data-index"))
      return cur;
    cur = direction === 1 ? cur.nextElementSibling : cur.previousElementSibling;
  }
  return null;
}

function edgeRow(container: HTMLElement, edge: "first" | "last") {
  const rows = container.querySelectorAll<HTMLElement>(ROW);
  return (edge === "first" ? rows[0] : rows[rows.length - 1]) ?? null;
}

type ResolvedRange = {
  container: HTMLElement;
  first: HTMLElement;
  last: HTMLElement;
};

/**
 * The first and last diff rows a selection covers, found from the range's own
 * endpoints rather than by testing every row in the file. The old scan was
 * O(rows) and ran on every `selectionchange` — which is once per frame for the
 * whole of a drag — so a long file made its own selection feel heavy.
 */
function resolveRange(sel: Selection): ResolvedRange | null {
  if (sel.isCollapsed || sel.rangeCount === 0) return null;

  const container = containerFor(sel);
  if (!container) return null;

  const range = sel.getRangeAt(0);
  // A `null` here means that endpoint left the file, so clamp to the file's
  // own edge instead of reaching into whatever came next.
  let first: HTMLElement | null =
    rowAtBoundary(range.startContainer, range.startOffset, container) ??
    edgeRow(container, "first");
  let last: HTMLElement | null =
    rowAtBoundary(range.endContainer, range.endOffset, container) ??
    edgeRow(container, "last");
  if (!first || !last) return null;

  // A range that merely *touches* a row's edge does not cover it — which is
  // what `containsNode(row, true)` reports, and what the rest of this module
  // has always meant by "covered". Two checks replace the old full scan.
  if (!sel.containsNode(first, true)) first = stepRow(first, 1);
  if (last && !sel.containsNode(last, true)) last = stepRow(last, -1);
  if (!first || !last) return null;

  if (rowIndex(first) > rowIndex(last)) return null;
  return { container, first, last };
}

function coveredRows(resolved: ResolvedRange): HTMLElement[] {
  const from = rowIndex(resolved.first);
  const to = rowIndex(resolved.last);
  const rows: HTMLElement[] = [];
  for (const row of resolved.container.querySelectorAll<HTMLElement>(ROW)) {
    const index = rowIndex(row);
    if (index >= from && index <= to) rows.push(row);
  }
  return rows;
}

/** e.g. "L12" / "L12–L18" (en dash), matching the rendered line numbers. */
function labelFor(first: HTMLElement, last: HTMLElement): string {
  const firstNum = rowLineNumber(first);
  const lastNum = rowLineNumber(last);
  if (!firstNum && !lastNum) return "";
  return firstNum !== lastNum ? `L${firstNum}–L${lastNum}` : `L${firstNum}`;
}

/**
 * The `[data-index]` rows of the nearest `[data-diff-lines]` container that
 * `sel` covers. Empty for a collapsed selection or one that touches no rows.
 */
export function rowsInSelection(sel: Selection): HTMLElement[] {
  const resolved = resolveRange(sel);
  return resolved ? coveredRows(resolved) : [];
}

/**
 * The selection's text, one `"<num>: <content>"` line per covered row —
 * matching what a paste of the copied diff looks like. Falls back to the raw
 * selection text when it covers no diff rows (e.g. a selection outside the
 * diff). `null` for a collapsed selection.
 */
export function selectionSnippet(sel: Selection): string | null {
  if (sel.isCollapsed) return null;

  const lines = rowsInSelection(sel)
    .map(rowText)
    .filter((line): line is string => line !== null);
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
    startIndex: rowIndex(resolved.first),
    endIndex: rowIndex(resolved.last),
    startLabel: labelFor(resolved.first, resolved.last),
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

  const lines = coveredRows(resolved)
    .map(rowText)
    .filter((line): line is string => line !== null);

  return {
    startIndex: rowIndex(resolved.first),
    endIndex: rowIndex(resolved.last),
    snippet: lines.length > 0 ? lines.join("\n") : sel.toString(),
    startLabel: labelFor(resolved.first, resolved.last),
  };
}
