/**
 * What a file pane knows about its open file, as pure transitions: whether
 * your copy has unsaved edits, which hash a save must find on disk, and
 * whether the swap bar is up. The pane does the reads
 * and writes and feeds their results in here; `open-file-store` keeps one of
 * these per pane, so a remount (a split rebuilds the pane) keeps the edits.
 */

export type OpenFileState = {
  /** Workspace-relative path of the open file. */
  path: string;
  status: "loading" | "ready" | "failed";
  /** Why the file can't be shown, when `failed`. */
  message: string | null;
  /** The content last read from or written to disk: the clean copy. */
  base: string;
  /**
   * Bumped whenever `base` should replace what the editor shows (a load or a
   * reload), even when the text happens to be the same.
   */
  baseVersion: number;
  /** The hash a save expects to find on disk. */
  expectedHash: string | null;
  /** Your copy differs from `base`. */
  dirty: boolean;
  /** Your edited text, kept while the editor is unmounted. */
  draft: string | null;
  /** A file picked while dirty, waiting on the swap bar's answer. */
  pendingOpen: string | null;
  saving: boolean;
  saveError: string | null;
};

export type OpenFileEvent =
  /** A read of the file answered. */
  | { type: "read"; content: string; hash: string; reason: "open" | "changed" }
  /** A read of the file was refused or failed. */
  | { type: "read-failed"; message: string }
  | { type: "edited"; dirty: boolean }
  | { type: "save-started" }
  /** `dirty`: whether you typed more while the save was in flight. */
  | { type: "saved"; content: string; hash: string; dirty: boolean }
  | { type: "save-failed"; message: string }
  | { type: "ask-before-open"; path: string }
  | { type: "cancel-open" }
  /** The editor is going away with unsaved edits; keep them. */
  | { type: "stash-draft"; draft: string }
  /** Drop your edits without reading (Discard in the swap bar). */
  | { type: "discard" };

/** A file pane's state for `path`, before its first read. */
export function initialOpenFile(path: string): OpenFileState {
  return {
    path,
    status: "loading",
    message: null,
    base: "",
    baseVersion: 0,
    expectedHash: null,
    dirty: false,
    draft: null,
    pendingOpen: null,
    saving: false,
    saveError: null,
  };
}

/**
 * The state a pane mounts with for `path`: the one it had, when it still has
 * unsaved edits to that file, else a fresh one.
 */
export function resumeOpenFile(
  prev: OpenFileState | undefined,
  path: string,
): OpenFileState {
  if (prev && prev.path === path && prev.dirty && prev.draft !== null) {
    return { ...prev, saving: false, pendingOpen: null };
  }
  return initialOpenFile(path);
}

/**
 * What to do about a `files.changed` for the open file: nothing (it is the
 * file you already have, or your own save's echo), wait for the save in
 * flight to answer first, or read it.
 */
export function diskChangeAction(
  state: OpenFileState,
  hash: string | null,
): "ignore" | "after-save" | "read" {
  if (state.saving) return "after-save";
  if (hash !== null && hash === state.expectedHash) return "ignore";
  return "read";
}

export function openFileReducer(
  state: OpenFileState,
  event: OpenFileEvent,
): OpenFileState {
  switch (event.type) {
    case "read": {
      // Your edits stay; a save then finds the file changed and says so.
      if (state.dirty) return { ...state, status: "ready", message: null };
      // A change that reads back as what we already show is no reload.
      if (
        event.reason === "changed" &&
        state.status === "ready" &&
        event.hash === state.expectedHash
      ) {
        return state;
      }
      return {
        ...state,
        status: "ready",
        message: null,
        base: event.content,
        baseVersion: state.baseVersion + 1,
        expectedHash: event.hash,
        dirty: false,
        draft: null,
        saveError: null,
      };
    }
    case "read-failed":
      // Your edits stay over a file that can no longer be read.
      if (state.dirty) return state;
      return { ...state, status: "failed", message: event.message };
    case "edited":
      if (event.dirty === state.dirty) return state;
      return { ...state, dirty: event.dirty, saveError: event.dirty ? state.saveError : null };
    case "save-started":
      return { ...state, saving: true, saveError: null };
    case "saved":
      return {
        ...state,
        saving: false,
        base: event.content,
        expectedHash: event.hash,
        dirty: event.dirty,
        draft: null,
        saveError: null,
      };
    case "save-failed":
      return { ...state, saving: false, saveError: event.message, pendingOpen: null };
    case "ask-before-open":
      if (!state.dirty) return state;
      return { ...state, pendingOpen: event.path };
    case "cancel-open":
      return { ...state, pendingOpen: null };
    case "stash-draft":
      return state.dirty ? { ...state, draft: event.draft } : state;
    case "discard":
      return { ...state, dirty: false, draft: null, pendingOpen: null };
  }
}
