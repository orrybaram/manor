/**
 * Uploads the clipboard's image to a pane's host (ADR-187 §3).
 *
 * Pasting an image into a remote pane does nothing on its own: the agent
 * reads the clipboard of the box it runs on, which has none. This moves the
 * bytes there and hands back a path Claude Code can attach like any other
 * pasted file. Split out of `misc.ts` (which has no tests today) so the
 * upload logic — everything but the `ipcMain.handle` wiring — is testable on
 * its own.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { BackendRegistry } from "../backend/registry";
import { LOCAL_HOST_ID } from "../backend/types";
import { errorMessage } from "../lib/errors";

/** The `clipboard:writeText`/co. surface only needs `NativeImage`'s shape. */
export interface ClipboardImage {
  isEmpty(): boolean;
  toPNG(): Buffer;
}

export type PasteClipboardImageResult =
  | { kind: "local" }
  | { kind: "none" }
  | { kind: "uploaded"; path: string }
  | { kind: "error"; message: string };

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Uploads `clipboardImage` to `paneId`'s host's `~/.manor/pasted-images`, or
 * reports why there is nothing to upload: `local` (the pane's own host reads
 * its own clipboard), `none` (the clipboard has no image), or `error` (the
 * upload failed, e.g. the host is away).
 */
export async function uploadClipboardImage(
  registry: BackendRegistry,
  paneId: string,
  clipboardImage: ClipboardImage,
): Promise<PasteClipboardImageResult> {
  const hostId = registry.sessions.ownerOf(paneId);
  if (hostId === undefined || hostId === LOCAL_HOST_ID)
    return { kind: "local" };

  if (clipboardImage.isEmpty()) return { kind: "none" };

  try {
    // `get`, not `RoutedBackend.shell`: the pane's host owns both the home
    // directory and the write, and `RoutedBackend` would pick a host from a
    // path instead (see ADR-187 ticket 2's note).
    const host = registry.get(hostId);
    const home = await host.shell.homeDir();
    const dir = `${home}/.manor/pasted-images`;
    const filePath = path.posix.join(
      dir,
      `${timestamp(new Date())}-${crypto.randomBytes(4).toString("hex")}.png`,
    );
    await host.shell.writeFile(filePath, clipboardImage.toPNG());
    // Fire and forget: keep the directory from growing forever. A failure
    // here (e.g. no `find` on the box) does not undo the upload.
    host.shell
      .exec("find", [dir, "-type", "f", "-mtime", "+7", "-delete"])
      .catch(() => {});
    return { kind: "uploaded", path: filePath };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}
