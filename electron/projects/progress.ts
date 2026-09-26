/**
 * Progress events `ProjectManager` broadcasts to every renderer window
 * (ADR-183 split these out of `ProjectManager`).
 */

import { BrowserWindow } from "electron";
import type { CloneProgress } from "./remote-clone";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/** One step of creating a worktree, on `worktree:setup-progress`. */
export function emitSetupProgress(step: string, status: string, message?: string): void {
  broadcast("worktree:setup-progress", { step, status, message });
}

/** Clone progress on its own channel (ADR-183 ticket 1). */
export const emitCloneProgress: CloneProgress = (status, message) => {
  broadcast("projects:clone-progress", { status, message });
};
