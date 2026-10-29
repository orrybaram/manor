import { create } from "zustand";
import {
  openFileReducer,
  resumeOpenFile,
  type OpenFileEvent,
  type OpenFileState,
} from "../components/workspace-panes/FilePane/open-file-state";

type OpenFileStore = {
  /** Each file pane's open file, by pane id. */
  byPane: Record<string, OpenFileState>;
  /** The pane mounts `path`: resume its unsaved edits to it, or start fresh. */
  open: (paneId: string, path: string) => OpenFileState;
  dispatch: (paneId: string, event: OpenFileEvent) => void;
  /** The pane is gone; forget it. */
  drop: (paneId: string) => void;
};

/**
 * File panes' open-file state, outside React so that it outlives a remount
 * (splitting a pane rebuilds it) and the pane's header and the close-pane
 * confirm can read it.
 */
export const useOpenFileStore = create<OpenFileStore>((set, get) => ({
  byPane: {},
  open: (paneId, path) => {
    const next = resumeOpenFile(get().byPane[paneId], path);
    set((s) => ({ byPane: { ...s.byPane, [paneId]: next } }));
    return next;
  },
  dispatch: (paneId, event) =>
    set((s) => {
      const prev = s.byPane[paneId];
      if (!prev) return s;
      const next = openFileReducer(prev, event);
      return next === prev ? s : { byPane: { ...s.byPane, [paneId]: next } };
    }),
  drop: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s;
      const { [paneId]: _gone, ...rest } = s.byPane;
      return { byPane: rest };
    }),
}));

/** Whether `paneId` is a file pane with unsaved edits. */
export function hasUnsavedEdits(paneId: string): boolean {
  return useOpenFileStore.getState().byPane[paneId]?.dirty ?? false;
}

/** The open file of the first of `paneIds` with unsaved edits, or null. */
export function unsavedFileIn(
  state: Pick<OpenFileStore, "byPane">,
  paneIds: readonly string[],
): string | null {
  for (const paneId of paneIds) {
    const file = state.byPane[paneId];
    if (file?.dirty) return file.path;
  }
  return null;
}
