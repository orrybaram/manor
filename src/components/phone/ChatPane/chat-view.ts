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
import { isRemoteHost } from "../../../lib/hosts";

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
 * The agent a pane's chat follows: its active agent, or failing that the
 * newest one that ran in it. Mirrors `pickPaneAgent` in
 * `electron/chat-mirror/mirror.ts`, which the renderer can't import (it pulls
 * in `fs`), so main and the phone agree on which transcript is shown.
 */
export function pickPaneAgent(
  agents: readonly AgentInfo[],
  paneId: string,
): AgentInfo | null {
  let newest: AgentInfo | null = null;
  for (const agent of agents) {
    if (agent.paneId !== paneId) continue;
    if (agent.status === "active") return agent;
    if (!newest || agent.createdAt > newest.createdAt) newest = agent;
  }
  return newest;
}

/**
 * The transcript a pane's chat would show, or null when the pane gets no
 * chat: no agent, not Claude, no transcript yet, or on a remote host (v1
 * reads local transcripts only, D4).
 */
export function chatTranscriptPath(agent: AgentInfo | null): string | null {
  if (!agent || agent.agentKind !== "claude") return null;
  if (isRemoteHost(agent.hostId)) return null;
  return agent.transcriptPath || null;
}
