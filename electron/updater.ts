/**
 * The auto-updater, and the six things it tells the renderer (ADR-180 D5).
 *
 * `updater` stays native for its *invokes* — `checkForUpdates` and
 * `quitAndInstall` are Electron's, and no browser can run them (ADR-178's
 * "what can never leave the preload"). Its pushes are not native in the same
 * way: they are facts about this machine, and every renderer attached to it
 * wants them, so they go out as `updater.*` bridge events rather than into
 * one window's `webContents`. A second desktop window used to learn nothing
 * about a download already in progress.
 */

import { app } from "electron";
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import { cjsExports, lazy } from "./lib/lazy";
import { publishRendererBroadcast } from "./renderer-broadcast";
import type { EventArgs, EventOf } from "./bridge/events";

// Track whether the last checkForUpdates() call was triggered manually by the user.
// Set to true in the exported checkForUpdates() (called via IPC from renderer).
// Latched into lastCheckedManual in "checking-for-update" and then reset to false,
// so downstream events (update-not-available, error) carry the correct flag for the
// check cycle that triggered them.
let lastTriggerWasManual = false;
let lastCheckedManual = false;

/**
 * One `updater.<event>` frame. The event names are the preload's, minus the
 * `on` — `onDownloadProgress` hears `downloadProgress`.
 */
function send<E extends EventOf<"updater">>(
  event: E,
  ...args: EventArgs<"updater", E>
): void {
  publishRendererBroadcast("updater", event, ...args);
}

/**
 * Loads electron-updater on first use (keeps it out of the startup path) and
 * wires its event listeners exactly once.
 */
const loadUpdater = lazy(async (): Promise<AppUpdater> => {
  const { autoUpdater } = cjsExports(
    await import("electron-updater"),
    "autoUpdater",
  );

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    lastCheckedManual = lastTriggerWasManual;
    lastTriggerWasManual = false; // reset for next check cycle
    send("checking", { manual: lastCheckedManual });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    send("updateNotAvailable", {
      version: info.version,
      manual: lastCheckedManual,
    });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    send("updateAvailable", info);
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    send("updateDownloaded", info);
  });

  autoUpdater.on("error", (err: Error) => {
    send("error", {
      message: err.message,
      manual: lastCheckedManual,
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    send("downloadProgress", {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  return autoUpdater;
});

async function backgroundCheck(): Promise<void> {
  try {
    const updater = await loadUpdater();
    await updater.checkForUpdates();
  } catch {
    // In dev mode or without code signing, this will fail silently
  }
}

export function initAutoUpdater(): void {
  // Skip updater entirely in dev — prevents swallowed-error noise
  if (!app.isPackaged) return;

  setTimeout(() => {
    void backgroundCheck();
  }, 5000);

  // Recheck every 4 hours for the lifetime of the app
  setInterval(() => {
    void backgroundCheck();
  }, 4 * 60 * 60 * 1000);
}

/**
 * Fire-and-forget, like the check it replaced: the outcome reaches the renderer
 * through the `updater:*` events, not through the caller.
 */
export function checkForUpdates(): void {
  lastTriggerWasManual = true;
  void runUpdater((updater) => updater.checkForUpdates());
}

export function quitAndInstall(): void {
  void runUpdater((updater) => updater.quitAndInstall());
}

async function runUpdater(
  action: (updater: AppUpdater) => unknown,
): Promise<void> {
  try {
    await action(await loadUpdater());
  } catch (err) {
    console.error("[updater]", err);
  }
}
