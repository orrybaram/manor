#!/usr/bin/env node
/**
 * `pnpm dev`: build the native PTY helper for this machine, then run vite
 * with `MANOR_PTY_DEV=1`, so the dev daemon runs the same `manor-pty` that
 * ships instead of falling back to `pty-subprocess.js`
 * (`electron/terminal-host/pty-helper.ts`).
 *
 * The build is `cargo build --release` in native/manor-pty: host target only,
 * incremental, so it costs about a second when nothing changed. Without
 * cargo, or when the build fails, dev still starts on the Node helper.
 *
 * `MANOR_PTY_HELPER=node pnpm dev` skips the build and runs the Node helper.
 *
 * The daemon outlives the app, and it reads its env when it starts. A dev
 * daemon started before this ran keeps its helper until it restarts.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CRATE = path.join(ROOT, "native", "manor-pty");

// rustup's default home, for shells that don't have it on PATH.
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const PATH = [process.env.PATH, fs.existsSync(cargoBin) ? cargoBin : null]
  .filter(Boolean)
  .join(path.delimiter);

const env = { ...process.env };

if (env.MANOR_PTY_HELPER === "node") {
  console.log("dev: MANOR_PTY_HELPER=node, so panes run pty-subprocess.js");
} else {
  const build = spawnSync("cargo", ["build", "--release", "--locked"], {
    cwd: CRATE,
    stdio: "inherit",
    env: { ...process.env, PATH },
  });
  if (build.error?.code === "ENOENT") {
    console.warn("dev: no cargo on PATH, so panes run pty-subprocess.js");
  } else if (build.status !== 0) {
    console.warn("dev: manor-pty failed to build, so panes run pty-subprocess.js");
  } else {
    env.MANOR_PTY_DEV = "1";
  }
}

const vite = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), ...process.argv.slice(2)],
  { cwd: ROOT, stdio: "inherit", env },
);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => vite.kill(sig));
}
vite.on("exit", (code, signal) => {
  process.exit(signal ? 128 + os.constants.signals[signal] : (code ?? 0));
});
