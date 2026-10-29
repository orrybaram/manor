/**
 * The web app's half of a tapped push notification: `sw.ts`
 * focuses an open tab and posts it a `pushClickMessage`. An
 * `open-agent` opens that agent the way a clicked desktop notification does
 * (`navigateToNotification`) — from the agent store, or fetched if the store
 * has not seen it; an `open-automation` (a run that failed to start) opens
 * the automation as a bell row for one does.
 */

import { useAgentStore } from "../store/agent-store";
import { navigateToAgent } from "../utils/agent-navigation";
import { requestUi } from "../utils/ui-request";
import { LOCAL_HOST_ID } from "../lib/workspace-key";
import { readPushClickMessage } from "./push-click";

async function openAgent(agentId: string): Promise<void> {
  const known = useAgentStore.getState().agents.find((a) => a.id === agentId);
  const agent =
    known ?? (await window.electronAPI?.agents.get(agentId)) ?? null;
  // Pruned since the push was sent: nothing to open.
  if (agent) navigateToAgent(agent);
}

/**
 * Listen on `container` (the page's `navigator.serviceWorker`) for the
 * worker's tap messages. Returns the unsubscribe. A no-op where
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
    const message = readPushClickMessage((event as MessageEvent).data);
    if (!message) return;
    if (message.type === "open-agent") {
      void openAgent(message.agentId).catch(() => {});
      return;
    }
    requestUi({
      type: "open-automation",
      // A push from a server with no room named no host: its own, home.
      hostId: message.hostId ?? LOCAL_HOST_ID,
      automationId: message.automationId,
    });
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
