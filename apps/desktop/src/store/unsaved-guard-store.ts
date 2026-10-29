import { create } from "zustand";
import { dirtyPaneIds, saveOpenFile, useOpenFileStore } from "./open-file-store";

/**
 * What is about to happen to panes with unsaved edits, as the confirm's
 * buttons say it: "Save and move", "Discard and close", ….
 */
export type UnsavedGuardVerb = "move" | "convert" | "close" | "remove" | "merge";

type UnsavedGuardRequest = {
  verb: UnsavedGuardVerb;
  /** The panes among those affected that have unsaved edits. */
  paneIds: string[];
  /** Called once: true when the edits were saved or discarded, false on Cancel. */
  settle: (go: boolean) => void;
};

type UnsavedGuardState = {
  request: UnsavedGuardRequest | null;
  /** Save was pressed and the writes have not all answered. */
  saving: boolean;
};

/**
 * The confirm that stands in front of anything that would take a file pane's
 * unsaved edits out of this window (moving the pane, converting it, closing
 * several tabs, removing its workspace). `UnsavedEditsDialog` draws it.
 */
export const useUnsavedGuardStore = create<UnsavedGuardState>(() => ({
  request: null,
  saving: false,
}));

/**
 * Run `proceed` once none of `paneIds` has unsaved edits. With none, it runs
 * now, synchronously; otherwise the confirm asks Save / Discard / Cancel
 * first, and Cancel (or a failed save) never runs it.
 */
export function guardUnsavedEdits(
  paneIds: readonly string[],
  verb: UnsavedGuardVerb,
  proceed: () => void,
): void {
  if (dirtyPaneIds(useOpenFileStore.getState(), paneIds).length === 0) {
    proceed();
    return;
  }
  void confirmUnsavedEdits(paneIds, verb).then((go) => {
    if (go) proceed();
  });
}

/** `guardUnsavedEdits` as a promise: whether to go ahead. */
export function confirmUnsavedEdits(
  paneIds: readonly string[],
  verb: UnsavedGuardVerb,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dirty = dirtyPaneIds(useOpenFileStore.getState(), paneIds);
    if (dirty.length === 0) {
      resolve(true);
      return;
    }
    // A newer question replaces one still open, which counts as a Cancel.
    useUnsavedGuardStore.getState().request?.settle(false);
    useUnsavedGuardStore.setState({
      saving: false,
      request: { verb, paneIds: dirty, settle: resolve },
    });
  });
}

/**
 * The confirm's answer. Save writes every file and goes ahead only if all
 * of them saved; a refused write (the file changed under you) leaves its
 * banner in the pane and the request cancelled. Discard drops the edits.
 */
export async function answerUnsavedGuard(answer: "save" | "discard" | "cancel"): Promise<void> {
  const guard = useUnsavedGuardStore.getState();
  const request = guard.request;
  if (!request || guard.saving) return;
  const finish = (go: boolean) => {
    if (useUnsavedGuardStore.getState().request !== request) return;
    useUnsavedGuardStore.setState({ request: null, saving: false });
    request.settle(go);
  };
  if (answer === "cancel") {
    finish(false);
    return;
  }
  if (answer === "discard") {
    const files = useOpenFileStore.getState();
    for (const paneId of request.paneIds) files.dispatch(paneId, { type: "discard" });
    finish(true);
    return;
  }
  useUnsavedGuardStore.setState({ saving: true });
  const results = await Promise.all(request.paneIds.map((paneId) => saveOpenFile(paneId)));
  finish(results.every(Boolean));
}
