---
title: Create release script with LLM changelog generation
status: done
priority: high
assignee: opus
blocked_by: []
---

# Create release script with LLM changelog generation

Create `scripts/release.mjs` — a Node.js script that orchestrates the full release flow.

## Behavior

Usage: `node scripts/release.mjs <version>` (e.g., `node scripts/release.mjs 0.4.0`)

Add `--dry-run` flag that does everything except commit, tag, and push.

### Steps the script performs:

1. **Validate input**:
   - Version arg is required, must match semver format (X.Y.Z)
   - Tag `vX.Y.Z` must not already exist
   - Working tree must be clean (no uncommitted changes)

2. **Get commits since last tag**:
   - `git describe --tags --abbrev=0` to find previous tag
   - `git log <prev-tag>..HEAD --oneline` to get commit list

3. **Generate changelog via Claude CLI**:
   - Pipe the commit list to `claude` with `--print` flag
   - System prompt should instruct Claude to:
     - Group commits into categories (Features, Fixes, Improvements, etc.)
     - Write user-facing descriptions (not raw commit messages)
     - Skip chore/CI/internal commits
     - Use markdown list format
     - Be concise — one line per change
   - Use `execSync` with `{ stdio: ['pipe', 'pipe', 'inherit'] }` so stderr (progress) shows but stdout is captured

4. **Write CHANGELOG.md**:
   - If file doesn't exist, create it with a `# Changelog` header
   - Prepend new entry in this format:
     ```
     ## [X.Y.Z] - YYYY-MM-DD

     <generated changelog>
     ```
   - Read existing content, insert new section after the `# Changelog` header line

5. **Bump version**: Run `pnpm pkg set version=<version>`

6. **Commit**: `git add CHANGELOG.md package.json && git commit -m "chore: release v<version>"`

7. **Tag**: `git tag v<version>`

8. **Push**: `git push && git push --tags`

9. **Print summary**: Show what was done, including the changelog preview

For `--dry-run`, perform steps 1-4, print the changelog that would be generated, then exit without modifying any files.

### Add package.json script

Add to `scripts` in `package.json`:
```json
"release": "node scripts/release.mjs"
```

## Files to touch
- `scripts/release.mjs` — new file, the release script
- `package.json` — add `release` script entry
