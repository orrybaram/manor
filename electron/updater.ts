import { app, BrowserWindow } from "electron";
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";

// Track whether the last checkForUpdates() call was triggered manually by the user.
// Set to true in the exported checkForUpdates() (called via IPC from renderer).
// Latched into lastCheckedManual in "checking-for-update" and then reset to false,
// so downstream events (update-not-available, error) carry the correct flag for the
// check cycle that triggered them.
let lastTriggerWasManual = false;
let lastCheckedManual = false;

let getWindowFn: (() => BrowserWindow | null) | null = null;
let updaterPromise: Promise<AppUpdater> | null = null;

function send(channel: string, payload: unknown): void {
  const win = getWindowFn?.();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/**
 * Loads electron-updater on first use (keeps it out of the startup path) and
 * wires its event listeners exactly once.
 */
function loadUpdater(): Promise<AppUpdater> {
  if (updaterPromise) return updaterPromise;
  updaterPromise = (async () => {
    const mod = await import("electron-updater");
    const autoUpdater: AppUpdater =
      mod.autoUpdater ??
      (mod as unknown as { default: { autoUpdater: AppUpdater } }).default
        .autoUpdater;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      lastCheckedManual = lastTriggerWasManual;
      lastTriggerWasManual = false; // reset for next check cycle
      send("updater:checking-for-update", { manual: lastCheckedManual });
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      send("updater:update-not-available", {
        version: info.version,
        manual: lastCheckedManual,
      });
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      send("updater:update-available", info);
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      send("updater:update-downloaded", info);
    });

    autoUpdater.on("error", (err: Error) => {
      send("updater:error", {
        message: err.message,
        manual: lastCheckedManual,
      });
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      send("updater:download-progress", {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    return autoUpdater;
  })();
  // Allow a retry if the import itself failed.
  updaterPromise.catch(() => {
    updaterPromise = null;
  });
  return updaterPromise;
}

async function backgroundCheck(): Promise<void> {
  try {
    const updater = await loadUpdater();
    await updater.checkForUpdates();
  } catch {
    // In dev mode or without code signing, this will fail silently
  }
}

/**
 * @param getWindow  Resolves the primary window at send time. The updater runs
 *   for the life of the app, which outlives any one window: capturing a
 *   `BrowserWindow` here would leave every event sending into a destroyed one.
 */
export function initAutoUpdater(
  getWindow: () => BrowserWindow | null,
): void {
  // Skip updater entirely in dev — prevents swallowed-error noise
  if (!app.isPackaged) return;

  getWindowFn = getWindow;

  setTimeout(() => {
    void backgroundCheck();
  }, 5000);

  // Recheck every 4 hours for the lifetime of the app
  setInterval(() => {
    void backgroundCheck();
  }, 4 * 60 * 60 * 1000);
}

export async function checkForUpdates(): Promise<void> {
  lastTriggerWasManual = true;
  const updater = await loadUpdater();
  await updater.checkForUpdates();
}

export async function quitAndInstall(): Promise<void> {
  const updater = await loadUpdater();
  updater.quitAndInstall();
}
