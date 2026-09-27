import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write `data` to `filePath` atomically: write to a sibling `.tmp` file, then
 * rename it over the target. A reader never sees a half-written file, even if
 * the process is killed mid-write (ADR-183).
 *
 * Creates the parent directory if it does not exist, with `dirMode` if given.
 * `mode`, when given, is applied to the file.
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  opts?: { mode?: number; dirMode?: number },
): void {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
    ...(opts?.dirMode !== undefined ? { mode: opts.dirMode } : {}),
  });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  if (opts?.mode !== undefined) fs.chmodSync(tmp, opts.mode);
  fs.renameSync(tmp, filePath);
}
