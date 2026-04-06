#!/usr/bin/env node
/**
 * Release script that bumps the version, generates a changelog via Claude CLI,
 * commits, tags, and pushes.
 *
 * Usage: node scripts/release.mjs <version> [--dry-run]
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf-8", ...opts }).trim();
}

function die(msg) {
  console.error(`\n  Error: ${msg}\n`);
  process.exit(1);
}

function isValidSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(v);
}

function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"));

if (!version) {
  die("Version argument is required.\n  Usage: node scripts/release.mjs <version> [--dry-run]");
}

if (!isValidSemver(version)) {
  die(`Invalid semver format: "${version}". Expected X.Y.Z`);
}

const tag = `v${version}`;

// ---------------------------------------------------------------------------
// Step 1 — Validate
// ---------------------------------------------------------------------------

// Tag must not already exist
try {
  run(`git rev-parse ${tag}`);
  die(`Tag ${tag} already exists.`);
} catch {
  // Good — tag does not exist
}

// Working tree must be clean
if (!dryRun) {
  const status = run("git status --porcelain");
  if (status) {
    die("Working tree is not clean. Commit or stash changes first.");
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Get commits since last tag
// ---------------------------------------------------------------------------

let prevTag;
try {
  prevTag = run("git describe --tags --abbrev=0");
} catch {
  die("No previous tag found. Create an initial tag first.");
}

const commits = run(`git log ${prevTag}..HEAD --oneline`);

if (!commits) {
  die(`No commits found since ${prevTag}.`);
}

console.log(`\nCommits since ${prevTag}:\n`);
console.log(commits);
console.log();

// ---------------------------------------------------------------------------
// Step 3 — Generate changelog via Claude CLI
// ---------------------------------------------------------------------------

const systemPrompt = [
  "You are a changelog writer for a desktop app called Manor (a macOS terminal).",
  "Given a list of git commits, produce a concise markdown changelog.",
  "Rules:",
  "- Group into categories: Features, Fixes, Improvements (only include categories that have entries)",
  "- Write user-facing descriptions, not raw commit messages",
  "- Skip chore, CI, and internal-only commits",
  "- Use markdown list format (- item)",
  "- One line per change, be concise",
  "- Do NOT include a heading — just the categorized lists",
  "- Output raw markdown only, no code fences",
].join(" ");

console.log("Generating changelog with Claude...\n");

let changelog;
try {
  changelog = execSync(
    `echo ${JSON.stringify(commits)} | claude --print -s ${JSON.stringify(systemPrompt)}`,
    { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"] },
  ).trim();
} catch (e) {
  die("Failed to generate changelog via Claude CLI. Is `claude` installed and on PATH?");
}

console.log("--- Generated changelog ---");
console.log(changelog);
console.log("---\n");

// ---------------------------------------------------------------------------
// Dry-run stops here
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log("[dry-run] Would write changelog, bump version, commit, tag, and push.");
  console.log("[dry-run] Done.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 4 — Write CHANGELOG.md
// ---------------------------------------------------------------------------

const newEntry = `## [${version}] - ${today()}\n\n${changelog}`;

if (fs.existsSync(CHANGELOG_PATH)) {
  const existing = fs.readFileSync(CHANGELOG_PATH, "utf-8");
  // Insert after the first "# Changelog" header line
  const headerRe = /^# Changelog\s*\n/m;
  const match = existing.match(headerRe);
  if (match) {
    const insertAt = match.index + match[0].length;
    const updated =
      existing.slice(0, insertAt) +
      "\n" +
      newEntry +
      "\n\n" +
      existing.slice(insertAt);
    fs.writeFileSync(CHANGELOG_PATH, updated);
  } else {
    // No header found — prepend header + entry
    fs.writeFileSync(CHANGELOG_PATH, `# Changelog\n\n${newEntry}\n\n${existing}`);
  }
} else {
  fs.writeFileSync(CHANGELOG_PATH, `# Changelog\n\n${newEntry}\n`);
}

console.log("Updated CHANGELOG.md");

// ---------------------------------------------------------------------------
// Step 5 — Bump version
// ---------------------------------------------------------------------------

run(`pnpm pkg set version=${version}`);
console.log(`Bumped version to ${version}`);

// ---------------------------------------------------------------------------
// Step 6 — Commit
// ---------------------------------------------------------------------------

run("git add CHANGELOG.md package.json");
run(`git commit -m "chore: release v${version}"`);
console.log(`Created commit: chore: release v${version}`);

// ---------------------------------------------------------------------------
// Step 7 — Tag
// ---------------------------------------------------------------------------

run(`git tag ${tag}`);
console.log(`Created tag: ${tag}`);

// ---------------------------------------------------------------------------
// Step 8 — Push
// ---------------------------------------------------------------------------

run("git push && git push --tags");
console.log("Pushed to remote");

// ---------------------------------------------------------------------------
// Step 9 — Summary
// ---------------------------------------------------------------------------

console.log(`
Release ${tag} complete!

  - Version bumped to ${version}
  - CHANGELOG.md updated
  - Committed and tagged
  - Pushed to remote

Changelog:
${changelog}
`);
