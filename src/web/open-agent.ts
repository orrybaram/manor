/**
 * The web app's half of a tapped push notification (ADR-206 D7): `sw.ts`
 * focuses an open tab and posts `{ type: "open-agent", agentId }` to it;
 * this opens that agent the way a clicked desktop notification does
 * (`navigateToNotification`) — from the agent store, or fetched if the store
 * has not seen it.
 */

import { useAgentStore } from "../store/agent-store";
import { navigateToAgent } from "../utils/agent-navigation";

interface OpenAgentMessage {
  type: "open-agent";
  agentId: string;
}

function isOpenAgent(data: unknown): data is OpenAgentMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "open-agent" &&
    typeof d.agentId === "string" &&
    d.agentId.length > 0
  );
}

async function openAgent(agentId: string): Promise<void> {
  const known = useAgentStore.getState().agents.find((a) => a.id === agentId);
  const agent =
    known ?? (await window.electronAPI?.agents.get(agentId)) ?? null;
  // Pruned since the push was sent: nothing to open.
  if (agent) navigateToAgent(agent);
}

/**
 * Listen on `container` (the page's `navigator.serviceWorker`) for the
 * worker's `open-agent` message. Returns the unsubscribe. A no-op where
 * there is no service worker container.
 */
export function listenForOpenAgent(
  container: Pick<
    ServiceWorkerContainer,
    "addEventListener" | "removeEventListener"
  > | null = navigator.serviceWorker ?? null,
): () => void {
  if (!container) return () => {};
  const onMessage = (event: Event) => {
    const data = (event as MessageEvent).data;
    if (isOpenAgent(data)) void openAgent(data.agentId).catch(() => {});
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
