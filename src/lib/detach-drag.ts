/**
 * Pure, stateless helpers for native-DnD tear-off (detach a tab or pane into
 * its own window). Shared by the tab bar and the pane drag handler so both
 * use identical geometry and an identical drag chip. No React, no store —
 * only DOM + plain types.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  bounds: Bounds;
}

/** True when a screen point is clearly outside `bounds` (with a small margin). */
export function isOutsideWindow(
  sx: number,
  sy: number,
  b: Bounds,
  margin = 8,
): boolean {
  return (
    sx < b.x - margin ||
    sx > b.x + b.width + margin ||
    sy < b.y - margin ||
    sy > b.y + b.height + margin
  );
}

/**
 * Topmost window whose bounds contain the point, or null. `windows` is
 * already ordered topmost-first.
 */
export function findWindowAtPoint(
  sx: number,
  sy: number,
  windows: WindowInfo[],
): WindowInfo | null {
  return (
    windows.find(
      (w) =>
        sx >= w.bounds.x &&
        sx <= w.bounds.x + w.bounds.width &&
        sy >= w.bounds.y &&
        sy <= w.bounds.y + w.bounds.height,
    ) ?? null
  );
}

/**
 * Spawn bounds for a torn-off window so the grabbed chip lands under the
 * cursor.
 */
export function spawnBoundsFor(
  sx: number,
  sy: number,
  grab: { x: number; y: number },
  size: { width: number; height: number } = { width: 900, height: 600 },
): Bounds {
  return {
    x: Math.round(sx - grab.x),
    y: Math.round(sy - grab.y),
    width: size.width,
    height: size.height,
  };
}

// Lucide `globe` / `git-compare-arrows`, inlined for the drag image (a raw DOM
// element, so it can't use the React icon components the tab/pane renders).
const GLOBE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
const DIFF_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><circle cx="19" cy="18" r="3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/></svg>`;

/**
 * Build the OS drag image element (styled as a tab/pane chip) handed to
 * `DataTransfer.setDragImage`. The caller appends it to the DOM briefly so
 * the OS can snapshot it, then removes it.
 */
export function buildDragImage(
  className: string,
  title: string,
  contentType: string | undefined,
  favicon: string | undefined,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  let iconHtml = "";
  if (contentType === "browser") {
    iconHtml = favicon
      ? `<img src="${favicon.replace(/"/g, "&quot;")}" width="12" height="12" />`
      : GLOBE_SVG;
  } else if (contentType === "diff") {
    iconHtml = DIFF_SVG;
  }
  const label = document.createElement("span");
  label.textContent = title;
  el.innerHTML = iconHtml;
  el.appendChild(label);
  return el;
}
