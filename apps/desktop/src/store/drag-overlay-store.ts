import { create } from "zustand";

interface DragOverlayState {
  dragCount: number;
  incrementDragCount: () => void;
  decrementDragCount: () => void;
}

export const selectIsDragActive = (state: DragOverlayState) =>
  state.dragCount > 0;

export const useDragOverlayStore = create<DragOverlayState>((set) => ({
  dragCount: 0,

  incrementDragCount: () => set((s) => ({ dragCount: s.dragCount + 1 })),

  decrementDragCount: () =>
    set((s) => ({ dragCount: Math.max(0, s.dragCount - 1) })),
}));
