---
title: Add timeout to flushHeadless
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Add timeout to flushHeadless

Add a 2-second timeout to `Session.flushHeadless()` so it can't hang forever and block the daemon's serialized handler queue.

## Files to touch
- `electron/terminal-host/session.ts` — modify `flushHeadless()` to resolve after 2s even if `headlessWritesPending > 0`. Log a warning when the timeout fires.
