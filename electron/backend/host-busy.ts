/**
 * Keep-awake wiring (ADR-178 §1): a host is busy while any pane on it has an
 * agent in an active status, and the registry passes that on to the host's
 * provider so an auto-sleeping box never sleeps mid-task.
 *
 * Per-pane agent status is the daemon's `agentStatus` stream event — the
 * `AgentDetector` output that both hook relays and output detection feed —
 * so that is what this watches. A pane's host is the one the registry has
 * recorded for the session.
 */

import { BUSY_AGENT_STATUSES } from "../stats-signals";
import type { BackendRegistry } from "./registry";

type BusyRegistry = Pick<BackendRegistry, "onEvent" | "hostForSession" | "updateBusy">;

/** Start feeding `registry.updateBusy`. Returns an unsubscribe. */
export function trackHostBusy(registry: BusyRegistry): () => void {
  /** Pane → the host it runs on and whether its agent is busy. */
  const panes = new Map<string, { hostId: string; busy: boolean }>();

  const report = (hostId: string): void => {
    let busy = false;
    for (const pane of panes.values()) {
      if (pane.hostId === hostId && pane.busy) {
        busy = true;
        break;
      }
    }
    registry.updateBusy(hostId, busy);
  };

  return registry.onEvent((taggedHostId, event) => {
    if (event.type === "agentStatus") {
      const hostId = registry.hostForSession(event.sessionId) ?? taggedHostId;
      const prev = panes.get(event.sessionId);
      panes.set(event.sessionId, {
        hostId,
        busy: BUSY_AGENT_STATUSES.has(event.agent.status),
      });
      if (prev && prev.hostId !== hostId) report(prev.hostId);
      report(hostId);
    } else if (event.type === "exit") {
      const prev = panes.get(event.sessionId);
      if (!prev) return;
      panes.delete(event.sessionId);
      report(prev.hostId);
    }
  });
}
