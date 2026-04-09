---
title: Create webview host store
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Create webview host store

Create a small Zustand store that tracks webview slot rects and visibility, enabling the WebviewHost to position webviews over their pane slots.

## Implementation

Create `src/store/webview-host-store.ts`:

```typescript
import { create } from "zustand";

interface SlotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface WebviewSlotState {
  slots: Record<string, { rect: SlotRect; visible: boolean }>;
  setSlotRect: (paneId: string, rect: SlotRect) => void;
  setSlotVisible: (paneId: string, visible: boolean) => void;
  removeSlot: (paneId: string) => void;
}
```

- `setSlotRect(paneId, rect)` — called by WebviewSlot's ResizeObserver callback
- `setSlotVisible(paneId, visible)` — called when tab visibility changes or pane is being dragged
- `removeSlot(paneId)` — called when a browser pane is closed/removed

Keep the store minimal. No selectors needed beyond direct `slots[paneId]` access.

## Files to touch
- `src/store/webview-host-store.ts` — new file, create the store
