import {
  BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type WebContents,
} from "electron";

/** A file pane with unsaved edits, as its window's renderer reports it. */
export type UnsavedFile = { paneId: string; path: string };

/**
 * Which file panes of each window hold unsaved edits, by `webContents` id,
 * as its renderer reports them (`report-unsaved-files`). Closing a window
 * that has some, or quitting while any window has some, asks first: those
 * edits live in that renderer's memory and nowhere else.
 */
const unsavedByWindow = new Map<number, UnsavedFile[]>();

/** The `webContents` whose entry is cleared when it dies; one listener pair each. */
const watched = new WeakSet<WebContents>();

/**
 * Forget a window's entry when its renderer goes: destroyed, or crashed
 * (a crashed renderer's edits are gone with it, so the list is stale).
 */
function watch(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const id = contents.id;
  contents.once("destroyed", () => unsavedByWindow.delete(id));
  contents.on("render-process-gone", () => unsavedByWindow.delete(id));
}

function isUnsavedFile(value: unknown): value is UnsavedFile {
  if (typeof value !== "object" || value === null) return false;
  const { paneId, path } = value as Record<string, unknown>;
  return typeof paneId === "string" && typeof path === "string";
}

export function registerUnsavedFilesIpc(): void {
  ipcMain.on("window:setUnsavedFiles", (event, files: unknown) => {
    if (!Array.isArray(files) || !files.every(isUnsavedFile)) return;
    const contents = event.sender;
    watch(contents);
    if (files.length === 0) unsavedByWindow.delete(contents.id);
    else unsavedByWindow.set(contents.id, files);
  });
  ipcMain.handle("window:unsavedPanesElsewhere", (event, paneIds: unknown) => {
    if (!Array.isArray(paneIds)) return [];
    return unsavedPanesElsewhere(
      event.sender.id,
      paneIds.filter((id): id is string => typeof id === "string"),
    );
  });
}

/**
 * Those of `paneIds` with unsaved edits in a window other than the one
 * whose `webContents` id is `askerId`: closing them from the asker would
 * lose edits it cannot see, let alone save.
 */
export function unsavedPanesElsewhere(
  askerId: number,
  paneIds: readonly string[],
): UnsavedFile[] {
  const wanted = new Set(paneIds);
  const found: UnsavedFile[] = [];
  for (const [id, files] of unsavedByWindow) {
    if (id === askerId) continue;
    for (const file of files) if (wanted.has(file.paneId)) found.push(file);
  }
  return found;
}

/** The unsaved files of the windows whose `webContents` ids are given. */
function unsavedFilesOf(webContentsIds: Iterable<number>): string[] {
  const files: string[] = [];
  for (const id of webContentsIds) {
    for (const file of unsavedByWindow.get(id) ?? []) files.push(file.path);
  }
  return files;
}

/** Whether any of `windows` has unsaved file edits. */
export function hasUnsavedFiles(windows: readonly BrowserWindow[]): boolean {
  return unsavedFilesOf(windows.map((w) => w.webContents.id)).length > 0;
}

/**
 * Why a quit nobody at the desk asked for (an update install over HTTP, from
 * MCP or the phone) must not go ahead, or null when it may: unsaved edits
 * would be lost, and there is nobody to ask.
 */
export function unattendedQuitRefusal(): string | null {
  const files = unsavedFilesOf(unsavedByWindow.keys());
  if (files.length === 0) return null;
  const count = files.length === 1 ? "1 file has" : `${files.length} files have`;
  return `${count} unsaved changes on the desktop. Save or discard them there first.`;
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
 * Whether an unsaved-edits prompt is open. One at a time: a second quit or
 * close while it is up is ignored (answered false), not stacked.
 */
let asking = false;

/**
 * Ask, without blocking the main process (IPC, PTYs and the relay carry on
 * while the box is up), whether to lose the files of the windows `ids`.
 * Going ahead forgets their entries, so the quit or close it retries passes.
 */
async function ask(
  parent: BrowserWindow | undefined,
  ids: readonly number[],
  action: "close" | "quit",
): Promise<boolean> {
  const files = unsavedFilesOf(ids);
  if (files.length === 0) return true;
  if (asking) return false;
  asking = true;
  try {
    const prompt = unsavedFilesPrompt(files, action);
    const { response } =
      parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, prompt)
        : await dialog.showMessageBox(prompt);
    if (response !== 0) return false;
    for (const id of ids) unsavedByWindow.delete(id);
    return true;
  } catch (err) {
    console.error("[unsaved-files] prompt failed:", err);
    return false;
  } finally {
    asking = false;
  }
}

/**
 * Before quitting with `windows` open: true to go ahead, at once when none
 * of them has unsaved edits; else once the user chose Quit Anyway. False on
 * Cancel, and for a quit asked while a prompt is already up.
 */
export function confirmQuitOverUnsaved(windows: readonly BrowserWindow[]): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? windows[0];
  return ask(
    parent,
    windows.map((w) => w.webContents.id),
    "quit",
  );
}

/**
 * Before closing `win`: true to go ahead, at once when it has no unsaved
 * edits; else once the user chose Close Anyway. Going ahead forgets its
 * files, so the close it retries (and a quit after the last window) passes.
 */
export function confirmCloseOverUnsaved(win: BrowserWindow): Promise<boolean> {
  return ask(win, [win.webContents.id], "close");
}

/**
 * In a window's `close` handler: whether the close is held to ask about the
 * window's unsaved edits. Held, it is prevented now and, on Close Anyway,
 * retried (the retry finds the files forgotten, and passes).
 */
export function holdCloseForUnsaved(
  win: BrowserWindow,
  event: { preventDefault(): void },
): boolean {
  if (!hasUnsavedFiles([win])) return false;
  event.preventDefault();
  void confirmCloseOverUnsaved(win).then((go) => {
    if (go && !win.isDestroyed()) win.close();
  });
  return true;
}

/**
 * In `before-quit`, once it is holding the quit and before tearing anything
 * down: whether to stop there and ask about unsaved edits in `windows`.
 * On Quit Anyway `quit` runs again, and passes; on Cancel (or for a quit
 * while a box is already up) nothing happens and the app runs on.
 */
export function holdQuitForUnsaved(
  windows: readonly BrowserWindow[],
  quit: () => void,
): boolean {
  if (!hasUnsavedFiles(windows)) return false;
  void confirmQuitOverUnsaved(windows).then((go) => {
    if (go) quit();
  });
  return true;
}
