/**
 * What a template's checks run commands with (ADR-234 D6): `execFile`, no
 * shell, a short timeout each, so a hung daemon or a slow cluster can't stall
 * the form. A seam, so tests fake it.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TemplateJobs } from "./jobs";

/** How long one probe may take unless it says otherwise. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface CheckDeps {
  /** Where existing recipes live; absent means `hostRecipesDir()`. A seam for tests. */
  recipesDir?: string;
  /** Manor's version, for a blank image field's default (`defaultHostImage`). */
  appVersion?: string;
  /** Absent means `process.platform`. Decides which "open the app" fix applies. */
  platform?: NodeJS.Platform;
  /** The background pulls and builds (ADR-234 D3, D8); absent means the app's own. */
  jobs?: TemplateJobs;
  /** The host image's Dockerfile directory; absent means `hostImageDir()`. */
  hostImageDir?: string;
  /**
   * Run `file` with `args` (on the login PATH the app already uses) and
   * resolve with its stdout. Rejects when it is not found (`code: "ENOENT"`),
   * exits non-zero (the error carries `stdout` and `stderr`) or outlives
   * `timeoutMs` (default `DEFAULT_PROBE_TIMEOUT_MS`; the error has `killed`).
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
        (err, stdout, stderr) =>
          err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout),
      );
    }),
};

/** Why a probe failed, in the terms a check reads it. */
export type ProbeFailure =
  | { kind: "missing" }
  | { kind: "timeout" }
  /** `output`: what it printed (stderr, then stdout), trimmed. */
  | { kind: "failed"; output: string; stdout: string };

/** Read an error from `CheckDeps.execFile`. */
export function probeFailure(err: unknown): ProbeFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (e.code === "ENOENT") return { kind: "missing" };
  if (e.killed === true || e.code === "ETIMEDOUT") return { kind: "timeout" };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  let output = [stderr.trim(), stdout.trim()].filter((s) => s !== "").join("\n");
  if (output === "" && typeof e.message === "string") {
    // Node's own message: "Command failed: <cmd>\n<stderr>".
    output = e.message.replace(/^Command failed:[^\n]*\n?/, "").trim();
  }
  return { kind: "failed", output, stdout };
}

/** The first non-blank line of `text`, or `fallback`. */
export function firstLine(text: string, fallback = ""): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? fallback;
}

/** The line of a command's output that says what went wrong: the last that sounds like an error, else the last. */
export function failureLine(output: string): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== "");
  const telling = [...lines]
    .reverse()
    .find((l) => /error|denied|failed|unauthorized|forbidden|not found|unknown|unable|refused|no matching/i.test(l));
  return (telling ?? lines[lines.length - 1] ?? "").trim();
}

/** "5 seconds" for a timeout of 5000 ms. */
export function seconds(ms: number = DEFAULT_PROBE_TIMEOUT_MS): string {
  const s = Math.round(ms / 1000);
  return s === 1 ? "1 second" : `${s} seconds`;
}

/**
 * Where the host image's Dockerfile is (ADR-234 D3): `host-image/` under the
 * packaged app's resources (electron-builder `extraResources`), else the
 * repository's `docker/host-image` beside the built `dist-electron/` (as
 * `manorVersion()` finds `package.json`). Checked by existence rather than
 * `app.isPackaged` so this stays Electron-free.
 */
export function hostImageDir(): string {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const packaged = path.join(resources, "host-image");
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(__dirname, "..", "docker", "host-image");
}
