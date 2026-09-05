import { describe, expect, it } from "vitest";
import { pickBestPaneStatus, type PaneStatusDeps } from "../useTabAgentStatus";
import type { AgentInfo, AgentState } from "../../electron.d";

function makeAgent(overrides: Partial<AgentInfo> & { id: string; paneId: string }): AgentInfo {
  return {
    agentSessionId: overrides.id,
    name: null,
    status: "active",
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "",
    agentKind: "claude",
    agentCommand: null,
    lastAgentStatus: null,
    resumedAt: null,
    ...overrides,
  } as AgentInfo;
}

function makeDeps(overrides: Partial<PaneStatusDeps>): PaneStatusDeps {
  return {
    paneAgentStatus: {},
    agents: [],
    unseenRespondedAgentIds: new Set(),
    unseenInputAgentIds: new Set(),
    ...overrides,
  };
}

describe("pickBestPaneStatus", () => {
  it("returns null status and pulse true for no panes", () => {
    const result = pickBestPaneStatus([], makeDeps({}));
    expect(result).toEqual({ status: null, pulse: true });
  });

  it("returns null status and pulse true when no pane has a status", () => {
    const result = pickBestPaneStatus(["pane-1", "pane-2"], makeDeps({}));
    expect(result).toEqual({ status: null, pulse: true });
  });

  it("higher priority wins regardless of order", () => {
    const agentLow = makeAgent({ id: "a-low", paneId: "pane-1", lastAgentStatus: "responded" });
    const agentHigh = makeAgent({
      id: "a-high",
      paneId: "pane-2",
      lastAgentStatus: "requires_input",
    });

    const deps = makeDeps({ agents: [agentLow, agentHigh] });

    const resultLowFirst = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(resultLowFirst.status).toBe("requires_input");

    const resultHighFirst = pickBestPaneStatus(["pane-2", "pane-1"], deps);
    expect(resultHighFirst.status).toBe("requires_input");
  });

  it("prefers the unseen pane on a priority tie: seen then unseen -> unseen wins, pulse true", () => {
    const seenAgent = makeAgent({ id: "seen", paneId: "pane-1", lastAgentStatus: "responded" });
    const unseenAgent = makeAgent({
      id: "unseen",
      paneId: "pane-2",
      lastAgentStatus: "responded",
    });

    const deps = makeDeps({
      agents: [seenAgent, unseenAgent],
      unseenRespondedAgentIds: new Set(["unseen"]),
    });

    const result = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(result.status).toBe("responded");
    expect(result.pulse).toBe(true);
  });

  it("two responded panes, both seen -> pulse false", () => {
    const agentA = makeAgent({ id: "a", paneId: "pane-1", lastAgentStatus: "responded" });
    const agentB = makeAgent({ id: "b", paneId: "pane-2", lastAgentStatus: "responded" });

    const deps = makeDeps({ agents: [agentA, agentB] });

    const result = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(result.status).toBe("responded");
    expect(result.pulse).toBe(false);
  });

  it("two requires_input panes, second unseen -> pulse true", () => {
    const seenAgent = makeAgent({
      id: "seen",
      paneId: "pane-1",
      lastAgentStatus: "requires_input",
    });
    const unseenAgent = makeAgent({
      id: "unseen",
      paneId: "pane-2",
      lastAgentStatus: "requires_input",
    });

    const deps = makeDeps({
      agents: [seenAgent, unseenAgent],
      unseenInputAgentIds: new Set(["unseen"]),
    });

    const result = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(result.status).toBe("requires_input");
    expect(result.pulse).toBe(true);
  });

  it("live status with no agent record counts and yields pulse true", () => {
    const liveState: AgentState = {
      kind: "claude",
      status: "working",
      processName: null,
      since: 0,
      title: null,
    };

    const deps = makeDeps({ paneAgentStatus: { "pane-1": liveState } });

    const result = pickBestPaneStatus(["pane-1"], deps);
    expect(result.status).toBe("working");
    expect(result.pulse).toBe(true);
  });
});
