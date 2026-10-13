/**
 * The host server's process entry (ADR-225 D1).
 *
 *   node host-server-index.js serve [--data-dir <dir>]
 *
 * Bundled into the host tarball and dispatched from `manor-host serve` by
 * ticket 5, which also starts it (detached) from `remote-bridge`. The
 * version is `MANOR_VERSION`, set by whoever spawns it, as for the daemon.
 *
 * Electron-free, transitively: `platform/__tests__/electron-free.test.ts`
 * bundles this file and fails on any `electron` import.
 */

import { execFile } from "node:child_process";
import { errorMessage } from "../lib/errors";
import { runServe } from "./serve";

function usage(): never {
  process.stderr.write("usage: host-server serve [--data-dir <dir>]\n");
  process.exit(2);
}

/** `--name value` from argv, or undefined. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) usage();
  return value;
}

/** Where `gh` is on this server's PATH, logged once: GitHub runs here (ADR-227 D7). */
function logGhPath(): void {
  execFile("which", ["gh"], { encoding: "utf-8", timeout: 5000 }, (err, stdout) => {
    console.info(
      err ? "[host-server] gh not found on PATH" : `[host-server] gh: ${stdout.trim()}`,
    );
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "serve") usage();

  // Detached with its stdio ignored or closed, a console write must never be
  // what takes the server down.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const running = await runServe({
    dataDir: flag(argv, "--data-dir"),
    version: process.env.MANOR_VERSION ?? "unknown",
  });

  logGhPath();

  const shutdown = (signal: string) => {
    console.info(`[host-server] ${signal}`);
    void running.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  // A broken server should be restarted (by the next `remote-bridge`), not
  // left spinning. Persist what it can on the way out; the daemon and every
  // session on it are untouched either way.
  process.once("uncaughtException", (err) => {
    console.error("[host-server] uncaught exception:", err);
    void running.stop().finally(() => process.exit(1));
  });
}

main().catch((err: unknown) => {
  console.error(`[host-server] failed to start: ${errorMessage(err)}`);
  process.exit(1);
});
