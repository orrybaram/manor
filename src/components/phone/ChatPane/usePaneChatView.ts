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
  /** Panes showing the terminal for a TUI menu the chat sent (ADR-218 D3),
   *  until the menu's command lands in the transcript or the user goes back.
   *  In memory only. */
  handoffs: Record<string, MenuHandoff>;
};

/** A menu command the chat sent and handed to the terminal (ADR-218 D3). */
export type MenuHandoff = {
  /** The command's name, without the `/`. */
  name: string;
  /** When it was sent, in ms since the epoch. */
  startedAt: number;
};

export const usePaneChatViewStore = create<PaneChatViewState>(() => ({
  views: {},
  starting: {},
  handoffs: {},
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

/**
 * Hand `paneId` to the terminal for the menu `/name` opens there (ADR-218
 * D3). The key bar shows until `endMenuHandoff`.
 */
export function startMenuHandoff(paneId: string, name: string): void {
  usePaneChatViewStore.setState((s) => ({
    handoffs: { ...s.handoffs, [paneId]: { name, startedAt: Date.now() } },
  }));
  setPaneChatView(paneId, "terminal");
}

/**
 * End `paneId`'s menu handoff, and with `returnToChat` show its chat again.
 * A no-op when it has none, so the view a user chose is left alone.
 */
export function endMenuHandoff(paneId: string, opts?: { returnToChat?: boolean }): void {
  if (!(paneId in usePaneChatViewStore.getState().handoffs)) return;
  usePaneChatViewStore.setState((s) => {
    const { [paneId]: _ended, ...handoffs } = s.handoffs;
    return { handoffs };
  });
  if (opts?.returnToChat) setPaneChatView(paneId, "chat");
}

/** `paneId`'s menu handoff, or null. */
export function usePaneMenuHandoff(paneId: string): MenuHandoff | null {
  return usePaneChatViewStore((s) => s.handoffs[paneId] ?? null);
}

export function usePaneChatView(paneId: string): [ChatView, (view: ChatView) => void] {
  const view = usePaneChatViewStore((s) => selectView(s, paneId));
  const setView = useCallback((next: ChatView) => setPaneChatView(paneId, next), [paneId]);
  return [view, setView];
}
