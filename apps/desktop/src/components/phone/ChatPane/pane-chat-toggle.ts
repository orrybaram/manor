import { currentLayoutMode, type LayoutMode } from "../../../hooks/useLayoutMode";
import { selectPaneChatAgent } from "../../../lib/pane-agent";
import { useAgentStore } from "../../../store/agent-store";
import { selectPaneContentType, useAppStore } from "../../../store/app-store";
import { usePreferencesStore } from "../../../store/preferences-store";
import { chatTranscriptPath, type ChatView } from "./chat-view";
import { liveMenuHandoff } from "./menu-handoff";
import {
  endMenuHandoff,
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
