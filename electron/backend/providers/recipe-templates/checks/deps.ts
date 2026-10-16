/**
 * What a template's checks run commands with (ADR-234 D6): `execFile`, no
 * shell, a short timeout each, so a hung daemon or a slow cluster can't stall
 * the form. A seam, so tests fake it.
 */

import { execFile } from "node:child_process";

/** How long one probe may take unless it says otherwise. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface CheckDeps {
  /**
   * Run `file` with `args` (on the login PATH the app already uses) and
   * resolve with its stdout. Rejects when it is not found, exits non-zero
   * or outlives `timeoutMs` (default `DEFAULT_PROBE_TIMEOUT_MS`).
   */
  execFile: (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;
}

export const defaultCheckDeps: CheckDeps = {
  execFile: (file, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          timeout: opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    }),
};
