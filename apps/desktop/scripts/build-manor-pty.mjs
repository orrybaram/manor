#!/usr/bin/env node
/**
 * Build the native PTY helper (native/manor-pty) for every platform Manor
 * ships it to, into dist-electron/ where the daemon looks for it
 * (`electron/terminal-host/pty-helper.ts`):
 *
 *   manor-pty-linux-x64, manor-pty-linux-arm64
 *       static musl binaries, linked by Rust's own rust-lld, so they need no
 *       C toolchain to build and run on any distro. For remote hosts and the
 *       host image, via the manor-host tarball.
 *   manor-pty-darwin-universal
 *       arm64 + x86_64 joined with lipo, for the Mac app and Mac remote
 *       hosts. Built only on macOS (it needs the Apple linker and lipo).
 *
 * Run after `vite build`, before build-host-tarball.mjs and electron-builder.
 * Needs rustup; adds the targets it needs.
 *
 * Usage: node scripts/build-manor-pty.mjs [--linux-only]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CRATE = path.join(ROOT, "native", "manor-pty");
const OUT_DIR = path.join(ROOT, "dist-electron");
const linuxOnly = process.argv.includes("--linux-only");

const LINUX = [
  ["x86_64-unknown-linux-musl", "manor-pty-linux-x64"],
  ["aarch64-unknown-linux-musl", "manor-pty-linux-arm64"],
];
const DARWIN = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

// rustup's default home, for shells that don't have it on PATH.
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const PATH = [process.env.PATH, fs.existsSync(cargoBin) ? cargoBin : null]
  .filter(Boolean)
  .join(path.delimiter);

function run(cmd, args, env = {}) {
  execFileSync(cmd, args, {
    cwd: CRATE,
    stdio: "inherit",
    env: { ...process.env, PATH, ...env },
  });
}

function build(target, env = {}) {
  run("rustup", ["target", "add", target]);
  run("cargo", ["build", "--release", "--locked", "--target", target], env);
  return path.join(CRATE, "target", target, "release", "manor-pty");
}

function ship(from, name) {
  const to = path.join(OUT_DIR, name);
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
  console.log(
    `  ${path.relative(ROOT, to)} (${(fs.statSync(to).size / 1024).toFixed(0)} KiB)`,
  );
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const entry of fs.readdirSync(OUT_DIR)) {
  if (entry.startsWith("manor-pty-")) fs.rmSync(path.join(OUT_DIR, entry));
}

const built = [];
for (const [target, name] of LINUX) {
  built.push([
    build(target, {
      RUSTFLAGS: "-C linker=rust-lld -C link-self-contained=yes",
    }),
    name,
  ]);
}

if (!linuxOnly) {
  if (process.platform === "darwin") {
    const slices = DARWIN.map((t) =>
      build(t, { MACOSX_DEPLOYMENT_TARGET: "11.0" }),
    );
    const universal = path.join(CRATE, "target", "manor-pty-darwin-universal");
    execFileSync("lipo", ["-create", "-output", universal, ...slices], {
      stdio: "inherit",
    });
    built.push([universal, "manor-pty-darwin-universal"]);
  } else {
    console.warn(
      "build-manor-pty: not on macOS, so no manor-pty-darwin-universal (Macs fall back to Node)",
    );
  }
}

console.log("Built manor-pty:");
for (const [from, name] of built) ship(from, name);
