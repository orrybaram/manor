---
title: Convert BranchWatcher to async file I/O
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Convert BranchWatcher to async file I/O

The BranchWatcher uses `fs.statSync` and `fs.readFileSync` every 2 seconds per workspace. Convert to async and add overlap protection.

## Changes

1. Convert `readBranch()` to async — use `fs.promises.stat()` and `fs.promises.readFile()` instead of sync variants
2. Convert `scan()` to async (it calls `readBranch`)
3. Make the `tick()` function in `start()` async
4. Add a `scanning` boolean guard (like PortScanner and DiffWatcher) to prevent overlapping ticks if a scan takes longer than 2 seconds

## Files to touch
- `electron/branch-watcher.ts` — convert to async file I/O, add scanning guard
