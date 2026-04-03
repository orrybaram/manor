---
title: Expand GitHub PR data model with CI and review fields
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Expand GitHub PR data model with CI and review fields

Add extended PR fields to the GitHub integration layer so the popover has data to display.

## Files to touch
- `electron/github.ts` — expand gh fields, parse statusCheckRollup
- `src/store/project-store.ts` — extend PrInfo interface
- `src/electron.d.ts` — update type definitions
- `src/hooks/usePrWatcher.ts` — pass through new fields
