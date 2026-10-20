/**
 * Pid files and their kin, for the host server's own process bookkeeping:
 * `serve.ts` (refuse to start over a live server, clean up on the way out)
 * and `lifecycle.ts` (is the server up, the `server.lock`).
 */

import fs from "node:fs";

/** The positive integer pid in `file`, or null when there is none. */
export function readPid(file: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether `pid` names a live process (EPERM: alive, but someone else's). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove `file` only if it still holds what this process wrote there. */
export function removeIfOurs(file: string, contents: string): void {
  try {
    if (fs.readFileSync(file, "utf-8") === contents) fs.unlinkSync(file);
  } catch {
    // Gone, or replaced by a newer writer.
  }
}
