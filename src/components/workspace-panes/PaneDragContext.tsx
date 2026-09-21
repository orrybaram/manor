import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { useLayoutMode } from "../../hooks/useLayoutMode";

export type DragPayload =
  | { type: "tab"; tabId: string; grabOffset?: { x: number; y: number } }
  | { type: "pane"; paneId: string; grabOffset?: { x: number; y: number } };

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

type PaneDragProviderProps = {
  children: ReactNode;
};

export function PaneDragProvider(props: PaneDragProviderProps) {
  const { children } = props;

  const layoutMode = useLayoutMode();
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const startDrag = useCallback(
    (payload: DragPayload) => {
      // ADR-181 D5: every tab/pane drag source gates its own `draggable`
      // attribute off in phone mode, so this should never fire there — but
      // this is the one chokepoint both a tab drag and a pane drag funnel
      // through, so it stays a defensive no-op rather than trusting every
      // future drag source to remember the gate itself.
      if (layoutMode === "phone") return;
      useDragOverlayStore.getState().incrementDragCount();
      setDrag(payload);
    },
    [layoutMode],
  );
  const endDrag = useCallback(() => {
    useDragOverlayStore.getState().decrementDragCount();
    setDrag(null);
  }, []);

  // Both tab and pane drags use native HTML5 DnD — the OS renders the drag
  // image, so there is no DOM ghost here. `drag` is still set during a drag so
  // pane drop zones render and highlight.
  return (
    <PaneDragContext.Provider value={{ drag, startDrag, endDrag }}>
      {children}
    </PaneDragContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePaneDrag() {
  return useContext(PaneDragContext);
}
