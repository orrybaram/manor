import * as crypto from "node:crypto";
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

/**
 * The async twin of `writeFileAtomic`, for callers off the sync path (the
 * sealed stores, whose secret box is async). Same guarantee: the target holds
 * either its old contents or `data`, never a torn mix.
 *
 * The temp name is unique per call, so two writes to one target racing each
 * other cannot truncate one another's temp file; the later rename wins. A
 * failed write removes its temp file and rejects, leaving the target as it was.
 */
export async function writeFileAtomicAsync(
  filePath: string,
  data: string | Buffer,
  opts?: { mode?: number; dirMode?: number },
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    ...(opts?.dirMode !== undefined ? { mode: opts.dirMode } : {}),
  });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(
      tmp,
      data,
      opts?.mode !== undefined ? { mode: opts.mode } : undefined,
    );
    if (opts?.mode !== undefined) await fs.promises.chmod(tmp, opts.mode);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
