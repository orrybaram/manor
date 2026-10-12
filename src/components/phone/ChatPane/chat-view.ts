/**
 * Which view a phone shows for a Claude pane, and whether it has a choice at
 * all (ADR-215 D7).
 *
 * The choice is a per-viewer convenience, so it lives in this browser's
 * `localStorage`, keyed by pane. Chat is the default. Storage can throw
 * (private mode, quota, a sandboxed frame), so every read and write is
 * guarded and a failure just means the default.
 */

import type { AgentInfo } from "../../../electron.d";

export type ChatView = "chat" | "terminal";

const KEY_PREFIX = "manor:pane-view:";

export function readChatView(paneId: string): ChatView {
  try {
    return localStorage.getItem(KEY_PREFIX + paneId) === "terminal" ? "terminal" : "chat";
  } catch {
    return "chat";
  }
}

export function writeChatView(paneId: string, view: ChatView): void {
  try {
    localStorage.setItem(KEY_PREFIX + paneId, view);
  } catch {
    // Not remembered; the view still switches.
  }
}

/**
 * The transcript a pane's chat would show, or null when the pane gets no
 * chat: no agent, not Claude, or no transcript yet. An agent on a remote host
 * gets the chat too; its transcript is read on that host (ADR-216 D4).
 */
export function chatTranscriptPath(agent: AgentInfo | null): string | null {
  if (!agent || agent.agentKind !== "claude") return null;
  return agent.transcriptPath || null;
}
