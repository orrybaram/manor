---
title: Create the element picker injection script
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Create the element picker injection script

Write the JavaScript that gets injected into the webview to provide the hover-highlight + click-to-select element picker UX.

The script should:
1. Create a fixed-position overlay div that follows the hovered element's bounding box (colored border + semi-transparent background)
2. Listen for `mouseover` on `document` to track which element is under the cursor
3. On click, capture the element's metadata:
   - `outerHTML` (truncated to 2000 chars)
   - CSS selector path (`body > div.app > main > h1.title`)
   - Computed styles (color, background, font-size, font-family, padding, margin, display, position, width, height)
   - Bounding box (x, y, width, height)
   - Accessibility attributes (role, aria-label, aria-level, tabindex)
4. Attempt React fiber extraction: check for `__reactFiber$*` property on the element, walk up fiber tree for component names and `_debugSource`
5. Encode result as JSON and emit via `console.log('__MANOR_PICK__:' + json)`
6. Support `Escape` to cancel (emit `console.log('__MANOR_PICK_CANCEL__')`)
7. Clean up all event listeners and overlay elements on completion or cancel

## Files to touch
- `electron/picker-script.ts` — new file, the injectable script as a template literal export
