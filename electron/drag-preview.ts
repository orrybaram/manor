import { BrowserWindow } from "electron";

/**
 * Native drag-preview window (ADR-156).
 *
 * While a tab is dragged *inside* the app window, the renderer's DOM ghost
 * (`TabDragGhost`) provides the visual. DOM can never paint outside the OS
 * window, though — so once the pointer crosses the window edge we show this
 * instead: a transparent, frameless, click-through window that follows the
 * cursor, giving the tab-floating-over-the-desktop feedback users expect from
 * VS Code-style tear-off.
 *
 * It is deliberately non-focusable and ignores mouse events: stealing focus
 * would break the dragging window's pointer capture, which is what delivers the
 * final `pointerup` that decides whether to detach.
 */

const PREVIEW_WIDTH = 220;
const PREVIEW_HEIGHT = 40;

let previewWindow: BrowserWindow | null = null;

export interface DragPreviewTheme {
  bg: string;
  fg: string;
  border: string;
  accent: string;
}

const DEFAULT_THEME: DragPreviewTheme = {
  bg: "#2a2b3c",
  fg: "#cdd6f4",
  border: "#45475a",
  accent: "#89b4fa",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPreviewUrl(title: string, theme: DragPreviewTheme): string {
  // Inlined document — no preload, no app bundle, so the preview appears
  // instantly on the first frame of the drag rather than after a bundle load.
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    overflow: hidden;
    cursor: grabbing;
    -webkit-user-select: none;
  }
  .tab {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    margin: 4px;
    padding: 0 12px;
    border: 1px solid ${theme.border};
    border-radius: 8px;
    background: ${theme.bg};
    color: ${theme.fg};
    font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.38);
    opacity: 0.95;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${theme.accent};
    flex: none;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
<div class="tab"><span class="dot"></span><span class="title">${escapeHtml(title)}</span></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Show (or re-target) the preview at the given screen-space top-left point. */
export function showDragPreview(
  title: string,
  x: number,
  y: number,
  theme?: Partial<DragPreviewTheme>,
): void {
  const resolved = { ...DEFAULT_THEME, ...(theme ?? {}) };

  if (!previewWindow || previewWindow.isDestroyed()) {
    previewWindow = new BrowserWindow({
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      x: Math.round(x),
      y: Math.round(y),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Must not take focus: doing so would break the dragging window's pointer
      // capture, and with it the pointerup that completes the drag.
      focusable: false,
      alwaysOnTop: true,
      acceptFirstMouse: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Float above full-screen apps and other always-on-top windows.
    previewWindow.setAlwaysOnTop(true, "screen-saver");
    previewWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
    // Fully click-through so the pointer keeps reaching the app underneath.
    previewWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  void previewWindow.loadURL(buildPreviewUrl(title, resolved));
  previewWindow.setPosition(Math.round(x), Math.round(y));
  if (!previewWindow.isVisible()) {
    // showInactive, not show: never steal activation from the dragging window.
    previewWindow.showInactive();
  }
}

/** Move the preview. Cheap enough to call on every pointermove. */
export function moveDragPreview(x: number, y: number): void {
  if (!previewWindow || previewWindow.isDestroyed()) return;
  previewWindow.setPosition(Math.round(x), Math.round(y));
}

/** Hide and dispose the preview. Safe to call when nothing is showing. */
export function hideDragPreview(): void {
  if (!previewWindow || previewWindow.isDestroyed()) {
    previewWindow = null;
    return;
  }
  previewWindow.destroy();
  previewWindow = null;
}

/** Size of the preview, so the renderer can center it under the cursor. */
export const DRAG_PREVIEW_SIZE = {
  width: PREVIEW_WIDTH,
  height: PREVIEW_HEIGHT,
};
