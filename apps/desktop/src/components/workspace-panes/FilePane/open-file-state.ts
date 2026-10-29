/**
 * What a file pane knows about its open file, as pure transitions: whether
 * your copy has unsaved edits, which hash a save must find on disk, and
 * whether the conflict banner or the swap bar is up. The pane does the reads
 * and writes and feeds their results in here; `open-file-store` keeps one of
 * these per pane, so a remount (a split rebuilds the pane) keeps the edits.
 */

import type { FilesWorkspace } from "./open-file-watches";

/** Why the conflict banner is up. */
export type Conflict =
  /** The file on disk is not the one your edits started from. */
  | { kind: "changed"; diskHash: string }
  /** The file was deleted, or is now binary or too large to open. */
  | { kind: "gone" };

export type OpenFileState = {
  /** The workspace the file is in: its host and absolute path. */
  workspace: FilesWorkspace;
  /** Workspace-relative path of the open file. */
  path: string;
  status: "loading" | "ready" | "failed";
  /** Why the file can't be shown, when `failed`. */
  message: string | null;
  /** The content last read from or written to disk: the clean copy. */
  base: string;
  /**
   * Bumped whenever `base` should replace what the editor shows (a load, a
   * silent reload, Reload theirs), even when the text happens to be the same.
   */
  baseVersion: number;
  /**
   * The hash a save expects to find on disk. Null writes regardless: after
   * Keep mine over a deleted file, a save recreates it.
   */
  expectedHash: string | null;
  /** Your copy differs from `base`. */
  dirty: boolean;
  /** Your edited text, kept while the editor is unmounted. */
  draft: string | null;
  conflict: Conflict | null;
  /** A file picked while dirty, waiting on the swap bar's answer. */
  pendingOpen: string | null;
  saving: boolean;
  saveError: string | null;
  /**
   * A re-read under your edits failed for a reason other than the file being
   * gone (the host dropped, the file turned binary): says why, with Retry.
   * `expectedHash` stays as it was, so a save still refuses to overwrite.
   */
  readError: string | null;
  /** Bumped by each reload from disk; the header flashes on a change. */
  reloads: number;
  /** The Compare view (disk vs. your copy) is showing. */
  comparing: boolean;
};

export type OpenFileEvent =
  /** A read of the file answered. `reload` is Reload theirs: it drops your edits. */
  | { type: "read"; content: string; hash: string; reason: "open" | "changed" | "reload" }
  /**
   * A read of the file was refused (`reason` is the files API's) or threw
   * (no `reason`). Only `not-found` means the file is gone.
   */
  | { type: "read-failed"; message: string; reason?: string }
  /** `files.changed` said the file is gone (hash null) while you have edits. */
  | { type: "gone" }
  | { type: "edited"; dirty: boolean }
  | { type: "save-started" }
  /** `dirty`: whether you typed more while the save was in flight. */
  | { type: "saved"; content: string; hash: string; dirty: boolean }
  | { type: "save-conflict"; diskHash: string | null }
  | { type: "save-failed"; message: string }
  | { type: "keep-mine" }
  | { type: "compare"; on: boolean }
  | { type: "ask-before-open"; path: string }
  | { type: "cancel-open" }
  /** The editor is going away with unsaved edits; keep them. */
  | { type: "stash-draft"; draft: string }
  /**
   * Drop your edits without reading: the editor goes back to the clean copy
   * at once (`baseVersion` moves), so it never holds edits the store forgot.
   */
  | { type: "discard" };

/**
 * A file pane's state for `path`, before its first read. `reloads` carries on
 * from the pane's last file, so the header's flash only ever counts up.
 */
export function initialOpenFile(
  workspace: FilesWorkspace,
  path: string,
  reloads = 0,
): OpenFileState {
  return {
    workspace,
    path,
    status: "loading",
    message: null,
    base: "",
    baseVersion: 0,
    expectedHash: null,
    dirty: false,
    draft: null,
    conflict: null,
    pendingOpen: null,
    saving: false,
    saveError: null,
    readError: null,
    reloads,
    comparing: false,
  };
}

export function sameWorkspace(a: FilesWorkspace, b: FilesWorkspace): boolean {
  return a.hostId === b.hostId && a.path === b.path;
}

/**
 * The state a pane mounts with for `path` of `workspace`: the one it had,
 * when it still has unsaved edits to that same file of that same workspace,
 * else a fresh one. A draft never attaches to another worktree's file of the
 * same name.
 */
export function resumeOpenFile(
  prev: OpenFileState | undefined,
  workspace: FilesWorkspace,
  path: string,
): OpenFileState {
  if (
    prev &&
    prev.path === path &&
    sameWorkspace(prev.workspace, workspace) &&
    prev.dirty &&
    prev.draft !== null
  ) {
    return { ...prev, saving: false, comparing: false, pendingOpen: null };
  }
  return initialOpenFile(workspace, path, prev?.reloads ?? 0);
}

/**
 * What to do about a `files.changed` for the open file: nothing (it is the
 * file you already have, or your own save's echo), wait for the save in
 * flight to answer first, read it, or show that it is gone.
 */
export function diskChangeAction(
  state: OpenFileState,
  hash: string | null,
): "ignore" | "after-save" | "read" | "gone" {
  if (state.saving) return "after-save";
  if (hash !== null && hash === state.expectedHash) return "ignore";
  if (hash === null && state.dirty) return "gone";
  return "read";
}

export function openFileReducer(
  state: OpenFileState,
  event: OpenFileEvent,
): OpenFileState {
  switch (event.type) {
    case "read": {
      const keepEdits = state.dirty && event.reason !== "reload";
      if (keepEdits) {
        // Disk still holds what your edits started from: nothing to say.
        if (event.hash === state.expectedHash) {
          return { ...state, status: "ready", message: null, readError: null };
        }
        return {
          ...state,
          status: "ready",
          message: null,
          readError: null,
          conflict: { kind: "changed", diskHash: event.hash },
          pendingOpen: null,
        };
      }
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
        conflict: null,
        saveError: null,
        readError: null,
        comparing: false,
        reloads: event.reason === "open" ? state.reloads : state.reloads + 1,
      };
    }
    case "read-failed":
      if (state.dirty) {
        if (event.reason === "not-found") {
          return {
            ...state,
            status: "ready",
            readError: null,
            conflict: { kind: "gone" },
            pendingOpen: null,
            comparing: false,
          };
        }
        // Not proof the file is gone: keep the edits and the hash a save
        // must find, and offer the read again.
        return { ...state, status: "ready", readError: event.message };
      }
      return { ...state, status: "failed", message: event.message };
    case "gone":
      if (!state.dirty) return state;
      return { ...state, conflict: { kind: "gone" }, pendingOpen: null, comparing: false };
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
        conflict: null,
        saveError: null,
        readError: null,
        comparing: false,
      };
    case "save-conflict":
      return {
        ...state,
        saving: false,
        conflict:
          event.diskHash === null
            ? { kind: "gone" }
            : { kind: "changed", diskHash: event.diskHash },
        pendingOpen: null,
      };
    case "save-failed":
      return { ...state, saving: false, saveError: event.message, pendingOpen: null };
    case "keep-mine": {
      const conflict = state.conflict;
      if (!conflict) return state;
      return {
        ...state,
        conflict: null,
        comparing: false,
        // The next save overwrites what is on disk now, on purpose.
        expectedHash: conflict.kind === "changed" ? conflict.diskHash : null,
      };
    }
    case "compare":
      return { ...state, comparing: event.on };
    case "ask-before-open":
      if (!state.dirty) return state;
      return { ...state, pendingOpen: event.path };
    case "cancel-open":
      return { ...state, pendingOpen: null };
    case "stash-draft":
      return state.dirty ? { ...state, draft: event.draft } : state;
    case "discard":
      if (!state.dirty && state.draft === null) return state;
      return {
        ...state,
        dirty: false,
        draft: null,
        conflict: null,
        pendingOpen: null,
        readError: null,
        comparing: false,
        baseVersion: state.baseVersion + 1,
      };
  }
}
