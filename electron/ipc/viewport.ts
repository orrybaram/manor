/**
 * One renderer's viewport file (ADR-179 D3, ADR-180 D4).
 *
 * `~/.manor/viewport.json` is *not* layout. Layout is the Manor server's, one
 * copy for every renderer on the host; this is the primary desktop window's
 * answer to "which tab was I on", and a browser keeps its own in
 * `localStorage` without ever touching this (see `src/bridge/unavailable.ts`).
 *
 * Both calls are on the handler table as of ADR-180 ticket 6, and both are
 * `LOCAL_ONLY`: a window at the machine may read and write the desk's file,
 * and a paired device gets `unavailable:web` — which is exactly what it got
 * when they were absent, now written down as a decision. A browser never
 * asks in the first place; `LOCALLY_SERVED` answers it out of `localStorage`
 * before a frame is built, because the selection a phone remembers is the
 * phone's.
 *
 * Read and written whole, the way `layout-persistence.ts` does it, because it
 * is a few hundred bytes and there is exactly one writer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { viewportFile } from "../paths";
import type { WorkspaceViewport } from "../../src/lib/layout/viewport";

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

// `register()` is gone (ADR-180 ticket 6). `viewport:load` and `viewport:save`
// are table entries; `viewport:rendererId` — the synchronous "who am I" the
// preload asks before the page's first line runs — moved to
// `bridge/transports/ipc.ts`, which is the file that decides a connection is
// its `webContents.id` and so the only one that should be answering it.
