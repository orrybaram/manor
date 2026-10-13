/**
 * The agent side of one terminal stream event (ADR-184), shared by every
 * Manor server that runs a Status reconciler: the desktop
 * (`app-lifecycle.ts`) and the host server (`host-server/server.ts`,
 * ADR-225). Electron-free, so the host server can import it.
 */

import type { AgentManager, AgentInfo } from "./agent-persistence";
import type { AgentStatusDriver } from "./agent-status/driver";
import type { StreamEvent } from "./terminal-host/types";
import { cleanAgentTitle } from "./title-utils";

export interface AgentStreamDeps {
  agentManager: Pick<AgentManager, "getAgentByPaneId" | "updateAgent">;
  agentStatus: Pick<AgentStatusDriver, "signal" | "noteOutput" | "forgetPane">;
  /** Broadcast an updated Agent (and refresh the dock badge). */
  broadcastAgent: (agent: AgentInfo) => void;
}

/**
 * The agent-domain side of a stream event, run ONCE per event in main
 * (ADR-184):
 * - `paneFacts` → a Status signal for the pane, and the Agent's name from the
 *   terminal title (unless the user pinned one);
 * - `cwd` → the active Agent's cwd;
 * - `data` → the pane is still drawing (throttled in the driver), which keeps
 *   a long streamed reply from reading as a stuck turn;
 * - `exit` → the pane's reconciler state is dropped.
 */
export function handleAgentStreamEvent(event: StreamEvent, deps: AgentStreamDeps): void {
  try {
    switch (event.type) {
      case "paneFacts": {
        deps.agentStatus.signal(event.sessionId, { type: "paneFacts", facts: event.facts });
        // Update the persisted Agent name from the terminal title — unless the
        // user pinned a name of their own, which the title sync must not
        // clobber. Only an agent still running in the foreground names
        // itself: once it exits, the title is the shell's, and a finished
        // Agent keeps the name it ended with.
        const cleaned = event.facts.foreground?.kind ? cleanAgentTitle(event.facts.title) : null;
        if (cleaned) {
          const agent = deps.agentManager.getAgentByPaneId(event.sessionId);
          if (agent && agent.status === "active" && !agent.namePinned && agent.name !== cleaned) {
            const updated = deps.agentManager.updateAgent(agent.id, { name: cleaned });
            if (updated) deps.broadcastAgent(updated);
          }
        }
        break;
      }
      case "cwd": {
        // Update the agent's cwd if it is active and differs.
        const agent = deps.agentManager.getAgentByPaneId(event.sessionId);
        if (agent && agent.status === "active" && agent.cwd !== event.cwd) {
          const updated = deps.agentManager.updateAgent(agent.id, { cwd: event.cwd });
          if (updated) deps.broadcastAgent(updated);
        }
        break;
      }
      case "data":
        deps.agentStatus.noteOutput(event.sessionId);
        break;
      case "exit":
        deps.agentStatus.forgetPane(event.sessionId);
        break;
    }
  } catch (err) {
    console.error("Error in agent stream event handler:", err);
  }
}

/**
 * What main does with one stream event from any host: its agent side once
 * (`handleAgentStreamEvent`), then the pane events to every renderer, once.
 *
 * `forward` is the bridge (`BridgeServer.handleStreamEvent`, ADR-180 D5): a
 * pane's output, exit, cwd, resize and error used to go out on a
 * `pty-${kind}-${paneId}` channel to every live window, whether or not it had
 * the pane; they are `pty.*` event frames now, keyed by paneId, published to
 * windows and devices alike — each hearing only the panes it subscribed to.
 * However many renderers are attached, a signal reaches the Status
 * reconciler once and its effects are applied once (ADR-184). `paneFacts`
 * never reaches a renderer.
 */
export function dispatchStreamEvent(
  event: StreamEvent,
  agentDeps: AgentStreamDeps,
  forward: (event: StreamEvent) => void,
): void {
  handleAgentStreamEvent(event, agentDeps);
  if (event.type === "paneFacts") return;
  try {
    forward(event);
  } catch (err) {
    console.error("Error forwarding stream event:", err);
  }
}
