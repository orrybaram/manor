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
  /** Panes whose Claude agent a phone just started: they open on the chat
   *  while Claude boots, before its transcript is known. In memory only. */
  starting: Record<string, true>;
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

/** Open `paneId` on its chat while its new agent starts up. */
export function markChatStarting(paneId: string): void {
  usePaneChatViewStore.setState((s) =>
    s.starting[paneId] ? s : { starting: { ...s.starting, [paneId]: true } },
  );
}

export function usePaneChatStarting(paneId: string): boolean {
  return usePaneChatViewStore((s) => s.starting[paneId] === true);
}

export function usePaneChatView(paneId: string): [ChatView, (view: ChatView) => void] {
  const view = usePaneChatViewStore((s) => selectView(s, paneId));
  const setView = useCallback((next: ChatView) => setPaneChatView(paneId, next), [paneId]);
  return [view, setView];
}
