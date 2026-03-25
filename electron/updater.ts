import { BrowserWindow } from "electron";
import {
  autoUpdater,
  type UpdateInfo,
  type ProgressInfo,
} from "electron-updater";

export function initAutoUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    win.webContents.send("updater:update-available", info);
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    win.webContents.send("updater:update-downloaded", info);
  });

  autoUpdater.on("error", (err: Error) => {
    win.webContents.send("updater:error", err.message);
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
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates();
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
