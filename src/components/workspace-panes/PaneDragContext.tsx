import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useDragOverlayStore } from "../../store/drag-overlay-store";

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
  return (
    <PaneDragContext.Provider value={{ drag, startDrag, endDrag }}>
      {children}
    </PaneDragContext.Provider>
  );
}

export function usePaneDrag() {
  return useContext(PaneDragContext);
}
