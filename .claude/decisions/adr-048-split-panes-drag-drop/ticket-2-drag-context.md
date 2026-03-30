---
title: Create PaneDragContext for cross-component drag coordination
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Create PaneDragContext for cross-component drag coordination

Create a React context that communicates drag state to all pane components. When a drag is active, LeafPanes need to know so they can render drop zone overlays.

## Implementation

Create `src/contexts/PaneDragContext.tsx`:

```typescript
import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type DragPayload =
  | { type: "tab"; sessionId: string }
  | { type: "pane"; paneId: string };

interface PaneDragContextValue {
  drag: DragPayload | null;
  startDrag: (payload: DragPayload) => void;
  endDrag: () => void;
}

const PaneDragContext = createContext<PaneDragContextValue>({
  drag: null,
  startDrag: () => {},
  endDrag: () => {},
});

export function PaneDragProvider({ children }: { children: ReactNode }) {
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const startDrag = useCallback((payload: DragPayload) => setDrag(payload), []);
  const endDrag = useCallback(() => setDrag(null), []);
  return (
    <PaneDragContext.Provider value={{ drag, startDrag, endDrag }}>
      {children}
    </PaneDragContext.Provider>
  );
}

export function usePaneDrag() {
  return useContext(PaneDragContext);
}
```

Wrap the app's workspace/session area with `<PaneDragProvider>`. The provider should go in the component that renders the workspace content — look at where `PaneLayout` is rendered from and wrap at that level.

Find where the session content and tab bar are rendered together (likely in `App.tsx` or a workspace layout component) and wrap with `<PaneDragProvider>`.

## Files to touch
- `src/contexts/PaneDragContext.tsx` — New file: drag context provider and hook
- Find and wrap the workspace layout parent component with `<PaneDragProvider>` (look for where `TabBar` and `PaneLayout` are both rendered)
