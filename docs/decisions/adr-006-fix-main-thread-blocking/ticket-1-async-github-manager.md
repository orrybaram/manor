---
title: Convert GitHubManager to async
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Convert GitHubManager to async

Replace all `execSync` calls in `GitHubManager` with async `execFileAsync` equivalents.

## Changes

1. Replace `execSync` import with `execFile` + `promisify` pattern (like PortScanner/DiffWatcher already use)
2. Make `getPrForBranchInner` async — use `execFileAsync("gh", ["pr", "list", "--head", branch, ...])` instead of `execSync` with string interpolation
3. Make `getPrForBranch` and `getPrsForBranches` async
4. In `getPrsForBranches`, use `Promise.allSettled` to fetch all branches in parallel instead of a sequential `.map()` loop

## Files to touch
- `electron/github.ts` — convert all methods to async, replace execSync with execFileAsync
