import { create } from "zustand";
import type { DrawerMode } from "./FileDrawer/FileDrawer";

/** Whether a file pane's drawer is open, and the view it opens on. */
export type DrawerState = { open: boolean; mode: DrawerMode };

/**
 * Each file pane's drawer, kept by pane rather than by mount: moving the pane
 * to another panel or workspace remounts it, and it should come back as it
 * was. The pane drops its entry once it is closed.
 */
export const useFileDrawerState = create<{
  byPane: Record<string, DrawerState>;
  set: (paneId: string, next: DrawerState) => void;
  drop: (paneId: string) => void;
}>((set) => ({
  byPane: {},
  set: (paneId, next) => set((s) => ({ byPane: { ...s.byPane, [paneId]: next } })),
  drop: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s;
      const { [paneId]: _gone, ...rest } = s.byPane;
      return { byPane: rest };
    }),
}));
