/**
 * Which agent a pane's chat is about. Pure, so main's chat mirror
 * (`electron/chat-mirror`) and the phone renderer share one rule and agree on
 * which transcript is shown.
 */

type PaneAgentLike = { paneId: string | null; status: string; createdAt: string };

/**
 * The agent a pane's chat follows: its active agent, or failing that its
 * newest one while that one errored (a `StopFailure` turn: Claude is still
 * running). A pane keeps old agents' records pointing at it; a completed or
 * abandoned one has exited and left the pane to its shell, which may be
 * running anything since, so the pane gets none.
 */
export function pickPaneAgent<A extends PaneAgentLike>(
  agents: readonly A[],
  paneId: string,
): A | null {
  let newest: A | null = null;
  for (const agent of agents) {
    if (agent.paneId !== paneId) continue;
    if (agent.status === "active") return agent;
    if (!newest || agent.createdAt > newest.createdAt) newest = agent;
  }
  return newest?.status === "error" ? newest : null;
}

/** Whether a pane showing `contentType` can be read as a chat at all: a
 *  browser or file pane never is. */
export function paneCanChat(contentType: string | null | undefined): boolean {
  return contentType !== "browser" && contentType !== "file";
}

/**
 * The agent a phone's chat follows for a pane, or null when the pane can't
 * be a chat. Returns the store's own agent object, so it is a stable
 * selector result.
 */
export function selectPaneChatAgent<A extends PaneAgentLike>(
  agents: readonly A[],
  paneId: string | null | undefined,
  contentType: string | null | undefined,
): A | null {
  if (!paneId || !paneCanChat(contentType)) return null;
  return pickPaneAgent(agents, paneId);
}
