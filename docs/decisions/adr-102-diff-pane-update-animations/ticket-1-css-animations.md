---
title: Add CSS keyframes and animation classes
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add CSS keyframes and animation classes

Add the animation keyframes and utility classes to the DiffPane CSS module.

## Animations to add

1. **`fadeSlideIn`** — for new file blocks and file list items. Fade from 0→1 opacity with a slight translateY(-4px→0) over ~300ms.

2. **`highlightPulse`** — for updated files. A brief background-color highlight that fades out. Use `color-mix(in srgb, var(--accent, var(--blue)) 15%, transparent)` as the highlight color, animating from that to transparent over ~400ms.

## Classes to add

- `.fileNew` — applies `fadeSlideIn` animation
- `.fileUpdated` — applies `highlightPulse` animation on the file header
- `.fileListItemNew` — applies `fadeSlideIn` animation
- `.fileListItemUpdated` — applies `highlightPulse` animation

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffPane.module.css` — add keyframes and classes at the end of the file
