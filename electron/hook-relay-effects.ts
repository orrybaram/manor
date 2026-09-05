/**
 * Effect applier for the hook relay state machine (ADR-139).
 *
 * Walks the ordered list of `Effect`s produced by `transitionSession` and
 * performs the actual side effects: agentManager mutations, broadcasts,
 * notifications, paneRootSessionMap updates, and the kill-9 bridge into
 * `applyStopForSession`.
 *
 * Mutation order is load-bearing — the existing 100 integration tests in
 * electron/__tests__/relay-subagent-tracking.test.ts and agent-hooks.test.ts
 * pin specific call orderings (broadcastAgent vs maybeSendNotification, unseen
 * Set timing, agent field updates). This file replicates today's procedural
 * order from the pre-ADR-139 `relay()` body.
 */

import type { Effect } from "./hook-relay-transition";
import type { IAgentManager, HookRelayDeps } from "./hook-relay";
import type { AgentInfo } from "./agent-persistence";

/**
 * Status values that mean an agent is currently "stuck" mid-turn (the agent
 * has not yet produced a Stop). Mirrors hook-relay.ts's STUCK_ACTIVE.
 */
const STUCK_ACTIVE: ReadonlySet<string> = new Set([
  "thinking",
  "working",
  "requires_input",
]);

function isStuckActive(status: string | null | undefined): boolean {
  return status != null && STUCK_ACTIVE.has(status);
}

export interface EffectApplierDeps {
  agentManager: IAgentManager;
  relayAgentHook: HookRelayDeps["relayAgentHook"];
  getPaneContext: HookRelayDeps["getPaneContext"];
  unseenRespondedAgents: Set<string>;
  unseenInputAgents: Set<string>;
  broadcastAgent: HookRelayDeps["broadcastAgent"];
  maybeSendNotification: HookRelayDeps["maybeSendNotification"];
  paneRootSessionMap: Map<string, string>;
  /** Used as a hasBeenActive proxy when gating ForceCloseOldSession. */
  sessionStateMap: Map<string, unknown>;
  applyStopForSession: (sessionId: string) => void;
}

export function applyEffects(
  effects: readonly Effect[],
  deps: EffectApplierDeps,
): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "RelayAgentHook":
        deps.relayAgentHook(effect.paneId, effect.status, effect.agentKind);
        break;

      case "SetPaneRoot":
        deps.paneRootSessionMap.set(effect.paneId, effect.sessionId);
        break;

      case "DeletePaneRoot":
        deps.paneRootSessionMap.delete(effect.paneId);
        break;

      case "ForceCloseOldSession": {
        // Replicates hook-relay.ts:257-281 gating: only force-close when the
        // old session has an agent, the agent is stuck-active, and the old
        // session had been active (state-exists is the new-model proxy for
        // hasBeenActive — terminal events on a never-active session are
        // filtered by the transition function so state is null in that case).
        const oldAgent = deps.agentManager.getAgentBySessionId(effect.sessionId);
        if (
          oldAgent &&
          deps.sessionStateMap.has(effect.sessionId) &&
          isStuckActive(oldAgent.lastAgentStatus)
        ) {
          deps.applyStopForSession(effect.sessionId);
        }
        break;
      }

      case "DeleteSessionState":
        // Signal effect — the relay() outer wiring owns sessionStateMap and
        // performs deletion based on transition state. We still honour it
        // here for the SessionStart-replacement flow which deletes the OLD
        // session's state (the outer wiring only handles event.sessionId).
        deps.sessionStateMap.delete(effect.sessionId);
        break;

      case "CreateAgent": {
        // Mirror the pre-ADR-139 procedural code at hook-relay.ts:316-341.
        // First, retire any prior agent that owned this paneId. Nulling paneId
        // alone leaves the old record status:"active" which causes it to linger
        // as a duplicate in the sidebar (ADR-142). Mark it completed, clear its
        // unseen flags, and broadcast the retirement so the renderer drops the
        // stale row live.
        const prevPaneAgent = deps.agentManager.getAgentByPaneId(effect.paneId);
        if (prevPaneAgent) {
          const retired = deps.agentManager.updateAgent(prevPaneAgent.id, {
            paneId: null,
            status: "completed",
            completedAt: new Date().toISOString(),
          });
          deps.unseenRespondedAgents.delete(prevPaneAgent.id);
          deps.unseenInputAgents.delete(prevPaneAgent.id);
          if (retired) deps.broadcastAgent(retired);
        }

        const paneContext = deps.getPaneContext(effect.paneId);
        let agent: AgentInfo | null = deps.agentManager.createAgent({
          agentSessionId: effect.sessionId,
          name: null,
          status: "active",
          completedAt: null,
          projectId: paneContext?.projectId ?? null,
          projectName: paneContext?.projectName ?? null,
          workspacePath: paneContext?.workspacePath ?? null,
          cwd: paneContext?.workspacePath ?? "",
          agentKind: effect.agentKind,
          agentCommand: paneContext?.agentCommand ?? null,
          paneId: effect.paneId,
          lastAgentStatus: effect.status,
          resumedAt: null,
        });
        const now = new Date().toISOString();
        agent = deps.agentManager.updateAgent(agent.id, { activatedAt: now });
        if (agent) {
          if (effect.status === "requires_input") {
            deps.unseenInputAgents.add(agent.id);
          }
          // A session whose very first agent-creating event already needs input
          // — an agent that asks for permission before doing anything else —
          // notifies like any other transition into that state. Only this
          // branch runs for it: there is no prior agent for
          // `UpdateAgentActiveStatus` to find, and skipping the call here meant
          // the pulse appeared with no banner and no entry in the log
          // (ADR-162).
          deps.maybeSendNotification(agent, null, effect.status);
          deps.broadcastAgent(agent);
        }
        break;
      }

      case "UpdateAgentActiveStatus": {
        // Mirror hook-relay.ts:343-354.
        const existing = deps.agentManager.getAgentBySessionId(effect.sessionId);
        if (!existing) break;
        const prevStatus = existing.lastAgentStatus;
        const now = new Date().toISOString();
        const agent = deps.agentManager.updateAgent(existing.id, {
          lastAgentStatus: effect.status,
          status: "active",
          ...(existing.activatedAt ? {} : { activatedAt: now }),
        });
        if (agent) {
          if (effect.status === "requires_input") {
            deps.unseenInputAgents.add(agent.id);
          }
          deps.maybeSendNotification(agent, prevStatus, effect.status);
          deps.broadcastAgent(agent);
        }
        break;
      }

      case "ApplyStop":
        deps.applyStopForSession(effect.sessionId);
        break;

      case "MarkCompleted": {
        // Mirror hook-relay.ts:388-398.
        const existing = deps.agentManager.getAgentBySessionId(effect.sessionId);
        if (!existing) break;
        const agent = deps.agentManager.updateAgent(existing.id, {
          lastAgentStatus: "complete",
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        if (agent) {
          deps.unseenRespondedAgents.delete(agent.id);
          deps.unseenInputAgents.delete(agent.id);
          deps.broadcastAgent(agent);
        }
        break;
      }

      case "MarkError": {
        // Mirror hook-relay.ts:402-413.
        const existing = deps.agentManager.getAgentBySessionId(effect.sessionId);
        if (!existing) break;
        // The transition function does not surface the original error status
        // string today; preserve "error" as the lastAgentStatus, matching the
        // pre-ADR-139 code which wrote `status` (the AgentStatus) — for
        // StopFailure that value is the literal string "error".
        const agent = deps.agentManager.updateAgent(existing.id, {
          lastAgentStatus: "error",
          status: "error",
          completedAt: new Date().toISOString(),
        });
        if (agent) {
          deps.unseenRespondedAgents.delete(agent.id);
          deps.unseenInputAgents.delete(agent.id);
          deps.broadcastAgent(agent);
        }
        break;
      }

      default: {
        // Exhaustiveness check — adding a new Effect variant without a
        // handler will fail the build here.
        const _exhaustive: never = effect;
        void _exhaustive;
      }
    }
  }
}
