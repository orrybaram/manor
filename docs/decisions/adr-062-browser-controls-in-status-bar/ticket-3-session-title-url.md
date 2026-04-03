---
title: Show URL in session tab for browser panes
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Show URL in session tab for browser panes

## Files to touch
- `src/components/useSessionTitle.ts` — add paneContentType and paneUrl lookups, use URL as fallback for browser panes
