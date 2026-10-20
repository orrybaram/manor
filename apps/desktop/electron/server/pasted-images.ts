/**
 * Writes pasted image bytes to a host's `~/.manor/pasted-images`. Shared by
 * the Electron clipboard upload and the browser's chunked upload, which
 * differ only in where the bytes come from.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { BackendRegistry } from "../backend/registry";

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Writes `bytes` to `hostId`'s `~/.manor/pasted-images/<stamp>-<hex>.<ext>`
 * and returns the path. Throws when the write fails; callers decide what to
 * report.
 */
export async function writePastedImage(
  registry: Pick<BackendRegistry, "get">,
  hostId: string,
  bytes: Buffer,
  ext: string,
): Promise<string> {
  // `get`, not `RoutedBackend.shell`: the pane's host owns both the home
  // directory and the write, and `RoutedBackend` would pick a host from a
  // path instead.
  const host = registry.get(hostId);
  const home = await host.shell.homeDir();
  const dir = `${home}/.manor/pasted-images`;
  const filePath = path.posix.join(
    dir,
    `${timestamp(new Date())}-${crypto.randomBytes(4).toString("hex")}.${ext}`,
  );
  await host.shell.writeFile(filePath, bytes);
  // Fire and forget: keep the directory from growing forever. A failure
  // here (e.g. no `find` on the box) does not undo the upload.
  host.shell
    .exec("find", [dir, "-type", "f", "-mtime", "+7", "-delete"])
    .catch(() => {});
  return filePath;
}
