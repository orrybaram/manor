---
title: Add Content Security Policy to index.html
status: done
priority: critical
assignee: haiku
blocked_by: []
---

# Add Content Security Policy to index.html

Add a CSP meta tag to `index.html` that restricts resource loading to same-origin.

## Implementation

Add the following `<meta>` tag inside `<head>`, before the `<title>` tag:

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self';">
```

Notes:
- `'unsafe-inline'` is needed for `style-src` because CSS modules and Zustand/React inject inline styles
- `connect-src 'self'` allows the Vite HMR websocket in dev (same-origin) and XHR/fetch calls
- No `'unsafe-eval'` — none of the renderer code needs `eval()`
- `data:` for `img-src` to allow inline SVG data URIs (lucide-react icons)

## Files to touch
- `index.html` — add CSP meta tag in `<head>`
