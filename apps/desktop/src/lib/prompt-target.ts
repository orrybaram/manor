/**
 * Which of a workspace's agents a new brief (the PR card's "Fix checks",
 * "Address comments") goes to. Only one waiting for its next prompt: an
 * agent mid-turn, or asking for input, is never interrupted; the caller
 * starts a new agent instead. Shared by the renderer and the `manor` CLI's
 * route, so both answer the same.
 */

/** Agent statuses that are waiting for the next prompt. */
const PROMPTABLE = new Set(["idle", "responded"]);

export interface PromptCandidate {
  status: string;
  lastAgentStatus: string | null;
  paneId: string | null;
  updatedAt: string;
}

/**
 * The most recently active of `agents` (already narrowed to one workspace)
 * that is live, in a pane `isLive` still knows, and waiting; null when none
 * is, and the brief needs a new agent.
 */
export function pickPromptTarget<A extends PromptCandidate>(
  agents: readonly A[],
  isLive: (paneId: string) => boolean,
): (A & { paneId: string }) | null {
  let best: (A & { paneId: string }) | null = null;
  for (const agent of agents) {
    if (agent.status !== "active" || !agent.paneId) continue;
    if (!PROMPTABLE.has(agent.lastAgentStatus ?? "")) continue;
    if (!isLive(agent.paneId)) continue;
    if (!best || Date.parse(agent.updatedAt) > Date.parse(best.updatedAt)) {
      best = agent as A & { paneId: string };
    }
  }
  return best;
}
