import { currentLayoutMode, type LayoutMode } from "../../../hooks/useLayoutMode";
import { selectPaneChatAgent } from "../../../lib/pane-agent";
import { useAgentStore } from "../../../store/agent-store";
import { selectPaneContentType, useAppStore } from "../../../store/app-store";
import { usePreferencesStore } from "../../../store/preferences-store";
import { chatTranscriptPath, commandStartsOnChat, type ChatView } from "./chat-view";
import { liveMenuHandoff } from "./menu-handoff";
import {
  endMenuHandoff,
  markChatStarting,
  selectPaneChatView,
  setPaneChatView,
  usePaneChatViewStore,
} from "./usePaneChatView";

/**
 * Flipping a pane between its chat and its terminal from outside the pane:
 * the desk's pane header, its right-click menu and the Toggle Chat View
 * command all come through here, so they agree with what `LeafPane` shows.
 */

/** What a desk pane shows when it has no choice of its own: the setting's pick. */
export function deskChatDefault(): ChatView {
  return usePreferencesStore.getState().preferences.deskChatByDefault ? "chat" : "terminal";
}

/** `deskChatDefault`, as a hook that follows the setting. */
export function useDeskChatDefault(): ChatView {
  return usePreferencesStore((s) => (s.preferences.deskChatByDefault ? "chat" : "terminal"));
}

/**
 * The transcript `paneId`'s chat would show, or null when the pane has no
 * chat to show (no agent, an agent with no transcript reader, or none yet).
 */
export function paneChatTranscript(paneId: string): string | null {
  const contentType = selectPaneContentType(useAppStore.getState(), paneId);
  return chatTranscriptPath(
    selectPaneChatAgent(useAgentStore.getState().agents, paneId, contentType),
  );
}

/** Whether `paneId` has a chat to flip to: a transcript, or a chat starting up. */
export function paneHasChat(paneId: string): boolean {
  return paneChatTranscript(paneId) !== null || paneId in usePaneChatViewStore.getState().starting;
}

/** Whether `paneId` shows its chat in `layout` right now. */
export function paneShowsChat(paneId: string, layout: LayoutMode = currentLayoutMode()): boolean {
  if (!paneHasChat(paneId)) return false;
  const state = usePaneChatViewStore.getState();
  return selectPaneChatView(state, paneId, paneChatTranscript(paneId), layout, deskChatDefault()) === "chat";
}

/**
 * Open a desk agent pane launched by `command` on its chat, the way the pane
 * it was started from showed: at once for a kind that starts on one, and
 * otherwise as soon as its transcript is known.
 */
export function openNewAgentOnChat(paneId: string, command: string): void {
  setPaneChatView(paneId, "chat", "desk");
  if (commandStartsOnChat(command)) markChatStarting(paneId);
}

/**
 * Flip `paneId` to the other view in `layout`. Under a menu handoff the
 * terminal is only borrowed: ending it is the flip back to the chat, and the
 * stored choice stays. Does nothing for a pane with no chat.
 */
export function togglePaneChat(paneId: string, layout: LayoutMode = currentLayoutMode()): void {
  if (!paneHasChat(paneId)) return;
  const state = usePaneChatViewStore.getState();
  const transcript = paneChatTranscript(paneId);
  if (liveMenuHandoff(state.handoffs[paneId], transcript)) {
    endMenuHandoff(paneId);
    return;
  }
  const view = selectPaneChatView(state, paneId, transcript, layout, deskChatDefault());
  setPaneChatView(paneId, view === "chat" ? "terminal" : "chat", layout);
}

/**
 * After a desk pane flips, move focus into the view it now shows, if the pane
 * held it (or nothing did): the view it left is hidden, and typing would land
 * there. The chat mounts lazily, so its composer is waited for a few frames.
 * Returns a cancel for the wait.
 */
export function focusShownView(pane: HTMLElement | null, chat: boolean): () => void {
  const active = document.activeElement;
  if (!pane || (active && active !== document.body && !pane.contains(active))) return () => {};
  const selector = chat
    ? '[data-chat-pane]:not([aria-hidden]) [data-testid="chat-composer-input"]'
    : ".xterm-helper-textarea";
  let frame = 0;
  let tries = 30;
  const attempt = () => {
    const target = pane.querySelector<HTMLElement>(selector);
    if (target) target.focus();
    else if (--tries > 0) frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => cancelAnimationFrame(frame);
}
