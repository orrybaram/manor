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
const PLIST = path.join(
  ROOT,
  "node_modules/electron/dist/Electron.app/Contents/Info.plist",
);

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

try {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleDisplayName ${name}`, "-c", `Set :CFBundleName ${name}`, PLIST]);
  console.log(`[patch-electron-name] → ${name}`);
} catch (e) {
  console.warn("[patch-electron-name] Failed to patch plist:", e.message);
}
