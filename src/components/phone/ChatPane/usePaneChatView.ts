import { useCallback } from "react";
import { create } from "zustand";
import { readChatView, writeChatView, type ChatView } from "./chat-view";

/**
 * Each pane's Chat | Terminal choice (ADR-215 D7), shared by the pane itself
 * (`LeafPane`, which shows one or the other) and the phone top bar's overflow
 * menu (which flips it). An entry is filled lazily from this browser's
 * storage the first time a pane is read, chat by default, and every change is
 * written back.
 */
type PaneChatViewState = {
  views: Record<string, ChatView>;
  /** Panes waiting on a new transcript, mapped to the one they leave behind
   *  (null for an agent the phone just started, the old one after `/clear`).
   *  They show a fresh chat until a different transcript lands. In memory
   *  only. */
  starting: Record<string, string | null>;
};

export const usePaneChatViewStore = create<PaneChatViewState>(() => ({
  views: {},
  starting: {},
}));

/** The pane's view: the stored choice, or what this browser remembers. */
function selectView(state: PaneChatViewState, paneId: string): ChatView {
  return state.views[paneId] ?? readChatView(paneId);
}

export function setPaneChatView(paneId: string, view: ChatView): void {
  usePaneChatViewStore.setState((s) =>
    s.views[paneId] === view ? s : { views: { ...s.views, [paneId]: view } },
  );
  writeChatView(paneId, view);
}

/**
 * Open `paneId` on a fresh chat until its transcript is something other than
 * `leaving`: a new agent starting up (null), or a session `/clear` replaced.
 */
export function markChatStarting(paneId: string, leaving: string | null = null): void {
  usePaneChatViewStore.setState((s) =>
    s.starting[paneId] === leaving ? s : { starting: { ...s.starting, [paneId]: leaving } },
  );
}

/** Whether `paneId`, now on `transcript`, still waits on a new one. */
export function usePaneChatStarting(paneId: string, transcript: string | null): boolean {
  return usePaneChatViewStore((s) => {
    if (!(paneId in s.starting)) return false;
    return transcript === null || transcript === s.starting[paneId];
  });
}

export function usePaneChatView(paneId: string): [ChatView, (view: ChatView) => void] {
  const view = usePaneChatViewStore((s) => selectView(s, paneId));
  const setView = useCallback((next: ChatView) => setPaneChatView(paneId, next), [paneId]);
  return [view, setView];
}
