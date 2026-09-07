/**
 * Open a directory in the user's configured editor. Shared by the
 * `shell:openInEditor` IPC handler and, once ADR-171's system routes land,
 * the `/shell/open-in-editor` route.
 */

import { shell } from "electron";
import { execFile } from "node:child_process";
import type { PreferencesManager } from "./preferences";

/** Body moved verbatim from `shell:openInEditor`. */
export async function openInEditor(
  preferencesManager: PreferencesManager,
  dirPath: string,
): Promise<string | void> {
  const editor = preferencesManager.get("defaultEditor");
  if (!editor) {
    return shell.openPath(dirPath);
  }
  return new Promise<string>((resolve) => {
    execFile(editor, [dirPath], (err) => {
      resolve(err ? err.message : "");
    });
  });
}
