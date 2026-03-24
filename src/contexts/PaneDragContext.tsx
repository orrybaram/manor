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
