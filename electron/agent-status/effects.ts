/**
 * Effect applier for the Status reconciler (ADR-184).
 *
 * Walks the ordered `Effect`s one `reconcile()` call produced and performs the
 * side effects: Agent persistence, unseen flags, notifications, broadcasts and
 * the pane's published Agent status.
 *
 * Ported from ADR-139's `hook-relay-effects.ts` (which stays in place, unused
 * by main, until ADR-184 ticket 4 deletes the old relay). The mutation order
 * inside each effect is load-bearing and is carried over unchanged — see the
 * per-transition order documented on `AgentStatusTransition` in `./types.ts`:
 *
 *   persist → unseen add/clear → notify → broadcast
 */

import type { AgentInfo } from "../agent-persistence";
import type { AgentStatus as WireAgentStatus } from "../terminal-host/types";
import type { AgentKind, AgentStatus, AgentStatusTransition, Effect } from "./types";

/** Structural interface for the Agent persistence layer (fakes in tests). */
export interface IAgentManager {
  createAgent(data: Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">): AgentInfo;
  updateAgent(id: string, updates: Partial<AgentInfo>): AgentInfo | null;
  getAgentBySessionId(sessionId: string): AgentInfo | null;
  getAgentByPaneId(paneId: string): AgentInfo | null;
  getActiveAgents(): AgentInfo[];
  getAgentById?(agentId: string): AgentInfo | null;
}

/** Where a pane's project lives, for a newly created Agent. */
export interface PaneContext {
  projectId: string;
  projectName: string;
  workspacePath: string;
  agentCommand: string | null;
}

/** What `PublishPaneStatus` sends on the `agent-status` channel (ADR-184 §4). */
export interface PaneStatusUpdate {
  paneId: string;
  status: AgentStatus;
  reason: string;
  kind: AgentKind | null;
}

export interface EffectApplierDeps {
  agentManager: IAgentManager;
  getPaneContext: (paneId: string) => PaneContext | undefined;
  unseenRespondedAgents: Set<string>;
  unseenInputAgents: Set<string>;
  /** Broadcast an `agent-updated` event and refresh the dock badge. */
  broadcastAgent: (agent: AgentInfo) => void;
  /** Send an OS notification if the transition warrants one. */
  maybeSendNotification: (
    agent: AgentInfo,
    prevStatus: string | null | undefined,
    newStatus: WireAgentStatus,
  ) => void;
  /** Publish a pane's Agent status to every window (once per signal). */
  publishPaneStatus: (update: PaneStatusUpdate) => void;
}

export function applyStatusEffects(
  effects: readonly Effect[],
  deps: EffectApplierDeps,
): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "PublishPaneStatus":
        deps.publishPaneStatus({
          paneId: effect.paneId,
          status: effect.status,
          reason: effect.reason,
          kind: effect.agentKind,
        });
        break;

      case "CreateAgent":
        applyCreateAgent(effect, deps);
        break;

      case "PersistAgentStatus":
        applyTransition(effect.sessionId, effect.transition, deps);
        break;

      case "MarkSeen": {
        deps.unseenRespondedAgents.delete(effect.agentId);
        deps.unseenInputAgents.delete(effect.agentId);
        const agent = findAgentById(deps.agentManager, effect.agentId);
        if (agent) deps.broadcastAgent(agent);
        break;
      }

      default: {
        // Exhaustiveness check — a new Effect variant without a handler fails
        // the build here.
        const _exhaustive: never = effect;
        void _exhaustive;
      }
    }
  }
}

function findAgentById(agentManager: IAgentManager, agentId: string): AgentInfo | null {
  if (agentManager.getAgentById) return agentManager.getAgentById(agentId);
  return agentManager.getActiveAgents().find((a) => a.id === agentId) ?? null;
}

function applyCreateAgent(
  effect: Extract<Effect, { kind: "CreateAgent" }>,
  deps: EffectApplierDeps,
): void {
  // ADR-142: retire any prior Agent that owned this pane. Nulling paneId alone
  // leaves the old record `active`, which lingers as a duplicate in the
  // sidebar. Mark it completed, clear its unseen flags, and broadcast the
  // retirement so the renderer drops the stale row live.
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
  agent = deps.agentManager.updateAgent(agent.id, { activatedAt: new Date().toISOString() });
  if (agent) {
    if (effect.status === "requires_input") {
      deps.unseenInputAgents.add(agent.id);
    }
    // A session whose very first agent-creating event already needs input
    // notifies like any other transition into that state (ADR-162).
    deps.maybeSendNotification(agent, null, effect.status);
    deps.broadcastAgent(agent);
  }
}

function applyTransition(
  sessionId: string,
  transition: AgentStatusTransition,
  deps: EffectApplierDeps,
): void {
  const existing = deps.agentManager.getAgentBySessionId(sessionId);
  if (!existing) return;
  const prevStatus = existing.lastAgentStatus;
  const now = new Date().toISOString();

  switch (transition.to) {
    case "active": {
      const agent = deps.agentManager.updateAgent(existing.id, {
        lastAgentStatus: transition.status,
        status: "active",
        ...(existing.activatedAt ? {} : { activatedAt: now }),
      });
      if (agent) {
        if (transition.status === "requires_input") {
          deps.unseenInputAgents.add(agent.id);
        }
        deps.maybeSendNotification(agent, prevStatus, transition.status);
        deps.broadcastAgent(agent);
      }
      return;
    }

    case "responded": {
      const agent = deps.agentManager.updateAgent(existing.id, {
        lastAgentStatus: "responded",
        status: "active",
      });
      if (agent) {
        deps.unseenRespondedAgents.add(agent.id);
        deps.maybeSendNotification(agent, prevStatus, "responded");
        deps.broadcastAgent(agent);
      }
      return;
    }

    case "completed": {
      // ADR-184: an ended session's last Agent status is `idle` (the old relay
      // wrote "complete"); the lifecycle carries the outcome.
      const agent = deps.agentManager.updateAgent(existing.id, {
        lastAgentStatus: "idle",
        status: "completed",
        completedAt: now,
      });
      if (agent) {
        deps.unseenRespondedAgents.delete(agent.id);
        deps.unseenInputAgents.delete(agent.id);
        deps.broadcastAgent(agent);
      }
      return;
    }

    case "error": {
      const agent = deps.agentManager.updateAgent(existing.id, {
        lastAgentStatus: "error",
        status: "error",
        completedAt: now,
      });
      if (agent) {
        deps.unseenRespondedAgents.delete(agent.id);
        deps.unseenInputAgents.delete(agent.id);
        deps.broadcastAgent(agent);
      }
      return;
    }

    case "abandoned": {
      // Was the direct write in `agents:abandonForPane` / `/sessions/end`.
      // Unseen flags are left as they were, as before.
      const agent = deps.agentManager.updateAgent(existing.id, {
        status: "abandoned",
        completedAt: now,
      });
      if (agent) deps.broadcastAgent(agent);
      return;
    }

    default: {
      const _exhaustive: never = transition;
      void _exhaustive;
    }
  }
}
