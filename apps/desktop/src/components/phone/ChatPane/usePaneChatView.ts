import { useCallback } from "react";
import { create } from "zustand";
import type { ChatEntry } from "../../../electron.d";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { readChatView, writeChatView, type ChatView } from "./chat-view";
import { endsMenuHandoff, liveMenuHandoff, type MenuHandoff } from "./menu-handoff";

/**
 * Each pane's Chat | Terminal choice, shared by the pane itself
 * (`LeafPane`, which shows one or the other) and what flips it: the phone top
 * bar's overflow menu, and on the desk the pane header and its command. The
 * phone's and the desk's choices are kept apart. An entry is filled lazily
 * from this browser's storage the first time a pane is read (the phone
 * defaults to chat, the desk to the caller's default) and every change is
 * written back.
 *
 * A menu handoff lies over that choice: while one is live the
 * pane shows the terminal, and the stored choice is never touched, so a
 * reload mid-handoff comes back on the chat.
 */
type PaneChatViewState = {
  /** The phone's choices. */
  views: Record<string, ChatView>;
  /** The desk's choices. */
  deskViews: Record<string, ChatView>;
  /** Panes waiting on a new transcript, mapped to the one they leave behind
   *  (null for an agent the phone just started, the old one after `/clear`).
   *  They show a fresh chat until a different transcript lands. In memory
   *  only. */
  starting: Record<string, string | null>;
  /** The prompt a starting pane was launched with, shown until its
   *  transcript lands. In memory only. */
  startingPrompts: Record<string, string>;
  /** Panes showing the terminal for a TUI menu the chat sent,
   *  until the menu's command lands in the transcript, the transcript
   *  changes, or the user goes back. In memory only. */
  handoffs: Record<string, MenuHandoff>;
  /** Prompts sent mid-turn that the transcript doesn't hold yet: Claude Code
   *  writes a queued prompt only when the model can read it. Shown as queued
   *  until a user entry with the same text lands or the turn ends. In memory
   *  only. */
  queued: Record<string, string[]>;
};

export const usePaneChatViewStore = create<PaneChatViewState>(() => ({
  views: {},
  deskViews: {},
  starting: {},
  startingPrompts: {},
  handoffs: {},
  queued: {},
}));

const NO_PROMPTS: string[] = [];

/**
 * The view `paneId` shows in `layout` while on `transcript`: the terminal
 * under a live menu handoff, otherwise the stored choice, or what this
 * browser remembers, or `deskDefault` for a desk pane with neither.
 */
export function selectPaneChatView(
  state: PaneChatViewState,
  paneId: string,
  transcript: string | null,
  layout: LayoutMode = "phone",
  deskDefault: ChatView = "terminal",
): ChatView {
  if (liveMenuHandoff(state.handoffs[paneId], transcript)) return "terminal";
  if (layout === "desk") return state.deskViews[paneId] ?? readChatView(paneId, "desk", deskDefault);
  return state.views[paneId] ?? readChatView(paneId);
}

/** Store `paneId`'s Chat | Terminal choice in `layout`, here and in this browser. */
export function setPaneChatView(paneId: string, view: ChatView, layout: LayoutMode = "phone"): void {
  const field = layout === "desk" ? "deskViews" : "views";
  usePaneChatViewStore.setState((s) =>
    s[field][paneId] === view ? s : { [field]: { ...s[field], [paneId]: view } },
  );
  writeChatView(paneId, view, layout);
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
 * Hand `paneId` to the terminal for the menu `/name` opens there, sent from the chat of `transcript`. A fresh chat has none of its own
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
 * Entries the chat of `transcript` just received for `paneId`: a queued
 * prompt that landed is no longer queued, a handoff from another transcript
 * is over, and one whose command landed has closed.
 */
export function noteChatEntries(
  paneId: string,
  transcript: string,
  entries: readonly ChatEntry[],
): void {
  dropLandedPrompts(paneId, entries);
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
 * `paneId`'s view in `layout` while on `transcript`, and a setter for the
 * stored choice (which a live handoff still covers).
 */
export function usePaneChatView(
  paneId: string,
  transcript: string | null,
  layout: LayoutMode = "phone",
  deskDefault: ChatView = "terminal",
): [ChatView, (view: ChatView) => void] {
  const view = usePaneChatViewStore((s) =>
    selectPaneChatView(s, paneId, transcript, layout, deskDefault),
  );
  const setView = useCallback(
    (next: ChatView) => setPaneChatView(paneId, next, layout),
    [paneId, layout],
  );
  return [view, setView];
}

/**
 * Note a prompt sent to `paneId`. One sent mid-turn (`queued`) shows as
 * queued until it lands; one sent between turns starts a turn, which no
 * earlier queued prompt can still be waiting on.
 */
export function noteSentPrompt(paneId: string, text: string, queued: boolean): void {
  if (!queued) return clearQueuedPrompts(paneId);
  usePaneChatViewStore.setState((s) => ({
    queued: { ...s.queued, [paneId]: [...(s.queued[paneId] ?? NO_PROMPTS), text] },
  }));
}

/**
 * Forget `paneId`'s queued prompts: its turn ended or was interrupted, and a
 * prompt still queued then was either submitted (its line lands as an
 * ordinary prompt) or handed back to the agent's input.
 */
export function clearQueuedPrompts(paneId: string): void {
  usePaneChatViewStore.setState((s) =>
    s.queued[paneId]?.length ? { queued: { ...s.queued, [paneId]: NO_PROMPTS } } : s,
  );
}

function dropLandedPrompts(paneId: string, entries: readonly ChatEntry[]): void {
  const prompts = usePaneChatViewStore.getState().queued[paneId];
  if (!prompts?.length) return;
  const landed = entries.flatMap((e) => (e.kind === "user" ? [e.text.trim()] : []));
  if (landed.length === 0) return;
  const left = prompts.filter((p) => {
    const i = landed.indexOf(p.trim());
    if (i === -1) return true;
    landed.splice(i, 1);
    return false;
  });
  if (left.length === prompts.length) return;
  usePaneChatViewStore.setState((s) => ({ queued: { ...s.queued, [paneId]: left } }));
}

/** `paneId`'s prompts sent mid-turn that haven't landed in its transcript. */
export function useQueuedPrompts(paneId: string): string[] {
  return usePaneChatViewStore((s) => s.queued[paneId] ?? NO_PROMPTS);
}
