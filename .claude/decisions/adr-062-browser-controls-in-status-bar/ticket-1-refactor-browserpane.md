---
title: Expose BrowserPane nav via ref and remove toolbar
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Expose BrowserPane nav via ref and remove toolbar

Add `useImperativeHandle` to BrowserPane so LeafPane can call navigation methods and read nav state. Remove the toolbar rendering from BrowserPane since LeafPane will render it.

## Files to touch
- `src/components/BrowserPane.tsx` — add forwardRef, useImperativeHandle, callback props, remove toolbar JSX
- `src/components/BrowserPane.module.css` — remove toolbar styles
