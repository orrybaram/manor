import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from "electron";

/**
 * Which files each window's file panes hold unsaved edits to, by
 * `webContents` id, as its renderer reports them (`report-unsaved-files`).
 * Closing a window that has some, or quitting while any window has some,
 * asks first: those edits live in that renderer's memory and nowhere else.
 */
const unsavedByWindow = new Map<number, string[]>();

export function registerUnsavedFilesIpc(): void {
  ipcMain.on("window:setUnsavedFiles", (event, files: unknown) => {
    if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return;
    const id = event.sender.id;
    if (files.length === 0) {
      unsavedByWindow.delete(id);
      return;
    }
    if (!unsavedByWindow.has(id)) {
      event.sender.once("destroyed", () => unsavedByWindow.delete(id));
    }
    unsavedByWindow.set(id, files);
  });
}

/** The unsaved files of the windows whose `webContents` ids are given. */
function unsavedFilesOf(webContentsIds: Iterable<number>): string[] {
  const files: string[] = [];
  for (const id of webContentsIds) files.push(...(unsavedByWindow.get(id) ?? []));
  return files;
}

/** The confirm for closing a window (`close`) or quitting (`quit`) over `files`. */
export function unsavedFilesPrompt(
  files: readonly string[],
  action: "close" | "quit",
): MessageBoxOptions {
  const count = files.length === 1 ? "1 file has" : `${files.length} files have`;
  return {
    type: "warning",
    message: `${count} unsaved changes`,
    detail:
      `${files.join("\n")}\n\n` +
      (action === "quit"
        ? "Your changes will be lost if you quit."
        : "Your changes will be lost if you close this window."),
    buttons: [action === "quit" ? "Quit Anyway" : "Close Anyway", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * Before quitting with `windows` open: true to go ahead, which it is at once
 * when none of them has unsaved edits; else the user is asked.
 */
export function confirmQuitOverUnsaved(windows: readonly BrowserWindow[]): boolean {
  const files = unsavedFilesOf(windows.map((w) => w.webContents.id));
  if (files.length === 0) return true;
  const parent = BrowserWindow.getFocusedWindow() ?? windows[0];
  return dialog.showMessageBoxSync(parent, unsavedFilesPrompt(files, "quit")) === 0;
}

/**
 * Before closing `win`: true to go ahead, which it is at once when it has no
 * unsaved edits; else the user is asked. Going ahead forgets its files, so
 * the quit that may follow the last window does not ask again.
 */
export function confirmCloseOverUnsaved(win: BrowserWindow): boolean {
  const id = win.webContents.id;
  const files = unsavedFilesOf([id]);
  if (files.length === 0) return true;
  if (dialog.showMessageBoxSync(win, unsavedFilesPrompt(files, "close")) !== 0) return false;
  unsavedByWindow.delete(id);
  return true;
}
