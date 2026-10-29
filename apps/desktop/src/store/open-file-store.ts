import { create } from "zustand";
import {
  openFileReducer,
  resumeOpenFile,
  sameWorkspace,
  type OpenFileEvent,
  type OpenFileState,
} from "../components/workspace-panes/FilePane/open-file-state";
import type { FilesWorkspace } from "../components/workspace-panes/FilePane/open-file-watches";
import { ipcErrorMessage } from "../lib/ipc-error";

type OpenFileStore = {
  /** Each file pane's open file, by pane id. */
  byPane: Record<string, OpenFileState>;
  /** The pane mounts `path` of `workspace`: resume its unsaved edits to it, or start fresh. */
  open: (paneId: string, workspace: FilesWorkspace, path: string) => OpenFileState;
  dispatch: (paneId: string, event: OpenFileEvent) => void;
  /** The pane is gone, or is no longer a file pane; forget it. */
  drop: (paneId: string) => void;
};

/**
 * File panes' open-file state, outside React so that it outlives a remount
 * (splitting a pane rebuilds it) and the pane's header and the close-pane
 * confirm can read it.
 */
export const useOpenFileStore = create<OpenFileStore>((set, get) => ({
  byPane: {},
  open: (paneId, workspace, path) => {
    const next = resumeOpenFile(get().byPane[paneId], workspace, path);
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
  drop: (paneId) => {
    changesDuringSave.delete(paneId);
    set((s) => {
      if (!(paneId in s.byPane)) return s;
      const { [paneId]: _gone, ...rest } = s.byPane;
      return { byPane: rest };
    });
  },
}));

/** Whether `paneId` is a file pane with unsaved edits. */
export function hasUnsavedEdits(paneId: string): boolean {
  return useOpenFileStore.getState().byPane[paneId]?.dirty ?? false;
}

/** Those of `paneIds` that are file panes with unsaved edits, in order. */
export function dirtyPaneIds(
  state: Pick<OpenFileStore, "byPane">,
  paneIds: readonly string[],
): string[] {
  return paneIds.filter((paneId) => state.byPane[paneId]?.dirty);
}

/** The open file of every one of `paneIds` with unsaved edits, in order. */
export function unsavedFilesIn(
  state: Pick<OpenFileStore, "byPane">,
  paneIds: readonly string[],
): string[] {
  return dirtyPaneIds(state, paneIds).map((paneId) => state.byPane[paneId].path);
}

/** Every file with unsaved edits in this renderer, workspace-relative. */
export function allUnsavedFiles(state: Pick<OpenFileStore, "byPane">): string[] {
  return Object.values(state.byPane)
    .filter((file) => file.dirty)
    .map((file) => file.path);
}

/**
 * What a mounted file pane's editor answers, so a save started anywhere (⌘S,
 * the move or close confirm) writes what the editor shows, and settles the
 * editor whichever mount of the pane is there when the write answers.
 */
export type OpenFileEditor = {
  workspace: FilesWorkspace;
  path: string;
  /** What a save writes: the text, its line breaks and any BOM; null before the editor loads. */
  content(): string | null;
  /** `written` is now on disk. Returns whether the editor still differs from it. */
  markClean(written: string): boolean;
  /** A `files.changed` arrived while the save was in flight; judge it now. */
  diskChanged(hash: string | null): void;
};

const editors = new Map<string, OpenFileEditor>();
/** A change reported mid-save waits here until the save says what it wrote. */
const changesDuringSave = new Map<string, { hash: string | null }>();

/** The pane's editor is mounted; returns the unregister. */
export function registerOpenFileEditor(paneId: string, editor: OpenFileEditor): () => void {
  editors.set(paneId, editor);
  return () => {
    if (editors.get(paneId) === editor) editors.delete(paneId);
  };
}

/** `files.changed` for the pane's file while its save is in flight. */
export function noteDiskChangeDuringSave(paneId: string, hash: string | null): void {
  changesDuringSave.set(paneId, { hash });
}

/** The pane's mounted editor, if it shows `state`'s file. */
function editorFor(paneId: string, state: OpenFileState): OpenFileEditor | null {
  const editor = editors.get(paneId);
  return editor && editor.path === state.path && sameWorkspace(editor.workspace, state.workspace)
    ? editor
    : null;
}

/**
 * Save the pane's open file: what its editor shows, or, while it is not
 * mounted, its stashed draft. The write expects the hash last read or
 * written. Its answer goes to the store whatever became of the pane's mount
 * meanwhile (a split rebuilds it), so the next mount resumes with the hash
 * that is on disk now. Resolves to whether the file is now saved.
 */
export async function saveOpenFile(paneId: string): Promise<boolean> {
  const store = useOpenFileStore.getState;
  const started = store().byPane[paneId];
  if (!started || started.status !== "ready" || started.saving) return false;
  const content = editorFor(paneId, started)?.content() ?? started.draft;
  if (content === null) return !started.dirty;

  const { workspace, path } = started;
  const dispatch = (event: OpenFileEvent) => {
    // The pane may have moved on to another file while the write ran.
    const now = store().byPane[paneId];
    if (now && now.path === path && sameWorkspace(now.workspace, workspace)) {
      store().dispatch(paneId, event);
    }
  };

  dispatch({ type: "save-started" });
  let saved = false;
  try {
    const result = await window.electronAPI.files.write(
      workspace,
      path,
      content,
      started.expectedHash ?? undefined,
    );
    if (result.ok) {
      const now = store().byPane[paneId];
      const editor = now ? editorFor(paneId, now) : null;
      // Typed more while the write ran? Unmounted, the draft says so.
      const dirty = editor
        ? editor.markClean(content)
        : now?.draft != null && now.draft !== content;
      dispatch({ type: "saved", content, hash: result.hash, dirty });
      saved = true;
    } else if (result.reason === "changed-on-disk") {
      dispatch({ type: "save-conflict", diskHash: result.diskHash ?? null });
    } else {
      dispatch({ type: "save-failed", message: result.message });
    }
  } catch (err) {
    dispatch({ type: "save-failed", message: ipcErrorMessage(err) });
  }
  const pending = changesDuringSave.get(paneId);
  changesDuringSave.delete(paneId);
  if (pending) {
    const now = store().byPane[paneId];
    if (now) editorFor(paneId, now)?.diskChanged(pending.hash);
  }
  return saved;
}
