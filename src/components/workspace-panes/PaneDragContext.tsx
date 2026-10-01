import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { useLayoutMode } from "../../hooks/useLayoutMode";

export type DragPayload =
  | { type: "tab"; tabId: string; grabOffset?: { x: number; y: number } }
  | { type: "pane"; paneId: string; grabOffset?: { x: number; y: number } };

interface PaneDragContextValue {
  drag: DragPayload | null;
  /** Whether tabs and panes can be dragged at all. Every drag source gates
   *  its `draggable` attribute on this; nothing else needs to check, since a
   *  drop target only mounts while a drag is live. */
  dragEnabled: boolean;
  startDrag: (payload: DragPayload) => void;
  endDrag: () => void;
}

const PaneDragContext = createContext<PaneDragContextValue>({
  drag: null,
  dragEnabled: false,
  startDrag: () => {},
  endDrag: () => {},
});

type PaneDragProviderProps = {
  children: ReactNode;
};

export function PaneDragProvider(props: PaneDragProviderProps) {
  const { children } = props;

  // ADR-181 D5: a tab or pane drag is reorder, move-into-panel, drag-to-split
  // and detach-by-drag in one gesture — all off in phone mode rather than
  // half-starting under a thumb and fighting the page's own scroll and
  // long-press.
  const dragEnabled = useLayoutMode() === "desk";
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const startDrag = useCallback((payload: DragPayload) => {
    useDragOverlayStore.getState().incrementDragCount();
    setDrag(payload);
  }, []);
  const endDrag = useCallback(() => {
    useDragOverlayStore.getState().decrementDragCount();
    setDrag(null);
  }, []);

  const value = useMemo(
    () => ({ drag, dragEnabled, startDrag, endDrag }),
    [drag, dragEnabled, startDrag, endDrag],
  );

  // Both tab and pane drags use native HTML5 DnD — the OS renders the drag
  // image, so there is no DOM ghost here. `drag` is still set during a drag so
  // pane drop zones render and highlight.
  return (
    <PaneDragContext.Provider value={value}>
      {children}
    </PaneDragContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePaneDrag() {
  return useContext(PaneDragContext);
}
