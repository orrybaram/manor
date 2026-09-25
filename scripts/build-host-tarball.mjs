#!/usr/bin/env node
/**
 * Build the `manor-host` npm tarball that remote bootstrap (ADR-160, ticket 6)
 * streams to remote boxes: dist-electron/manor-host-<version>.tgz.
 *
 * Contents, nested under `package/` like `npm pack` output:
 *   terminal-host-index.js   the daemon bundle (also the `manor-host` CLI)
 *   pty-subprocess.js        spawned by the daemon, found via __dirname
 *   package.json             generated; pins the bundles' externals at the
 *                            versions in the root package.json
 *
 * Run after `vite build` (it reads the bundles from dist-electron/). The
 * remote runs `npm install --omit=dev` against the generated package.json,
 * so node-pty resolves for the remote's platform rather than ours.
 *
 * Usage: node scripts/build-host-tarball.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-electron");
const BUNDLES = ["terminal-host-index.js", "pty-subprocess.js"];
/** The externals of the two bundles (see vite.config.ts). */
const RUNTIME_DEPS = ["node-pty", "@xterm/headless", "@xterm/addon-serialize", "tree-kill"];
const MIN_NODE = ">=20";

function die(msg) {
  console.error(`\n  build-host-tarball: ${msg}\n`);
  process.exit(1);
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const version = rootPkg.version;

const dependencies = {};
for (const dep of RUNTIME_DEPS) {
  const range = rootPkg.dependencies?.[dep];
  if (!range) die(`${dep} is not a dependency in package.json`);
  // Pin to the version actually installed here, so the remote runs what we tested.
  const installed = path.join(ROOT, "node_modules", dep, "package.json");
  dependencies[dep] = fs.existsSync(installed)
    ? JSON.parse(fs.readFileSync(installed, "utf-8")).version
    : range;
}

for (const bundle of BUNDLES) {
  if (!fs.existsSync(path.join(OUT_DIR, bundle))) {
    die(`dist-electron/${bundle} is missing — run \`pnpm build\` (or \`vite build\`) first`);
  }
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "manor-host-pack-"));
try {
  const pkgDir = path.join(staging, "package");
  fs.mkdirSync(pkgDir);
  for (const bundle of BUNDLES) {
    fs.copyFileSync(path.join(OUT_DIR, bundle), path.join(pkgDir, bundle));
  }
  const hostPkg = {
    name: "manor-host",
    version,
    private: true,
    description: "Manor terminal host daemon, installed on remote hosts by the Manor app.",
    main: "terminal-host-index.js",
    engines: { node: MIN_NODE },
    dependencies,
  };
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(hostPkg, null, 2) + "\n");

  const outFile = path.join(OUT_DIR, `manor-host-${version}.tgz`);
  // Remove tarballs from earlier versions so they are not packaged too.
  for (const entry of fs.readdirSync(OUT_DIR)) {
    if (/^manor-host-.*\.tgz$/.test(entry)) fs.rmSync(path.join(OUT_DIR, entry));
  }
  execFileSync("tar", ["-czf", outFile, "-C", staging, "package"], {
    // Keep macOS tar from adding AppleDouble `._*` entries.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "inherit",
  });
  const size = fs.statSync(outFile).size;
  console.log(
    `Built ${path.relative(ROOT, outFile)} (${(size / 1024).toFixed(0)} KiB) — ` +
      Object.entries(dependencies)
        .map(([k, v]) => `${k}@${v}`)
        .join(", "),
  );
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
