import type { AgentInfo, AgentManager } from "../agent-persistence";
import type { AgentStatusDriver } from "../agent-status/driver";
import type { AgentStatus } from "../agent-status/types";
import type { AutomationRun } from "../../src/lib/automations";

/**
 * A run's Agent, read live. A run never stores a status of its own: it
 * names its pane (and its Agent, once known), and what the run is doing is
 * whatever that Agent is doing now.
 *
 * The Agent record is made by the agent's first hook, after the run is
 * recorded, so a started run is usually linked by `paneId` alone. Its Agent
 * is then the first one on that pane created since the run fired: a later
 * agent the user starts in the same pane is not the run's.
 */

export interface RunAgentDeps {
  agentManager: Pick<AgentManager, "getAgentById" | "getAllAgents">;
  agentStatus: Pick<AgentStatusDriver, "getPaneState">;
}

export interface RunAgent {
  /** The run's Agent, or null while its first hook has not arrived (or it never ran). */
  agent: AgentInfo | null;
  /**
   * The Agent status now: the pane's live status while the Agent is active
   * (or before it has a record), else its last one. Null when unknown.
   */
  status: AgentStatus | null;
}

export function runAgent(deps: RunAgentDeps, run: Pick<AutomationRun, "agentId" | "paneId" | "firedAt">): RunAgent {
  const agent = findAgent(deps, run);
  const paneId = agent?.paneId ?? run.paneId;
  const live = paneId ? (deps.agentStatus.getPaneState(paneId)?.status ?? null) : null;
  if (!agent) return { agent: null, status: live };
  if (agent.status === "active" && agent.paneId) return { agent, status: live ?? asStatus(agent.lastAgentStatus) };
  return { agent, status: asStatus(agent.lastAgentStatus) };
}

/**
 * The overlap rule: a run's agent is busy while its pane says it is thinking
 * or working. Needs input is not busy. Only the live pane state counts: an
 * Agent that is no longer active (retired, completed) is never busy, whatever
 * its last status was, and neither is an active one whose pane has no live
 * state (its daemon died, or the server restarted) — otherwise a status
 * frozen at "working" would skip every later occurrence.
 */
export function isRunAgentBusy(deps: RunAgentDeps, run: AutomationRun): boolean {
  const agent = findAgent(deps, run);
  if (agent && agent.status !== "active") return false;
  const paneId = agent ? agent.paneId : run.paneId;
  const live = paneId ? (deps.agentStatus.getPaneState(paneId)?.status ?? null) : null;
  return live === "thinking" || live === "working";
}

function findAgent(deps: RunAgentDeps, run: Pick<AutomationRun, "agentId" | "paneId" | "firedAt">): AgentInfo | null {
  if (run.agentId) {
    const byId = deps.agentManager.getAgentById(run.agentId);
    if (byId) return byId;
  }
  if (!run.paneId) return null;
  const firedAt = Date.parse(run.firedAt);
  let first: AgentInfo | null = null;
  for (const agent of deps.agentManager.getAllAgents()) {
    if (agent.paneId !== run.paneId) continue;
    if (Date.parse(agent.createdAt) < firedAt) continue;
    if (!first || agent.createdAt < first.createdAt) first = agent;
  }
  return first;
}

function asStatus(status: string | null): AgentStatus | null {
  return (status as AgentStatus | null) ?? null;
}
