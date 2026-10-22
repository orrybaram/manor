/**
 * Files dropped onto a terminal pane — a screenshot dragged from the desktop,
 * a file from Finder — become their paths at the prompt, the way a native
 * terminal pastes them, so an agent like Claude Code can read the image.
 *
 * - Desktop, local pane: the file is already on the pane's machine, so paste
 *   its real path, shell-quoted.
 * - Remote pane, the web, or a file with no path on disk (an image dragged
 *   out of a browser): the pane's host can't read it, so upload images the
 *   same way paste does (`pasteImageFile`) and paste the uploaded path.
 *   Anything else can't cross, and a toast says so.
 */

import type { Terminal } from "@xterm/xterm";
import { isWebApp } from "./platform";
import { isRemotePane, pasteImageFile } from "./remote-image-paste";
import { useToastStore } from "../store/toast-store";

const SHELL_SAFE = /^[A-Za-z0-9@%_+=:,./-]+$/;

/** POSIX-quote a path, as `electron/terminal-host/ssh-config.ts` does. */
export function shellQuote(value: string): string {
  if (value !== "" && SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** True when a drag carries files from outside the app (not a pane or tab). */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

/** The file's path on this machine, or null in a browser or for an in-memory file. */
function localPath(file: File): string | null {
  return window.manorHost?.pathForFile(file) || null;
}

export async function dropFilesOnTerminal(
  term: Terminal,
  paneId: string,
  files: File[],
): Promise<void> {
  const onThisMachine = !isWebApp() && !isRemotePane(paneId);
  let skipped = 0;
  for (const file of files) {
    const path = onThisMachine ? localPath(file) : null;
    if (path) {
      // Trailing space so the next path stands apart, as `pasteImageFile` does.
      term.paste(shellQuote(path) + " ");
    } else if (file.type.startsWith("image/")) {
      await pasteImageFile(term, paneId, file);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) {
    useToastStore.getState().addToast({
      id: `drop-files-${paneId}`,
      message:
        skipped === 1
          ? "Only images can be dropped onto a remote terminal"
          : `${skipped} files skipped: only images can be dropped onto a remote terminal`,
      status: "error",
    });
  }
}
