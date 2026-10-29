/**
 * A run's Agent, read live from the Agent records and the Status reconciler:
 * which Agent is the run's, its status now, and the overlap rule built on it.
 */

import { describe, it, expect } from "vitest";

import { automationOfAgent, isRunAgentBusy, runAgent, type RunAgentDeps } from "../run-agent";
import type { AgentInfo } from "../../agent-persistence";
import type { Automation, AutomationRun } from "../../../src/lib/automations";

const FIRED = "2026-10-29T09:00:00.000Z";

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "auto-1",
    scheduledFor: FIRED,
    firedAt: FIRED,
    trigger: "schedule",
    outcome: "started",
    paneId: "pane-1",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "agent-1",
    paneId: "pane-1",
    status: "active",
    lastAgentStatus: "working",
    createdAt: "2026-10-29T09:00:02.000Z",
    ...overrides,
  } as AgentInfo;
}

function deps(agents: AgentInfo[], paneStatus: Record<string, string> = {}): RunAgentDeps {
  return {
    agentManager: {
      getAgentById: (id) => agents.find((a) => a.id === id) ?? null,
      getAllAgents: () => agents,
    },
    agentStatus: {
      getPaneState: (paneId) =>
        (paneStatus[paneId] ? { status: paneStatus[paneId] } : undefined) as never,
    },
  };
}

describe("runAgent", () => {
  it("finds the first Agent on the run's pane since it fired", () => {
    const before = agent({ id: "old", createdAt: "2026-10-29T08:00:00.000Z" });
    const mine = agent({ id: "mine" });
    const later = agent({ id: "later", createdAt: "2026-10-29T10:00:00.000Z" });
    expect(runAgent(deps([later, before, mine]), run()).agent?.id).toBe("mine");
  });

  it("prefers the run's agentId when it has one", () => {
    const named = agent({ id: "named", paneId: "pane-2" });
    expect(runAgent(deps([agent({}), named]), run({ agentId: "named" })).agent?.id).toBe("named");
  });

  it("reads an active Agent's status from its pane", () => {
    expect(runAgent(deps([agent({})], { "pane-1": "thinking" }), run()).status).toBe("thinking");
  });

  it("reads a finished Agent's last status", () => {
    const done = agent({ status: "completed", lastAgentStatus: "idle" });
    expect(runAgent(deps([done], { "pane-1": "working" }), run()).status).toBe("idle");
  });

  it("has the pane's status before the Agent's first hook", () => {
    expect(runAgent(deps([], { "pane-1": "working" }), run())).toEqual({ agent: null, status: "working" });
    expect(runAgent(deps([]), run())).toEqual({ agent: null, status: null });
  });
});

describe("isRunAgentBusy", () => {
  it("is busy while thinking or working only", () => {
    for (const [status, busy] of [
      ["thinking", true],
      ["working", true],
      ["requires_input", false],
      ["responded", false],
    ] as const) {
      expect(isRunAgentBusy(deps([agent({})], { "pane-1": status }), run())).toBe(busy);
    }
  });

  it("is not busy once the Agent has ended, whatever its pane is doing", () => {
    const done = agent({ status: "completed", lastAgentStatus: "idle" });
    expect(isRunAgentBusy(deps([done], { "pane-1": "working" }), run())).toBe(false);
  });

  it("is not busy once its Agent is retired, though its last status was working", () => {
    const retired = agent({ status: "completed", paneId: null, lastAgentStatus: "working" });
    expect(isRunAgentBusy(deps([retired]), run({ agentId: "agent-1" }))).toBe(false);
    expect(isRunAgentBusy(deps([retired], { "pane-1": "working" }), run({ agentId: "agent-1" }))).toBe(false);
  });

  it("is not busy when its active Agent's pane has no live state (the daemon died, or a restart)", () => {
    const stale = agent({ status: "active", lastAgentStatus: "working" });
    expect(isRunAgentBusy(deps([stale]), run())).toBe(false);
  });

  it("is not busy for a run with no pane", () => {
    expect(isRunAgentBusy(deps([]), run({ paneId: undefined }))).toBe(false);
  });
});

describe("automationOfAgent", () => {
  const triage = { id: "auto-1", name: "Morning triage" } as Automation;
  const store = (runs: AutomationRun[]) => ({
    list: () => [triage],
    runs: (id: string) => (id === triage.id ? runs : []),
  });

  it("names the automation whose started run's pane the agent is on", () => {
    const mine = agent({ id: "mine" });
    expect(automationOfAgent(deps([mine]), store([run()]), mine)?.name).toBe("Morning triage");
  });

  it("names none for a later agent on the same pane, or a skipped run's", () => {
    const first = agent({ id: "first" });
    const later = agent({ id: "later", createdAt: "2026-10-29T10:00:00.000Z" });
    expect(automationOfAgent(deps([first, later]), store([run()]), later)).toBeNull();
    expect(
      automationOfAgent(deps([first]), store([run({ outcome: "skipped" })]), first),
    ).toBeNull();
  });

  it("names none for an agent on another pane", () => {
    const other = agent({ id: "other", paneId: "pane-9" });
    expect(automationOfAgent(deps([other]), store([run()]), other)).toBeNull();
  });
});
