import { app, BrowserWindow } from "electron";
import {
  autoUpdater,
  type UpdateInfo,
  type ProgressInfo,
} from "electron-updater";

// Track whether the last checkForUpdates() call was triggered manually by the user.
// Set to true in the exported checkForUpdates() (called via IPC from renderer).
// Latched into lastCheckedManual in "checking-for-update" and then reset to false,
// so downstream events (update-not-available, error) carry the correct flag for the
// check cycle that triggered them.
let lastTriggerWasManual = false;
let lastCheckedManual = false;

export function initAutoUpdater(win: BrowserWindow): void {
  // Skip updater entirely in dev — prevents swallowed-error noise
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    lastCheckedManual = lastTriggerWasManual;
    lastTriggerWasManual = false; // reset for next check cycle
    win.webContents.send("updater:checking-for-update", { manual: lastCheckedManual });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    win.webContents.send("updater:update-not-available", {
      version: info.version,
      manual: lastCheckedManual,
    });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    win.webContents.send("updater:update-available", info);
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    win.webContents.send("updater:update-downloaded", info);
  });

  autoUpdater.on("error", (err: Error) => {
    win.webContents.send("updater:error", {
      message: err.message,
      manual: lastCheckedManual,
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    win.webContents.send("updater:download-progress", {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  setTimeout(() => {
    try {
      autoUpdater.checkForUpdates();
    } catch {
      // In dev mode or without code signing, this will fail silently
    }
  }, 5000);

  // Recheck every 4 hours for the lifetime of the app
  setInterval(() => {
    try {
      autoUpdater.checkForUpdates();
    } catch {
      // Ignore errors from periodic background checks
    }
  }, 4 * 60 * 60 * 1000);
}

export function checkForUpdates(): void {
  lastTriggerWasManual = true;
  autoUpdater.checkForUpdates();
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
