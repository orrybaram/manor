import { app, BrowserWindow, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

import { windowBoundsFile, zoomLevelFile } from "./paths";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export function loadZoomLevel(): number {
  try {
    const data = fs.readFileSync(zoomLevelFile(), "utf-8");
    return JSON.parse(data).zoomFactor ?? 1;
  } catch {
    return 1;
  }
}

export function saveZoomLevel(factor: number): void {
  try {
    const p = zoomLevelFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ zoomFactor: factor }));
  } catch {
    /* ignore */
  }
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const data = fs.readFileSync(windowBoundsFile(), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function saveWindowBounds(win: BrowserWindow): void {
  const bounds: WindowBounds = {
    ...win.getBounds(),
    isMaximized: win.isMaximized(),
  };
  try {
    const boundsPath = windowBoundsFile();
    fs.mkdirSync(path.dirname(boundsPath), { recursive: true });
    fs.writeFileSync(boundsPath, JSON.stringify(bounds));
  } catch {
    /* ignore write errors */
  }
}

function boundsAreVisible(bounds: WindowBounds): boolean {
  const displays = screen.getAllDisplays();
  // Check if the window's center point is within any display
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    return cx >= x && cx < x + width && cy >= y && cy < y + height;
  });
}

// ── Shared window configuration ─────────────────────────────────────────────
// Both the primary window and detached popup windows share the same renderer,
// webPreferences and link-handling. These helpers keep the two entry points in
// sync so a detached window is a faithful clone of the primary (minus the
// persisted bounds/zoom, which are primary-only).

/**
 * Build the shared `webPreferences`. When `detachedWindowId` is provided the
 * renderer receives an extra `--manor-detached=<id>` argument (mirrors the
 * existing `--manor-packaged` arg) so it can boot in detached mode.
 */
function buildWebPreferences(
  detachedWindowId?: string,
): Electron.WebPreferences {
  // Pass flags synchronously so preload can expose them without an IPC round-trip
  const additionalArguments = [`--manor-packaged=${app.isPackaged}`];
  if (detachedWindowId) {
    additionalArguments.push(`--manor-detached=${detachedWindowId}`);
  }
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: true,
    additionalArguments,
  };
}

/** Open links in the default browser instead of an Electron popup. */
function attachWindowOpenHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

/** Load the renderer (dev server in development, bundled file when packaged). */
function loadRenderer(win: BrowserWindow): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

export function createWindow(): BrowserWindow {
  const saved = loadWindowBounds();
  const useSaved = saved && boundsAreVisible(saved);

  const mainWindow = new BrowserWindow({
    width: useSaved ? saved.width : 1200,
    height: useSaved ? saved.height : 800,
    ...(useSaved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 400,
    minHeight: 300,
    ...(!app.isPackaged && { icon: path.join(__dirname, "../build/dev-icon.png") }),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 13 },
    backgroundColor: "#1e1e2e",
    webPreferences: buildWebPreferences(),
  });

  if (useSaved && saved.isMaximized) {
    mainWindow.maximize();
  }

  // Persist bounds on move/resize (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        saveWindowBounds(mainWindow);
      }
    }, 500);
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);
  mainWindow.on("close", () => {
    if (!mainWindow.isDestroyed()) {
      saveWindowBounds(mainWindow);
    }
  });

  // Restore persisted zoom level
  const savedZoom = loadZoomLevel();
  mainWindow.webContents.setZoomFactor(savedZoom);

  attachWindowOpenHandler(mainWindow);
  loadRenderer(mainWindow);

  return mainWindow;
}

/**
 * Create an ephemeral popup window that hosts a single detached tab. It loads
 * the same renderer as the primary window, tagged with `--manor-detached=<id>`
 * so the renderer can boot in detached mode (see ADR-156). Unlike the primary
 * window it does NOT read or write persisted bounds / zoom — detached windows
 * are session-only.
 *
 * @param windowId  Stable id for this window; also forwarded to the renderer.
 * @param spawnBounds  Where to open the window. When omitted, a default size is
 *   centered on the display under the cursor.
 */
export function createDetachedWindow(
  windowId: string,
  spawnBounds?: { x: number; y: number; width: number; height: number },
): BrowserWindow {
  let bounds: { x?: number; y?: number; width: number; height: number };
  if (spawnBounds) {
    bounds = spawnBounds;
  } else {
    const DEFAULT_WIDTH = 900;
    const DEFAULT_HEIGHT = 700;
    const cursor = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(cursor);
    bounds = {
      x: Math.round(workArea.x + (workArea.width - DEFAULT_WIDTH) / 2),
      y: Math.round(workArea.y + (workArea.height - DEFAULT_HEIGHT) / 2),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    };
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x } : {}),
    ...(bounds.y !== undefined ? { y: bounds.y } : {}),
    minWidth: 400,
    minHeight: 300,
    ...(!app.isPackaged && { icon: path.join(__dirname, "../build/dev-icon.png") }),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 13 },
    backgroundColor: "#1e1e2e",
    webPreferences: buildWebPreferences(windowId),
  });

  attachWindowOpenHandler(win);
  loadRenderer(win);

  return win;
}
