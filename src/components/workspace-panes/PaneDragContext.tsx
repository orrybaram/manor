import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { PaneDragGhost } from "./PaneDragGhost";

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
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const startDrag = useCallback((payload: DragPayload) => {
    useDragOverlayStore.getState().incrementDragCount();
    setDrag(payload);
  }, []);
  const endDrag = useCallback(() => {
    useDragOverlayStore.getState().decrementDragCount();
    setDrag(null);
  }, []);

  // Track cursor globally during drag
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      setCursorPos({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, [drag]);

  const ghostX = cursorPos.x - (drag?.grabOffset?.x ?? 0);
  const ghostY = cursorPos.y - (drag?.grabOffset?.y ?? 0);

  return (
    <PaneDragContext.Provider value={{ drag, startDrag, endDrag }}>
      {children}
      {/* Tab drags use native HTML5 DnD — the OS renders the drag image, so no
          DOM ghost here. `drag.type === "tab"` is still set (so pane drop zones
          render), it just has no floating visual of its own. Pane drags keep
          their DOM ghost; they never leave the window. */}
      {drag?.type === "pane" && (
        <PaneDragGhost paneId={drag.paneId} x={ghostX} y={ghostY} />
      )}
    </PaneDragContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePaneDrag() {
  return useContext(PaneDragContext);
}
