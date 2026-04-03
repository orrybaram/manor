---
title: Expose zoom methods on BrowserPane ref and add toolbar controls
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Expose zoom methods on BrowserPane ref and add toolbar controls

Wire the IPC zoom methods through BrowserPane's imperative ref and add zoom buttons to the LeafPane toolbar.

## Implementation

### BrowserPane (`src/components/BrowserPane.tsx`)

Add `zoomIn()`, `zoomOut()`, `zoomReset()` to the `BrowserPaneRef` interface and `useImperativeHandle`:

```typescript
// In BrowserPaneRef interface:
zoomIn(): void;
zoomOut(): void;
zoomReset(): void;

// In useImperativeHandle:
zoomIn() {
  window.electronAPI.webview.zoomIn(paneId);
},
zoomOut() {
  window.electronAPI.webview.zoomOut(paneId);
},
zoomReset() {
  window.electronAPI.webview.zoomReset(paneId);
},
```

### LeafPane (`src/components/LeafPane.tsx`)

Add zoom buttons to the browser nav controls, between the picker button and the pane actions (split/close). Use `ZoomIn` and `ZoomOut` icons from lucide-react:

```tsx
import { ZoomIn, ZoomOut } from "lucide-react";

// In the paneNavControls div, after the picker button:
<Tooltip label="Zoom in">
  <button
    className={styles.paneStatusBtn}
    onClick={() => browserRef.current?.zoomIn()}
    title="Zoom in"
  >
    <ZoomIn size={12} />
  </button>
</Tooltip>
<Tooltip label="Zoom out">
  <button
    className={styles.paneStatusBtn}
    onClick={() => browserRef.current?.zoomOut()}
    title="Zoom out"
  >
    <ZoomOut size={12} />
  </button>
</Tooltip>
```

## Files to touch
- `src/components/BrowserPane.tsx` — Add zoom methods to ref interface and imperative handle
- `src/components/LeafPane.tsx` — Add zoom buttons to browser toolbar
