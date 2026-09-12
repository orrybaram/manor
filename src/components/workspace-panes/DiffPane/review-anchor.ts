/**
 * Maps a DOM `Selection` inside `DiffLines` output to the diff data it
 * covers. `DiffPane`'s `onCopy` handler and the inline comment chip both need
 * "which lines does this selection span" — this is the one definition, so a
 * selected range always resolves to the same rows and text in either path.
 */

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
 * The `[data-index]` rows of the nearest `[data-diff-lines]` container that
 * `sel` covers. Resolved from `sel.anchorNode` first — the node the selection
 * *started* in — so a selection spanning two files clamps to the file it
 * started in rather than picking whichever file happens to be first in
 * document order. Falls back to climbing from the selection's common
 * ancestor (and, from there, a descendant search) only when the anchor node
 * itself yields nothing. Empty for a collapsed selection or one that touches
 * no rows.
 */
export function rowsInSelection(sel: Selection): HTMLElement[] {
  if (sel.isCollapsed || sel.rangeCount === 0) return [];

  const anchorNode = sel.anchorNode;
  const anchorEl =
    anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
  let container = anchorEl?.closest("[data-diff-lines]") ?? null;

  if (!container) {
    const range = sel.getRangeAt(0);
    const ancestor =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    container =
      ancestor?.closest("[data-diff-lines]") ??
      ancestor?.querySelector("[data-diff-lines]") ??
      null;
  }
  if (!container) return [];

  const rows: HTMLElement[] = [];
  for (const row of container.querySelectorAll("[data-index]")) {
    if (row instanceof HTMLElement && sel.containsNode(row, true)) {
      rows.push(row);
    }
  }
  return rows;
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

export interface SelectionAnchor {
  /** Inclusive index range into `DiffFile.lines`, from the covered rows' `data-index`. */
  startIndex: number;
  endIndex: number;
  snippet: string;
  /** e.g. "L12" / "L12–L18" (en dash), matching the rendered line numbers. */
  startLabel: string;
}

/**
 * Resolves a selection to the anchor a draft comment stores: which lines it
 * covers, a text snapshot, and a display label. `null` for a collapsed
 * selection or one that covers no diff rows.
 */
export function selectionToAnchor(sel: Selection): SelectionAnchor | null {
  if (sel.isCollapsed) return null;

  const rows = rowsInSelection(sel);
  if (rows.length === 0) return null;

  const snippet = selectionSnippet(sel);
  if (snippet === null) return null;

  const first = rows[0];
  const last = rows[rows.length - 1];
  const startIndex = Number(first.dataset.index);
  const endIndex = Number(last.dataset.index);

  const firstNum = rowLineNumber(first);
  const lastNum = rowLineNumber(last);
  const startLabel =
    !firstNum && !lastNum
      ? ""
      : firstNum !== lastNum
        ? `L${firstNum}–L${lastNum}`
        : `L${firstNum}`;

  return { startIndex, endIndex, snippet, startLabel };
}
