/**
 * Uploads the clipboard's image to a pane's host.
 *
 * Pasting an image into a remote pane does nothing on its own: the agent
 * reads the clipboard of the box it runs on, which has none. This moves the
 * bytes there and hands back a path Claude Code can attach like any other
 * pasted file. Split out of `misc.ts` (which has no tests today) so the
 * upload logic — everything but the `ipcMain.handle` wiring — is testable on
 * its own.
 */

import type { BackendRegistry } from "../backend/registry";
import { LOCAL_HOST_ID } from "../backend/types";
import { errorMessage } from "../lib/errors";
import { writePastedImage } from "../server/pasted-images";

/** Reads the clipboard's image as PNG bytes, or `null` when it holds none. */
export type ReadClipboardPng = () => Promise<Buffer | null>;

export type PasteClipboardImageResult =
  | { kind: "local" }
  | { kind: "none" }
  | { kind: "uploaded"; path: string }
  | { kind: "error"; message: string };

/**
 * Uploads the image `readPng` reads to `paneId`'s host's `~/.manor/pasted-images`, or
 * reports why there is nothing to upload: `local` (the pane's own host reads
 * its own clipboard), `none` (the clipboard has no image), or `error` (the
 * upload failed, e.g. the host is away).
 *
 * `paneHostId` is the host the renderer says the pane runs on. Main's own
 * `sessions` only learns of a remote session when it lists the host's daemon
 * (on connect and reconnect): a pane made since then, through the renderer's
 * viewer stream, is unknown here and would read as local.
 */
export async function uploadClipboardImage(
  registry: BackendRegistry,
  paneId: string,
  readPng: ReadClipboardPng,
  paneHostId?: string,
): Promise<PasteClipboardImageResult> {
  const hostId = paneHostId ?? registry.sessions.ownerOf(paneId);
  if (hostId === undefined || hostId === LOCAL_HOST_ID)
    return { kind: "local" };

  try {
    const png = await readPng();
    if (png === null) return { kind: "none" };
    return {
      kind: "uploaded",
      path: await writePastedImage(registry, hostId, png, "png"),
    };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}
