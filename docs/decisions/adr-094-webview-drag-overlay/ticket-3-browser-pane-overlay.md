---
title: Add transparent overlay to BrowserPane during drags
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add transparent overlay to BrowserPane during drags

Subscribe to the drag-overlay store in BrowserPane and render a transparent overlay on top of the webview when any drag is active.

## Implementation

### BrowserPane (`src/components/workspace-panes/BrowserPane/BrowserPane.tsx`)
- Import `useDragOverlayStore` and the `selectIsDragActive` selector
- Subscribe: `const isDragActive = useDragOverlayStore(selectIsDragActive)`
- When `isDragActive`, render a `<div className={styles.dragOverlay} />` inside `.webviewContainer`, after the `<webview>` element

### BrowserPane CSS (`src/components/workspace-panes/BrowserPane/BrowserPane.module.css`)
- Add `.dragOverlay` style

## Files to touch
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — subscribe and render overlay
- `src/components/workspace-panes/BrowserPane/BrowserPane.module.css` — add `.dragOverlay` class
