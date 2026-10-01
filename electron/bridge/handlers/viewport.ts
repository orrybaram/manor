/**
 * One renderer's viewport file (ADR-179 D3, ADR-180 D4), as the `viewport`
 * namespace of the handler table.
 *
 * `~/.manor/viewport.json` is *not* layout. Layout is the Manor server's, one
 * copy for every renderer on the host; this is the primary desktop window's
 * answer to "which tab was I on", and a browser keeps its own in
 * `localStorage` without ever touching this (see `src/bridge/unavailable.ts`).
 *
 * Read and written whole, the way `layout-persistence.ts` does it, because it
 * is a few hundred bytes and there is exactly one writer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { viewportFile } from "../../paths";
import type { PersistedViewportFile } from "../../../src/lib/layout/protocol";
import { method, type HandlerCtx } from "../method";

const VIEWPORT_FILE = viewportFile();

/**
 * The file, or null when there is none.
 *
 * A malformed or unreadable file is a missing one: the renderer falls back to
 * the host's default viewport, which is a worse guess than the file and an
 * enormously better one than refusing to boot.
 */
export function viewportLoad(): PersistedViewportFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(VIEWPORT_FILE, "utf-8"));
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
  _ctx: HandlerCtx,
  file: PersistedViewportFile,
): void {
  fs.mkdirSync(path.dirname(VIEWPORT_FILE), { recursive: true });
  fs.writeFileSync(VIEWPORT_FILE, JSON.stringify(file, null, 2));
}

// The desk's own file. A device asking the host which tab it had been on
// would be handed the answer for a different screen; the browser answers
// itself out of `localStorage` and never asks.
export const viewport = {
  load: method(viewportLoad, { localOnly: true }),
  save: method(viewportSave, { localOnly: true }),
};
