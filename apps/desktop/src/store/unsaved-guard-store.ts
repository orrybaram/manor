import { create } from "zustand";
import {
  dirtyPaneIds,
  holdOpenFilesForClose,
  saveWhenSettled,
  useOpenFileStore,
} from "./open-file-store";

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
  /**
   * No Cancel: what the edits are in has already gone (this window's tab
   * was taken from it), so only Save or Discard can answer, and a failed
   * Save leaves the confirm up.
   */
  mustAnswer: boolean;
};

/** Files with unsaved edits in another window that stopped a close here. */
type ElsewhereNotice = { verb: UnsavedGuardVerb; files: string[] };

type UnsavedGuardState = {
  request: UnsavedGuardRequest | null;
  /** Save was pressed and the writes have not all answered. */
  saving: boolean;
  /** "Unsaved changes in another window", with OK only. */
  elsewhere: ElsewhereNotice | null;
};

/**
 * The confirm that stands in front of anything that would take a file pane's
 * unsaved edits out of this window (moving the pane, converting it, closing
 * several tabs, removing its workspace). `UnsavedEditsDialog` draws it.
 */
export const useUnsavedGuardStore = create<UnsavedGuardState>(() => ({
  request: null,
  saving: false,
  elsewhere: null,
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
  { mustAnswer = false }: { mustAnswer?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const dirty = dirtyPaneIds(useOpenFileStore.getState(), paneIds);
    if (dirty.length === 0) {
      resolve(true);
      return;
    }
    // A newer question replaces one still open, which counts as a Cancel;
    // except one with no Cancel, which stays, and the newer one is refused.
    const open = useUnsavedGuardStore.getState().request;
    if (open?.mustAnswer) {
      resolve(false);
      return;
    }
    open?.settle(false);
    useUnsavedGuardStore.setState({
      saving: false,
      request: { verb, paneIds: dirty, settle: resolve, mustAnswer },
    });
  });
}

/**
 * The confirm's answer. Save writes every file (after any save already
 * under way) and goes ahead only once none of them has unsaved edits left;
 * a refused write (the file changed under you) leaves its banner in the
 * pane and the request cancelled, or, with no Cancel to fall back on, the
 * confirm up. Typing that landed during the write keeps the confirm up,
 * naming what is still unsaved. Discard drops the edits.
 */
export async function answerUnsavedGuard(answer: "save" | "discard" | "cancel"): Promise<void> {
  const guard = useUnsavedGuardStore.getState();
  const request = guard.request;
  if (!request || guard.saving) return;
  if (answer === "cancel" && request.mustAnswer) return;
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
  const results = await Promise.all(request.paneIds.map((paneId) => saveWhenSettled(paneId)));
  if (results.every(Boolean)) {
    finish(true);
    return;
  }
  const left = dirtyPaneIds(useOpenFileStore.getState(), request.paneIds);
  const failed = request.paneIds.some((paneId) => {
    const file = useOpenFileStore.getState().byPane[paneId];
    return file?.conflict || file?.saveError;
  });
  if (failed && !request.mustAnswer) {
    finish(false);
    return;
  }
  // Still unsaved, but nothing refused (typed during the write), or there
  // is no Cancel: ask again about what is left.
  if (useUnsavedGuardStore.getState().request !== request) return;
  useUnsavedGuardStore.setState({ saving: false, request: { ...request, paneIds: left } });
}

/** The "Unsaved changes in another window" notice was read. */
export function dismissElsewhereNotice(): void {
  useUnsavedGuardStore.setState({ elsewhere: null });
}

/**
 * Whether closing `paneIds` needs nothing asked: none has unsaved edits
 * here, and none is a file pane (`filePanesOf`) that another window might
 * hold unsaved edits in.
 */
export function closesWithoutAsking(
  paneIds: readonly string[],
  filePanesOf: (paneIds: readonly string[]) => string[],
): boolean {
  return (
    filePanesOf(paneIds).length === 0 &&
    dirtyPaneIds(useOpenFileStore.getState(), paneIds).length === 0
  );
}

/** Those of `paneIds` with unsaved edits in another window, by the main process. */
async function unsavedElsewhere(
  paneIds: readonly string[],
): Promise<{ paneId: string; path: string }[]> {
  const ask = window.electronAPI?.window?.unsavedPanesElsewhere;
  if (!ask) return [];
  try {
    return await ask([...paneIds]);
  } catch (err) {
    console.error("[unsaved-guard] could not ask about other windows:", err);
    return [];
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Whether the panes `panesNow()` names may close (or have their workspace
 * removed or merged). Any with unsaved edits in another window stop it
 * there, with the notice: this window can neither show nor save them. Any
 * with unsaved edits here ask Save / Discard / Cancel. The set is read
 * again after every wait (a tab opened during a Save is in it, and is
 * checked too), so what finally goes ahead is exactly what was checked.
 */
export async function settleClosingPanes(
  panesNow: () => readonly string[],
  verb: UnsavedGuardVerb,
  filePanesOf: (paneIds: readonly string[]) => string[],
): Promise<boolean> {
  for (;;) {
    const paneIds = panesNow();
    const filePanes = filePanesOf(paneIds);
    if (filePanes.length > 0) {
      const elsewhere = await unsavedElsewhere(filePanes);
      if (elsewhere.length > 0) {
        useUnsavedGuardStore.setState({
          elsewhere: { verb, files: elsewhere.map((file) => file.path) },
        });
        return false;
      }
      // Changed while main answered: check the new set from the top.
      if (!sameIds(panesNow(), paneIds)) continue;
    }
    if (dirtyPaneIds(useOpenFileStore.getState(), paneIds).length === 0) return true;
    if (!(await confirmUnsavedEdits(paneIds, verb))) return false;
  }
}

/**
 * `settleClosingPanes`, then `proceed`: synchronously, when nothing needs
 * asking.
 */
export function guardClosingPanes(
  panesNow: () => readonly string[],
  verb: UnsavedGuardVerb,
  filePanesOf: (paneIds: readonly string[]) => string[],
  proceed: () => void,
): void {
  if (closesWithoutAsking(panesNow(), filePanesOf)) {
    proceed();
    return;
  }
  void settleClosingPanes(panesNow, verb, filePanesOf).then((go) => {
    if (go) proceed();
  });
}

/** Set once this window is closing over a lost tab's unsaved edits. */
let closingOverLostTab = false;

/**
 * This (detached) window lost its tab, to another window's claim or to a
 * close elsewhere, and so closes (`close`). Its file panes' unsaved edits
 * would die with it: ask once, Save or Discard (there is nothing left to
 * Cancel back to), then close. Later calls while it asks do nothing, so a
 * stream of replica changes asks once, not once each.
 */
export function closeOverLostTab(close: () => void): void {
  if (closingOverLostTab) return;
  const files = useOpenFileStore.getState();
  const dirty = dirtyPaneIds(files, Object.keys(files.byPane));
  if (dirty.length === 0) {
    close();
    return;
  }
  closingOverLostTab = true;
  holdOpenFilesForClose(dirty);
  void confirmUnsavedEdits(dirty, "close", { mustAnswer: true }).then(close);
}
