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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
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

  // Open links in default browser instead of Electron popup
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return mainWindow;
}
