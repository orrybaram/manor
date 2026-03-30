---
title: Add browser keyboard shortcuts (zoom, reload, URL focus)
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Add browser keyboard shortcuts (zoom, reload, URL focus)

Add keybindings for browser-specific actions and wire them in App.tsx with conditional routing based on focused pane type.

## Implementation

### Keybinding definitions (`src/lib/keybindings.ts`)

Add a new `"browser"` category to `KeybindingCategory` and `CATEGORY_LABELS`/`CATEGORY_ORDER`. Add these default keybindings:

```typescript
// In CATEGORY_LABELS:
browser: "Browser",

// In CATEGORY_ORDER (add before "app"):
"browser",

// In DEFAULT_KEYBINDINGS:
{
  id: "browser-zoom-in",
  label: "Browser Zoom In",
  defaultCombo: metaCombo("="),
  category: "browser",
},
{
  id: "browser-zoom-out",
  label: "Browser Zoom Out",
  defaultCombo: metaCombo("-"),
  category: "browser",
},
{
  id: "browser-zoom-reset",
  label: "Browser Zoom Reset",
  defaultCombo: metaCombo("0"),
  category: "browser",
},
{
  id: "browser-reload",
  label: "Browser Reload",
  defaultCombo: metaCombo("r"),
  category: "browser",
},
{
  id: "browser-focus-url",
  label: "Focus URL Bar",
  defaultCombo: metaCombo("l"),
  category: "browser",
},
```

### URL bar data attribute (`src/components/LeafPane.tsx`)

Add `data-pane-url-input={paneId}` to the URL `<input>` element so App.tsx can find it.

### App.tsx handler wiring (`src/App.tsx`)

These browser shortcuts share key combos with app/native menu actions (Cmd+Plus/Minus/0 is app zoom, Cmd+R is terminal reverse search). The handler must be conditional:

1. Look up the focused pane's content type from `paneContentType`.
2. If the focused pane is a browser pane, handle the browser action and `preventDefault()`.
3. If not a browser pane, do NOT call `preventDefault()` — let the event propagate to native menu handlers or terminal.

For the zoom/reload/URL shortcuts, the handlers need access to the focused browser pane's `BrowserPaneRef`. Since refs are local to LeafPane, use a registry pattern:

Create a simple module `src/lib/browser-pane-registry.ts`:

```typescript
import type { BrowserPaneRef } from "../components/BrowserPane";

const registry = new Map<string, BrowserPaneRef>();

export function registerBrowserPane(paneId: string, ref: BrowserPaneRef) {
  registry.set(paneId, ref);
}

export function unregisterBrowserPane(paneId: string) {
  registry.delete(paneId);
}

export function getBrowserPaneRef(paneId: string): BrowserPaneRef | undefined {
  return registry.get(paneId);
}
```

In `LeafPane.tsx`, register/unregister the browserRef when it changes.

In `App.tsx`, add to handlersRef:

```typescript
"browser-zoom-in": () => { /* get focused browser ref, call zoomIn() */ },
"browser-zoom-out": () => { /* get focused browser ref, call zoomOut() */ },
"browser-zoom-reset": () => { /* get focused browser ref, call zoomReset() */ },
"browser-reload": () => { /* get focused browser ref, call reload() */ },
"browser-focus-url": () => { /* querySelector for data-pane-url-input, focus it */ },
```

The keydown handler in App.tsx needs modification: for browser-* commands, check if the focused pane is a browser. If not, skip `preventDefault()` and `return` without executing, so the native menu (app zoom) or terminal can handle it.

### Important edge case: Cmd+0 conflict with select-session keybinding

Currently `select-session-1` through `select-session-9` use Cmd+1 through Cmd+9. `Cmd+0` is NOT bound as `select-session-0` (only 1-9 exist). So `browser-zoom-reset` with `Cmd+0` doesn't conflict with session selection.

However, `Cmd+0` IS the native app zoom reset (in the Electron menu). The conditional handler must ensure that when a browser pane is focused, `Cmd+0` resets that webview's zoom, and when a terminal is focused, it resets app zoom via the native menu.

Similarly, `browser-zoom-in` (`Cmd+=`) and `browser-zoom-out` (`Cmd+-`) need the same conditional behavior.

## Files to touch
- `src/lib/keybindings.ts` — Add browser category and 5 new keybinding definitions
- `src/lib/browser-pane-registry.ts` — New file: simple Map-based registry for BrowserPaneRef instances
- `src/components/LeafPane.tsx` — Register/unregister browser refs, add data attribute to URL input
- `src/App.tsx` — Add browser handlers with conditional routing in keydown handler
