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
};

export const usePaneChatViewStore = create<PaneChatViewState>(() => ({
  views: {},
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

export function usePaneChatView(paneId: string): [ChatView, (view: ChatView) => void] {
  const view = usePaneChatViewStore((s) => selectView(s, paneId));
  const setView = useCallback((next: ChatView) => setPaneChatView(paneId, next), [paneId]);
  return [view, setView];
}
