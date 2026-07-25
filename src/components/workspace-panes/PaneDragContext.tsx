import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useDragOverlayStore } from "../../store/drag-overlay-store";

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

  const [drag, setDrag] = useState<DragPayload | null>(null);
  const startDrag = useCallback((payload: DragPayload) => {
    useDragOverlayStore.getState().incrementDragCount();
    setDrag(payload);
  }, []);
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
