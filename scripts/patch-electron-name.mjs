#!/usr/bin/env node
/**
 * Patches the Electron.app Info.plist so macOS shows a branch-aware
 * name in the menu bar and Dock during development.
 *
 * Called automatically before `vite` via the dev script.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") process.exit(0);

const ROOT = path.resolve(import.meta.dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "node_modules/electron");
const DIST = path.join(ELECTRON_DIR, "dist");
const PLIST = path.join(DIST, "Electron.app/Contents/Info.plist");

function getBranch() {
  try {
    const gitPath = path.join(ROOT, ".git");
    const stat = fs.statSync(gitPath);

    let headPath;
    if (stat.isDirectory()) {
      headPath = path.join(gitPath, "HEAD");
    } else {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(gitPath, "utf-8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      const gitdir = path.isAbsolute(m[1])
        ? m[1]
        : path.resolve(ROOT, m[1]);
      headPath = path.join(gitdir, "HEAD");
    }

    const head = fs.readFileSync(headPath, "utf-8").trim();
    const refMatch = head.match(/^ref: refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

const branch = getBranch();
const name = branch ? `Manor (${branch})` : "Manor";
// Unique bundle ID per branch so macOS treats each worktree as a separate app
const slug = (branch ?? "dev").replace(/[^a-zA-Z0-9-]/g, "-");
const bundleId = `com.manor.dev.${slug}`;

try {
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c", `Set :CFBundleDisplayName ${name}`,
    "-c", `Set :CFBundleName ${name}`,
    "-c", `Set :CFBundleIdentifier ${bundleId}`,
    PLIST,
  ]);
} catch (e) {
  console.warn("[patch-electron-name] Failed to patch plist:", e.message);
  process.exit(0);
}

// Create a symlink with the desired name so macOS shows it in the Dock.
// The Dock label comes from the .app folder name, not the plist.
// Use slug (not name) for the filename: branch names may contain '/' which
// path.join() interprets as a directory separator, breaking symlinkSync.
const appBundle = `Manor (${slug}).app`;
const symlinkPath = path.join(DIST, appBundle);
const pathTxt = path.join(ELECTRON_DIR, "path.txt");

try {
  // Remove stale symlinks from previous branches
  for (const entry of fs.readdirSync(DIST)) {
    const p = path.join(DIST, entry);
    if (entry !== "Electron.app" && entry.endsWith(".app") && entry.startsWith("Manor")) {
      try { fs.unlinkSync(p); } catch {}
    }
  }

  fs.symlinkSync("Electron.app", symlinkPath);

  fs.writeFileSync(pathTxt, `${appBundle}/Contents/MacOS/Electron`);
  console.log(`[patch-electron-name] → ${name} (${bundleId})`);
} catch (e) {
  console.warn("[patch-electron-name] Failed to create app symlink:", e.message);
}
