/**
 * One renderer's viewport file (ADR-179 D3).
 *
 * `~/.manor/viewport.json` is *not* layout. Layout is the Manor server's, one
 * copy for every renderer on the host; this is the primary desktop window's
 * answer to "which tab was I on", and a browser keeps its own in
 * `localStorage` without ever touching this (see `src/bridge/unavailable.ts`).
 * That is why these two calls are deliberately absent from the bridge handler
 * table: a phone that asked the host where it had been would be handed the
 * desk's answer.
 *
 * Read and written whole, the way `layout-persistence.ts` does it, because it
 * is a few hundred bytes and there is exactly one writer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import { viewportFile } from "../paths";
import type { WorkspaceViewport } from "../../src/lib/layout/viewport";
import type { IpcDeps } from "./types";

export const VIEWPORT_FILE = viewportFile();

/** The whole file: every workspace this renderer has looked at, plus where. */
export interface PersistedViewportFile {
  version: 1;
  activeWorkspacePath: string | null;
  workspaces: Record<string, WorkspaceViewport>;
}

/**
 * The file, or null when there is none.
 *
 * A malformed or unreadable file is a missing one: the renderer falls back to
 * the host's default viewport, which is a worse guess than the file and an
 * enormously better one than refusing to boot.
 */
export function viewportLoad(
  filePath: string = VIEWPORT_FILE,
): PersistedViewportFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const file = parsed as PersistedViewportFile;
    if (file.version !== 1 || typeof file.workspaces !== "object") return null;
    return {
      version: 1,
      activeWorkspacePath: file.activeWorkspacePath ?? null,
      workspaces: file.workspaces ?? {},
    };
  } catch {
    return null;
  }
}

export function viewportSave(
  file: PersistedViewportFile,
  filePath: string = VIEWPORT_FILE,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
}

export function register(_deps: IpcDeps): void {
  ipcMain.handle("viewport:load", () => viewportLoad());

  ipcMain.handle("viewport:save", (_event, file: PersistedViewportFile) => {
    viewportSave(file);
  });

  // Who this renderer is, as `layout:apply` names it in a command's origin.
  // Synchronous because the preload has to answer `rendererId` before the app
  // can ask for it, and there is nothing to wait for: `webContents.id` is
  // already in hand (ADR-179 D3).
  ipcMain.on("viewport:rendererId", (event) => {
    event.returnValue = String(event.sender.id);
  });
}
