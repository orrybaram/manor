#!/usr/bin/env node
/**
 * Release script that bumps the version, generates a changelog via Claude CLI
 * from the merged PRs since the last tag, lets you review it, then commits,
 * tags, and pushes.
 *
 * Usage: node scripts/release.mjs [--major | --minor] [--dry-run]
 *
 * Defaults to a patch bump. Use --minor or --major to bump those instead.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
// The app's version lives in the desktop package: vite, electron-builder and
// the host tarball all read it there.
const DESKTOP_DIR = path.join(ROOT, "apps/desktop");

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
const bumpMajor = args.includes("--major");
const bumpMinor = args.includes("--minor");

if (bumpMajor && bumpMinor) {
  die("Cannot use both --major and --minor.");
}

// ---------------------------------------------------------------------------
// Determine next version
// ---------------------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "package.json"), "utf-8"));
const currentVersion = pkg.version;

if (!isValidSemver(currentVersion)) {
  die(`Current version in apps/desktop/package.json is not valid semver: "${currentVersion}"`);
}

const [major, minor, patch] = currentVersion.split(".").map(Number);

let version;
if (bumpMajor) {
  version = `${major + 1}.0.0`;
} else if (bumpMinor) {
  version = `${major}.${minor + 1}.0`;
} else {
  version = `${major}.${minor}.${patch + 1}`;
}

const tag = `v${version}`;

console.log(`Current version: ${currentVersion}`);
console.log(`Bumping to: ${version}\n`);

// ---------------------------------------------------------------------------
// Step 1 — Validate
// ---------------------------------------------------------------------------

// Tag must not already exist
try {
  run(`git rev-parse ${tag}`, { stdio: "pipe" });
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
// Step 2 — Gather what changed since the last tag
// ---------------------------------------------------------------------------

let prevTag;
try {
  prevTag = run("git describe --tags --abbrev=0");
} catch {
  die("No previous tag found. Create an initial tag first.");
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

// Commit types that never reach users. Bookkeeping commits make up most of a
// release's commits and only add noise.
const NOISE_RE = /^(chore|ci|test|docs|build|style|refactor)(\(.*?\))?!?:|^Merge (branch|remote-tracking|origin|ticket)/i;
const MAX_BODY = 1500;

function truncate(text, max = MAX_BODY) {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n[…truncated]` : t;
}

// Keep the prose of a PR body; drop evidence, test plans, logs and code blocks.
function summarizePrBody(body) {
  const cut = body.search(/^##\s*(Evidence|Test plan|Testing|Verification|Screenshots)/im);
  const kept = (cut === -1 ? body : body.slice(0, cut))
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/🤖 Generated with.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return truncate(kept);
}

function fetchPr(number) {
  try {
    return JSON.parse(
      execFileSync("gh", ["pr", "view", String(number), "--json", "title,body"], {
        cwd: ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

const SEP = "\x1e";
const FIELD = "\x1f";
const firstParent = git("log", `${prevTag}..HEAD`, "--first-parent", `--format=%H${FIELD}%P${FIELD}%s${FIELD}%b${SEP}`)
  .split(SEP)
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [hash, parents, subject, body = ""] = r.split(FIELD);
    return { hash, parents: parents.split(" "), subject, body };
  });

if (firstParent.length === 0) {
  die(`No commits found since ${prevTag}.`);
}

const sections = [];
let skipped = 0;

for (const c of firstParent) {
  const prMatch = c.subject.match(/^Merge pull request #(\d+)/);
  if (prMatch && c.parents.length > 1) {
    const number = prMatch[1];
    const pr = fetchPr(number);
    const title = pr?.title ?? c.body.split("\n")[0];
    const description = pr ? summarizePrBody(pr.body ?? "") : truncate(c.body);
    const branchCommits = git("log", `${c.parents[0]}..${c.parents[1]}`, "--no-merges", "--format=%s")
      .split("\n")
      .filter((s) => s && !NOISE_RE.test(s));
    sections.push(
      [
        `### PR #${number}: ${title}`,
        description,
        branchCommits.length ? `Commits:\n${branchCommits.map((s) => `- ${s}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    continue;
  }
  if (NOISE_RE.test(c.subject) || c.parents.length > 1) {
    skipped++;
    continue;
  }
  sections.push([`### Commit: ${c.subject}`, truncate(c.body, 600)].filter(Boolean).join("\n\n"));
}

if (sections.length === 0) {
  die(`Nothing user-facing since ${prevTag} (${skipped} chore/docs/test commits skipped).`);
}

const changes = sections.join("\n\n---\n\n");

console.log(`Changes since ${prevTag}: ${sections.length} PRs/commits (${skipped} internal commits skipped)\n`);
for (const s of sections) console.log(`  ${s.split("\n")[0].replace(/^### /, "")}`);
console.log();

// The last two entries show Claude the house style.
function recentEntries(count) {
  if (!fs.existsSync(CHANGELOG_PATH)) return "";
  const text = fs.readFileSync(CHANGELOG_PATH, "utf-8");
  const starts = [...text.matchAll(/^## \[/gm)].map((m) => m.index);
  if (starts.length === 0) return "";
  return text.slice(starts[0], starts[count] ?? text.length).trim();
}

// ---------------------------------------------------------------------------
// Step 3 — Generate changelog via Claude CLI
// ---------------------------------------------------------------------------

const systemPrompt = `You write release notes for Manor, an Electron desktop app (macOS and Linux) for running terminals and coding agents across git worktrees. It has a companion phone app and can run workspaces on remote hosts.

You get the merged PRs and direct commits for one release. Write the changelog entry for it.

Accuracy comes first:
- Only describe behaviour the PR description or commits state. Never infer details, numbers or UI names that aren't there.
- If you can't tell what a change does for the user, leave it out rather than guess.
- Name UI exactly as the source does (button labels, page names, menu items).

What to include:
- Write for people who use Manor, not for its developers. Say what they can now do or what stopped going wrong.
- Merge related work into one entry. A PR with many commits is usually one or two entries, not one per commit.
- Leave out refactors, tests, docs, CI, tooling, agent skills and internal-only fixes.
- Mention a fix only when a user could have run into the bug.

Format:
- Sections, in this order, only when non-empty: "### Features", "### Fixes", "### Improvements".
- "- " bullets, one change per bullet, one or two short sentences.
- Plain, direct sentences. Fixes say what works now ("Pasting an image into a remote pane uploads it to that host"), not "Fixed a bug where…".
- Prefix with a short area label like "Phone:" only when it helps tell similar entries apart.
- No version heading, no intro or outro text, no code fences. Output the markdown only.`;

const examples = recentEntries(2);
const prompt = `${examples ? `Recent changelog entries, for style:\n\n${examples}\n\n=====\n\n` : ""}Changes in this release:\n\n${changes}`;

function generate() {
  console.log("Generating changelog with Claude...\n");
  try {
    const out = execFileSync("claude", ["--print", "--tools", "", "--system-prompt", systemPrompt], {
      cwd: ROOT,
      encoding: "utf-8",
      input: prompt,
      stdio: ["pipe", "pipe", "inherit"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .trim()
      .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1")
      .trim();
  } catch {
    die("Failed to generate changelog via Claude CLI. Is `claude` installed and on PATH?");
  }
}

function show(text) {
  console.log("--- Generated changelog ---");
  console.log(text);
  console.log("---\n");
}

let changelog = generate();
show(changelog);

// ---------------------------------------------------------------------------
// Step 3b — Review: accept, edit, regenerate or abort before anything is written
// ---------------------------------------------------------------------------

if (!dryRun && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const answer = (await rl.question("[a]ccept, [e]dit, [r]egenerate, [q]uit? ")).trim().toLowerCase();
    if (answer === "a" || answer === "") break;
    if (answer === "q") {
      rl.close();
      console.log("Aborted. Nothing was changed.");
      process.exit(1);
    }
    if (answer === "r") {
      changelog = generate();
      show(changelog);
    } else if (answer === "e") {
      const tmp = path.join(os.tmpdir(), `manor-changelog-${version}.md`);
      fs.writeFileSync(tmp, `${changelog}\n`);
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      spawnSync(`${editor} "${tmp}"`, { stdio: "inherit", shell: true });
      changelog = fs.readFileSync(tmp, "utf-8").trim();
      fs.rmSync(tmp, { force: true });
      show(changelog);
    }
  }
  rl.close();
  if (!changelog) die("Changelog is empty.");
}

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
  // Insert after the first "# Changelog" header line, collapsing the blank
  // lines that follow it so they don't accumulate across releases
  const headerRe = /^# Changelog\s*\n/m;
  const match = existing.match(headerRe);
  if (match) {
    const insertAt = match.index + match[0].length;
    const updated =
      existing.slice(0, match.index) +
      "# Changelog\n\n" +
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

run(`npm pkg set version=${version}`, { cwd: DESKTOP_DIR });
console.log(`Bumped version to ${version}`);

// ---------------------------------------------------------------------------
// Step 6 — Commit
// ---------------------------------------------------------------------------

run("git add CHANGELOG.md apps/desktop/package.json");
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
