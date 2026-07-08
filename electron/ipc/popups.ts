import { BrowserWindow, shell } from "electron";

// Default size for a communicating popup when the guest does not request one
// (or requests something unreasonable). OAuth/SSO consent screens are usually
// portrait-ish and modest in size.
const DEFAULT_POPUP_WIDTH = 600;
const DEFAULT_POPUP_HEIGHT = 700;
// Clamp requested sizes so a guest can't open a 1px or a screen-swallowing
// window. These are best-effort, per the ADR ("manor may normalize them").
const MIN_POPUP_DIMENSION = 200;
const MAX_POPUP_DIMENSION = 2000;

// Child windows opened from a guest <webview>, keyed by the originating paneId.
// A single pane can spawn more than one popup (e.g. re-opening a closed OAuth
// window), so each pane maps to a set of live child windows.
const childWindowsByPane = new Map<string, Set<BrowserWindow>>();

function clampDimension(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), MIN_POPUP_DIMENSION), MAX_POPUP_DIMENSION);
}

/**
 * Build the `overrideBrowserWindowOptions` for a communicating popup child
 * window. Parented to the main window so it closes with it, sized from the
 * guest's requested `features` (clamped/normalized), and locked to secure
 * webPreferences matching the main window (contextIsolation on, nodeIntegration
 * off, sandbox on). `width`/`height` are parsed by Electron from the `features`
 * string into the merged options it passes to `did-create-window`; we normalize
 * them here and let our explicit options take precedence.
 */
export function buildPopupWindowOptions(
  mainWindow: BrowserWindow | null,
  features: string,
): Electron.BrowserWindowConstructorOptions {
  const { width, height } = parseFeaturesSize(features);
  return {
    parent: mainWindow ?? undefined,
    width: clampDimension(width, DEFAULT_POPUP_WIDTH),
    height: clampDimension(height, DEFAULT_POPUP_HEIGHT),
    minWidth: MIN_POPUP_DIMENSION,
    minHeight: MIN_POPUP_DIMENSION,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

/**
 * Parse `width`/`height` out of a `window.open` features string
 * (e.g. "width=500,height=600,popup"). Missing/invalid values come back
 * undefined and fall through to defaults.
 */
function parseFeaturesSize(features: string): {
  width?: number;
  height?: number;
} {
  const result: { width?: number; height?: number } = {};
  for (const part of features.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!rawValue) continue;
    const value = Number.parseInt(rawValue.trim(), 10);
    if (Number.isNaN(value)) continue;
    if (key === "width") result.width = value;
    else if (key === "height") result.height = value;
  }
  return result;
}

/**
 * Register a freshly created child popup window against its originating pane.
 * Applies the same external-link policy as the main window so the popup can't
 * spawn an unbounded chain of further popups (http/https opens go to the system
 * browser), and removes the window from the registry on `closed`.
 */
export function registerChildWindow(
  paneId: string,
  childWindow: BrowserWindow,
): void {
  let set = childWindowsByPane.get(paneId);
  if (!set) {
    set = new Set<BrowserWindow>();
    childWindowsByPane.set(paneId, set);
  }
  set.add(childWindow);

  // Further window.open from inside the popup goes to the system browser
  // rather than spawning nested popups (mirror electron/window.ts policy).
  childWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: "deny" };
  });

  childWindow.on("closed", () => {
    const current = childWindowsByPane.get(paneId);
    if (!current) return;
    current.delete(childWindow);
    if (current.size === 0) {
      childWindowsByPane.delete(paneId);
    }
  });
}

/**
 * Close and forget every child popup window opened from the given pane. Called
 * when the pane is unregistered (its <webview> goes away) so popups don't
 * outlive their opener.
 */
export function closeChildWindowsForPane(paneId: string): void {
  const set = childWindowsByPane.get(paneId);
  if (!set) return;
  // Copy first: close() triggers the `closed` handler which mutates the set.
  for (const win of [...set]) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
  childWindowsByPane.delete(paneId);
}

/**
 * Close and forget all tracked child popup windows across every pane. Called
 * when the main window is closing as a defensive backstop (children are
 * parented to the main window so Chromium closes them too, but this guarantees
 * the registry is emptied and no listeners leak).
 */
export function closeAllChildWindows(): void {
  for (const paneId of [...childWindowsByPane.keys()]) {
    closeChildWindowsForPane(paneId);
  }
}
