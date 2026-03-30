---
title: Add about:blank empty state overlay to BrowserPane
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add about:blank empty state overlay to BrowserPane

When the browser pane URL is `about:blank`, render a dark-themed empty state overlay on top of the webview container. Auto-focus the URL input so the user can immediately type a destination.

## Files to touch

- `src/components/BrowserPane.tsx` — Add `isBlank` state derived from URL, render overlay div when blank, auto-focus URL input via ref
- `src/components/BrowserPane.module.css` — Add `.emptyState` class with centered layout, dark background matching `--dim`, and subtle text using `--text-dim`
