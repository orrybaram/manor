---
title: Add visual focus indicator and escape hint for focused webview
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Add visual focus indicator and escape hint for focused webview

## Focus indicator

In `LeafPane.tsx`, when the browser pane's webview is focused (`navState?.webviewFocused === true`):
1. Apply a CSS class to the `.leafTerminal` container div that adds a visible top-border highlight (2px solid using `var(--accent)` color)

## Escape hint

When `navState?.webviewFocused` is true, render a small floating hint inside the `.leafTerminal` div:
1. Text content: "Esc Esc to exit" (indicating double-tap)
2. Positioned at top-center of the webview container, slightly below the accent border
3. The hint should fade in, stay visible for ~2 seconds, then fade out using CSS `@keyframes` animation with `animation-fill-mode: forwards`
4. Use a key or re-mount trick so the animation restarts each time the webview gains focus
5. Style: small pill/badge, semi-transparent dark background (`rgba(0,0,0,0.7)`), white text, 10-11px font size, slight border-radius, small padding

## CSS

Add styles to `BrowserPane.module.css`:
- `.webviewFocused` — 2px solid `var(--accent)` top border on the container
- `.escapeHint` — absolutely positioned pill at top-center with fade keyframe animation

```css
@keyframes escapeHintFade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}

.escapeHint {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  pointer-events: none;
  z-index: 10;
  animation: escapeHintFade 2.5s ease-out forwards;
}
```

## Files to touch
- `src/components/LeafPane.tsx` — conditionally apply focus class and render hint element
- `src/components/BrowserPane.module.css` — add `.webviewFocused` and `.escapeHint` styles with keyframe animation
