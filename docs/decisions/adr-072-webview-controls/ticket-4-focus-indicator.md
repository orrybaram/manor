---
title: Enhance webview focus indicator on status bar
status: done
priority: medium
assignee: haiku
blocked_by: [2]
---

# Enhance webview focus indicator on status bar

Add a visual change to the status bar when the webview within a browser pane is focused, making it clear that keyboard input is being captured by the webview.

## Implementation

### LeafPane (`src/components/LeafPane.tsx`)

Pass `navState?.webviewFocused` as a CSS class on the status bar div. Add a new class `paneStatusBarWebviewFocused` alongside the existing `paneStatusBarFocused`:

```tsx
<div
  className={`${styles.paneStatusBar} ${isFocused ? styles.paneStatusBarFocused : ""} ${isThisPaneDragging ? styles.paneStatusBarDragging : ""} ${navState?.webviewFocused ? styles.paneStatusBarWebviewFocused : ""}`}
  onPointerDown={handleStatusBarPointerDown}
>
```

### PaneLayout.module.css (`src/components/PaneLayout.module.css`)

Add the new class:

```css
.paneStatusBarWebviewFocused {
  border-bottom-color: var(--accent);
}
```

This changes the bottom border of the status bar to the accent color when the webview is focused, creating a visual connection between the status bar and the accent border-top on the webview container (from `.webviewFocused`). The effect is a unified accent-colored "frame" around the toolbar area.

## Files to touch
- `src/components/LeafPane.tsx` — Add webviewFocused class to status bar
- `src/components/PaneLayout.module.css` — Add `.paneStatusBarWebviewFocused` style
