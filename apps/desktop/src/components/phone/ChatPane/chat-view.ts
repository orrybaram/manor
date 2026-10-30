/**
 * Which view a pane that can chat shows, and whether it has a choice at all.
 *
 * The choice is a per-viewer convenience, so it lives in this browser's
 * `localStorage`, keyed by pane and **Layout mode**: the phone and the desk
 * each keep their own, so flipping a pane on one leaves the other alone. The
 * phone defaults to the chat; the desk to whatever the caller says (the
 * "Show agent panes as chat" setting). Storage can throw (private mode,
 * quota, a sandboxed frame), so every read and write is guarded and a failure
 * just means the default.
 */

import type { AgentInfo } from "../../../electron.d";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { hasChat } from "../../../lib/agent-chat";

export type ChatView = "chat" | "terminal";

/** The phone's prefix predates the desk's, so it keeps the bare one. */
const KEY_PREFIX: Record<LayoutMode, string> = {
  phone: "manor:pane-view:",
  desk: "manor:pane-view:desk:",
};

/** The stored choice for `paneId` in `layout`, or null when it has none. */
export function readStoredChatView(paneId: string, layout: LayoutMode = "phone"): ChatView | null {
  try {
    const stored = localStorage.getItem(KEY_PREFIX[layout] + paneId);
    return stored === "chat" || stored === "terminal" ? stored : null;
  } catch {
    return null;
  }
}

export function readChatView(
  paneId: string,
  layout: LayoutMode = "phone",
  fallback: ChatView = layout === "phone" ? "chat" : "terminal",
): ChatView {
  return readStoredChatView(paneId, layout) ?? fallback;
}

export function writeChatView(paneId: string, view: ChatView, layout: LayoutMode = "phone"): void {
  try {
    localStorage.setItem(KEY_PREFIX[layout] + paneId, view);
  } catch {
    // Not remembered; the view still switches.
  }
}

/**
 * The transcript a pane's chat would show, or null when the pane gets no
 * chat: no agent, one of a kind with no chat (`CHAT_KINDS`), or no transcript yet. An agent on a remote host
 * gets the chat too; its transcript is read on that host.
 */
export function chatTranscriptPath(agent: AgentInfo | null): string | null {
  if (!agent || !hasChat(agent.agentKind)) return null;
  return agent.transcriptPath || null;
}
