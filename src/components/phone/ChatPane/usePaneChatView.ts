import { useCallback } from "react";
import { create } from "zustand";
import type { ChatEntry } from "../../../electron.d";
import { readChatView, writeChatView, type ChatView } from "./chat-view";
import { endsMenuHandoff, liveMenuHandoff, type MenuHandoff } from "./menu-handoff";

/**
 * Each pane's Chat | Terminal choice (ADR-215 D7), shared by the pane itself
 * (`LeafPane`, which shows one or the other) and the phone top bar's overflow
 * menu (which flips it). An entry is filled lazily from this browser's
 * storage the first time a pane is read, chat by default, and every change is
 * written back.
 *
 * A menu handoff (ADR-218 D3) lies over that choice: while one is live the
 * pane shows the terminal, and the stored choice is never touched, so a
 * reload mid-handoff comes back on the chat.
 */
type PaneChatViewState = {
  views: Record<string, ChatView>;
  /** Panes waiting on a new transcript, mapped to the one they leave behind
   *  (null for an agent the phone just started, the old one after `/clear`).
   *  They show a fresh chat until a different transcript lands. In memory
   *  only. */
  starting: Record<string, string | null>;
  /** The prompt a starting pane was launched with, shown until its
   *  transcript lands. In memory only. */
  startingPrompts: Record<string, string>;
  /** Panes showing the terminal for a TUI menu the chat sent (ADR-218 D3),
   *  until the menu's command lands in the transcript, the transcript
   *  changes, or the user goes back. In memory only. */
  handoffs: Record<string, MenuHandoff>;
};

export const usePaneChatViewStore = create<PaneChatViewState>(() => ({
  views: {},
  starting: {},
  startingPrompts: {},
  handoffs: {},
}));

/**
 * The view `paneId` shows while on `transcript`: the terminal under a live
 * menu handoff, otherwise the stored choice, or what this browser remembers.
 */
export function selectPaneChatView(
  state: PaneChatViewState,
  paneId: string,
  transcript: string | null,
): ChatView {
  if (liveMenuHandoff(state.handoffs[paneId], transcript)) return "terminal";
  return state.views[paneId] ?? readChatView(paneId);
}

/** Store `paneId`'s Chat | Terminal choice, here and in this browser. */
export function setPaneChatView(paneId: string, view: ChatView): void {
  usePaneChatViewStore.setState((s) =>
    s.views[paneId] === view ? s : { views: { ...s.views, [paneId]: view } },
  );
  writeChatView(paneId, view);
}

/**
 * Open `paneId` on a fresh chat until its transcript is something other than
 * `leaving`: a new agent starting up (null), or a session `/clear` replaced.
 * `prompt` is what the agent was launched with, shown while it starts.
 */
export function markChatStarting(
  paneId: string,
  leaving: string | null = null,
  prompt: string | null = null,
): void {
  usePaneChatViewStore.setState((s) => {
    const { [paneId]: _old, ...startingPrompts } = s.startingPrompts;
    if (prompt !== null) startingPrompts[paneId] = prompt;
    return { starting: { ...s.starting, [paneId]: leaving }, startingPrompts };
  });
}

/** The prompt `paneId` was launched with while it starts, if any. */
export function useStartingPrompt(paneId: string): string | null {
  return usePaneChatViewStore((s) => s.startingPrompts[paneId] ?? null);
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
 * D3), sent from the chat of `transcript`. A fresh chat has none of its own
 * and is still on the one it is leaving. The key bar shows until
 * `endMenuHandoff` or a different transcript.
 */
export function startMenuHandoff(paneId: string, name: string, transcript: string | null): void {
  usePaneChatViewStore.setState((s) => {
    const on = transcript ?? s.starting[paneId] ?? null;
    return { handoffs: { ...s.handoffs, [paneId]: { name, startedAt: Date.now(), transcript: on } } };
  });
}

/** End `paneId`'s menu handoff, revealing the view underneath. */
export function endMenuHandoff(paneId: string): void {
  usePaneChatViewStore.setState((s) => {
    if (!(paneId in s.handoffs)) return s;
    const { [paneId]: _ended, ...handoffs } = s.handoffs;
    return { handoffs };
  });
}

/**
 * Entries the chat of `transcript` just received for `paneId`: a handoff
 * from another transcript is over, and one whose command landed has closed.
 */
export function noteChatEntries(
  paneId: string,
  transcript: string,
  entries: readonly ChatEntry[],
): void {
  const handoff = usePaneChatViewStore.getState().handoffs[paneId];
  if (!handoff) return;
  if (handoff.transcript !== transcript || entries.some((e) => endsMenuHandoff(handoff, e))) {
    endMenuHandoff(paneId);
  }
}

/** `paneId`'s live menu handoff while on `transcript`, or null. */
export function usePaneMenuHandoff(paneId: string, transcript: string | null): MenuHandoff | null {
  return usePaneChatViewStore((s) => liveMenuHandoff(s.handoffs[paneId], transcript));
}

/**
 * `paneId`'s view while on `transcript`, and a setter for the stored choice
 * (which a live handoff still covers).
 */
export function usePaneChatView(
  paneId: string,
  transcript: string | null,
): [ChatView, (view: ChatView) => void] {
  const view = usePaneChatViewStore((s) => selectPaneChatView(s, paneId, transcript));
  const setView = useCallback((next: ChatView) => setPaneChatView(paneId, next), [paneId]);
  return [view, setView];
}
