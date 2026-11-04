import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useAppStore } from "../../../store/app-store";
import { toast } from "../../../toast";
import { sendPromptToAgent, type AgentTarget } from "../../../lib/agent-send";
import {
  isEmptyNote,
  noteCountLabel,
  pageNotesPrompt,
  pageNotesReducer,
  pinLabels,
  type PageNote,
} from "../../../lib/page-notes";
import { LOCAL_HOST_ID, parseWorkspaceKey, type WorkspaceKey } from "../../../lib/workspace-key";
import type { PagePick, PagePinsLayout } from "../../../../electron/webview-pins";

export type PageNotes = {
  /** Every note with a pin on the page, in pin order, the one just picked included. */
  notes: PageNote[];
  /** The queue: what the pill counts and Send and Copy take. A new note joins once it has words or is saved. */
  kept: PageNote[];
  /** Where the current page's pins are, or null before it has reported any. */
  layout: PagePinsLayout | null;
  /** The note whose popover is open. */
  openId: string | null;
  /** Close the open note and keep it, even empty: a bare pin is one to look at. */
  saveOpen: () => void;
  /** Close the open note; a new one left empty goes. */
  skipOpen: () => void;
  /** Arm picking on the page; false if the page couldn't take it. */
  start: () => Promise<boolean>;
  stop: () => void;
  setNote: (id: string, note: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** The prompt on the clipboard, citing the screenshots where the workspace's agents run. */
  copy: () => Promise<void>;
  /** The prompt to an agent, with the screenshots on its host; then the queue empties. */
  send: (target: AgentTarget) => Promise<void>;
};

/** The pins' colours: Manor's accent, with its background for the number. */
function pinTheme(): { accent: string; bg: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim(),
    bg: style.getPropertyValue("--bg").trim(),
  };
}

/**
 * A browser pane's notes: picks the page reports become notes here, each
 * numbered by its place in the queue, and the page is told which pins to
 * draw. The queue outlives a navigation (each note keeps its URL); the pins
 * and their positions don't, since a new document starts without them.
 *
 * A pick only opens a new note. Left empty — by Escape, the next pick, another
 * pin or a navigation — it goes, so clicking around the page collects nothing.
 */
export function usePageNotes({
  paneId,
  webviewRef,
  workspaceKey,
  pageUrl,
  isPicking,
  onPickingChange,
}: {
  paneId: string;
  webviewRef: RefObject<HTMLElement | null>;
  workspaceKey?: WorkspaceKey;
  /** The page's URL as the pane names it, read when a pick lands. */
  pageUrl: () => string;
  /** Whether the user has picking armed; a pick that lands otherwise doesn't open its note. */
  isPicking: () => boolean;
  onPickingChange: (active: boolean) => void;
}): PageNotes {
  const [notes, dispatch] = useReducer(pageNotesReducer, []);
  const [layout, setLayout] = useState<PagePinsLayout | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // The note just picked and not yet saved, read at once by picks that land together.
  const newNoteIdRef = useRef<string | null>(null);
  const [newNoteId, setNewNoteId] = useState<string | null>(null);
  const trackNewNote = useCallback((id: string | null) => {
    newNoteIdRef.current = id;
    setNewNoteId(id);
  }, []);
  /** Done with the new note, unless it is `except`: empty, it goes. */
  const settleNewNote = useCallback(
    (except?: string) => {
      const id = newNoteIdRef.current;
      if (id === null || id === except) return;
      dispatch({ type: "drop-if-empty", id });
      trackNewNote(null);
    },
    [trackNewNote],
  );

  const kept = notes.filter((n) => n.id !== newNoteId || !isEmptyNote(n));
  const keptRef = useRef(kept);
  keptRef.current = kept;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const pageUrlRef = useRef(pageUrl);
  pageUrlRef.current = pageUrl;
  const isPickingRef = useRef(isPicking);
  isPickingRef.current = isPicking;
  const onPickingChangeRef = useRef(onPickingChange);
  onPickingChangeRef.current = onPickingChange;

  // The page draws what the queue holds; ids it never had are ignored there.
  // Keyed on the ids alone, so typing a note doesn't redraw the pins.
  const pinIds = notes.map((n) => n.id).join(" ");
  useEffect(() => {
    void window.electronAPI.webview.syncPins(paneId, pinLabels(notesRef.current));
  }, [paneId, pinIds]);

  useMountEffect(() => {
    const unsubPicked = window.electronAPI.webview.onPinPicked((pickPaneId: string, pick: PagePick) => {
      if (pickPaneId !== paneId) return;
      // What an agent can read as the pane's last pick.
      useAppStore.getState().setPickedElement(paneId, pick);
      // Landed after picking stopped: there is no note to open, so nothing to keep.
      if (!isPickingRef.current()) return;
      settleNewNote();
      dispatch({
        type: "add",
        note: {
          id: pick.pickId,
          url: pageUrlRef.current(),
          selector: pick.selector,
          outerHTML: pick.outerHTML,
          reactComponents: pick.reactComponents,
          note: "",
          screenshot: pick.screenshot,
        },
      });
      trackNewNote(pick.pickId);
      setOpenId(pick.pickId);
    });
    const unsubStopped = window.electronAPI.webview.onPinsStopped((stopPaneId: string) => {
      if (stopPaneId === paneId) onPickingChangeRef.current(false);
    });
    const unsubOpened = window.electronAPI.webview.onPinOpened((openPaneId: string, pinId: string) => {
      if (openPaneId !== paneId) return;
      if (!notesRef.current.some((n) => n.id === pinId)) return;
      settleNewNote(pinId);
      setOpenId(pinId);
    });
    const unsubMoved = window.electronAPI.webview.onPinsMoved(
      (movedPaneId: string, next: PagePinsLayout) => {
        if (movedPaneId === paneId) setLayout(next);
      },
    );

    // A new document has none of the page script: no pins, and no picking.
    const wv = webviewRef.current;
    const onNewDocument = () => {
      settleNewNote();
      setLayout(null);
      setOpenId(null);
      onPickingChangeRef.current(false);
    };
    wv?.addEventListener("did-navigate", onNewDocument);

    return () => {
      unsubPicked();
      unsubStopped();
      unsubOpened();
      unsubMoved();
      wv?.removeEventListener("did-navigate", onNewDocument);
    };
  });

  const start = useCallback(async () => {
    const started = await window.electronAPI.webview.startPins(paneId, pinTheme()).catch(() => false);
    if (started) {
      // Pins already in the queue from this document come back.
      void window.electronAPI.webview.syncPins(paneId, pinLabels(notesRef.current));
    }
    return started;
  }, [paneId]);

  const stop = useCallback(() => {
    void window.electronAPI.webview.stopPins(paneId);
  }, [paneId]);

  const setNote = useCallback((id: string, note: string) => dispatch({ type: "set-note", id, note }), []);
  const remove = useCallback(
    (id: string) => {
      dispatch({ type: "remove", id });
      if (newNoteIdRef.current === id) trackNewNote(null);
      setOpenId((open) => (open === id ? null : open));
    },
    [trackNewNote],
  );
  const clear = useCallback(() => {
    dispatch({ type: "clear" });
    trackNewNote(null);
    setOpenId(null);
  }, [trackNewNote]);
  const saveOpen = useCallback(() => {
    trackNewNote(null);
    setOpenId(null);
  }, [trackNewNote]);
  const skipOpen = useCallback(() => {
    settleNewNote();
    setOpenId(null);
  }, [settleNewNote]);

  /**
   * Each note's screenshot where the workspace's agents run: this machine's
   * own path, or a copy uploaded to its remote host. A failed upload has none.
   */
  const screenshotPaths = useCallback(
    async (list: PageNote[]): Promise<Record<string, string | undefined>> => {
      const hostId = workspaceKey ? parseWorkspaceKey(workspaceKey).hostId : LOCAL_HOST_ID;
      const paths = await Promise.all(
        list.map((n) =>
          n.screenshot
            ? window.electronAPI.webview.uploadPinShot(n.screenshot.id, hostId).catch(() => null)
            : null,
        ),
      );
      return Object.fromEntries(list.map((n, i) => [n.id, paths[i] ?? undefined]));
    },
    [workspaceKey],
  );

  const copy = useCallback(async () => {
    const list = keptRef.current;
    if (list.length === 0) return;
    const prompt = pageNotesPrompt(list, await screenshotPaths(list));
    void window.electronAPI.clipboard.writeText(prompt);
    toast.success(`Copied ${noteCountLabel(list.length)} to the clipboard`, {
      id: `page-notes-${paneId}`,
      duration: 3000,
    });
  }, [paneId, screenshotPaths]);

  const send = useCallback(
    async (target: AgentTarget) => {
      const list = keptRef.current;
      if (list.length === 0 || !workspaceKey) return;
      const { path: workspacePath, hostId } = parseWorkspaceKey(workspaceKey);
      const sent = sendPromptToAgent(workspacePath, pageNotesPrompt(list, await screenshotPaths(list)), target, {
        what: noteCountLabel(list.length),
        toastId: `page-notes-${paneId}`,
        hostId,
      });
      // Nothing went: the notes stay for another try.
      if (!sent) return;
      // Only what was sent: a pick that landed during the upload stays.
      for (const n of list) dispatch({ type: "remove", id: n.id });
      skipOpen();
    },
    [paneId, workspaceKey, screenshotPaths, skipOpen],
  );

  return { notes, kept, layout, openId, saveOpen, skipOpen, start, stop, setNote, remove, clear, copy, send };
}
