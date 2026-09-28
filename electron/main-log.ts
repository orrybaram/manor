/**
 * Mirrors main-process console output to a rotating log file on disk
 * (ADR-188 §4).
 *
 * Main normally logs only to stdout, which is lost the moment the app is
 * launched from Finder/Dock rather than a terminal — exactly the case where
 * something like a wedged remote connection needs to be diagnosed after the
 * fact. `installMainLog()` wraps `console.log/info/warn/error/debug` so every
 * call still prints as before and is also appended, with an ISO timestamp and
 * level, to `<dir>/main.log`.
 *
 * Kept deliberately dumb: one append-mode `fs.WriteStream`, one rotated
 * backup (`main.log.1`), and every fs operation swallowed. A logging failure
 * must never surface to the user or take down the app — at worst, the file
 * stops updating and console output keeps working.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

/** Roughly caps `main.log` + `main.log.1` at about 10 MiB combined. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export interface MainLogOptions {
  /** Directory to write `main.log` into. Defaults to `app.getPath("logs")`. */
  dir?: string;
  /** Rotate once the file exceeds this many bytes. Default 5 MiB. */
  maxBytes?: number;
}

/** Module-level guard: a second `installMainLog()` call is a no-op. */
let installed = false;

/**
 * Pure line formatter, exported so the format can be unit-tested without
 * standing up a stream. `now` defaults to the current time; tests pass an
 * explicit `Date` for a deterministic string.
 */
export function formatLine(level: string, args: unknown[], now: Date = new Date()): string {
  return `${now.toISOString()} ${level.toUpperCase()} ${util.format(...args)}\n`;
}

export function installMainLog(opts?: MainLogOptions): void {
  if (installed) return;
  installed = true;

  const dir = opts?.dir ?? app.getPath("logs");
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const logPath = path.join(dir, "main.log");
  const rotatedPath = path.join(dir, "main.log.1");

  let stream: fs.WriteStream | null = null;
  let bytesWritten = 0;
  // Set once a stream 'error' fires (or an fs call throws). From then on the
  // wrapped console methods still call the original — only file writing stops.
  let broken = false;

  /** Rename `main.log` -> `main.log.1`, overwriting any previous backup. */
  function rotateFile(): void {
    try {
      fs.renameSync(logPath, rotatedPath);
    } catch {
      // No main.log to rotate yet, or the rename failed — best effort only.
    }
  }

  /** (Re)open the append stream, starting the byte counter at `initialSize`. */
  function openStream(initialSize: number): void {
    try {
      stream = fs.createWriteStream(logPath, { flags: "a" });
      stream.on("error", () => {
        broken = true;
        stream = null;
      });
      bytesWritten = initialSize;
    } catch {
      broken = true;
      stream = null;
    }
  }

  // Install-time rotation: a `main.log` left oversized by a previous run
  // rotates before the first line of this run is appended.
  try {
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      size = 0;
    }
    if (size > maxBytes) {
      rotateFile();
      size = 0;
    }
    openStream(size);
  } catch {
    broken = true;
  }

  function write(level: string, args: unknown[]): void {
    if (broken || !stream) return;
    try {
      const line = formatLine(level, args);
      stream.write(line);
      bytesWritten += Buffer.byteLength(line);
      // Rotate for next time once this write pushed us past the cap — we
      // track size ourselves rather than `statSync` on every line.
      if (bytesWritten > maxBytes) {
        stream.end();
        rotateFile();
        openStream(0);
      }
    } catch {
      broken = true;
      stream = null;
    }
  }

  for (const method of CONSOLE_METHODS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      write(method, args);
    };
  }
}
