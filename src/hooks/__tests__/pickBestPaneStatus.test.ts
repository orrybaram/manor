import { describe, expect, it } from "vitest";
import { pickBestPaneStatus, type PaneStatusDeps } from "../useTabAgentStatus";
import type { AgentInfo, AgentStatus, PaneAgentStatus } from "../../electron.d";

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

function makeLive(status: AgentStatus): PaneAgentStatus {
  return { status, reason: "test", kind: "claude" };
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
    const agentLow = makeAgent({ id: "a-low", paneId: "pane-1" });
    const agentHigh = makeAgent({ id: "a-high", paneId: "pane-2" });

    const deps = makeDeps({
      agents: [agentLow, agentHigh],
      paneAgentStatus: {
        "pane-1": makeLive("responded"),
        "pane-2": makeLive("requires_input"),
      },
    });

    const resultLowFirst = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(resultLowFirst.status).toBe("requires_input");

    const resultHighFirst = pickBestPaneStatus(["pane-2", "pane-1"], deps);
    expect(resultHighFirst.status).toBe("requires_input");
  });

  it("prefers the unseen pane on a priority tie: seen then unseen -> unseen wins, pulse true", () => {
    const seenAgent = makeAgent({ id: "seen", paneId: "pane-1" });
    const unseenAgent = makeAgent({ id: "unseen", paneId: "pane-2" });

    const deps = makeDeps({
      agents: [seenAgent, unseenAgent],
      unseenRespondedAgentIds: new Set(["unseen"]),
      paneAgentStatus: {
        "pane-1": makeLive("responded"),
        "pane-2": makeLive("responded"),
      },
    });

    const result = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(result.status).toBe("responded");
    expect(result.pulse).toBe(true);
  });

  it("two responded panes, both seen -> pulse false", () => {
    const agentA = makeAgent({ id: "a", paneId: "pane-1" });
    const agentB = makeAgent({ id: "b", paneId: "pane-2" });

    const deps = makeDeps({
      agents: [agentA, agentB],
      paneAgentStatus: {
        "pane-1": makeLive("responded"),
        "pane-2": makeLive("responded"),
      },
    });

    const result = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(result.status).toBe("responded");
    expect(result.pulse).toBe(false);
  });

  it("two requires_input panes, second unseen -> pulse true", () => {
    const seenAgent = makeAgent({ id: "seen", paneId: "pane-1" });
    const unseenAgent = makeAgent({ id: "unseen", paneId: "pane-2" });

    const deps = makeDeps({
      agents: [seenAgent, unseenAgent],
      unseenInputAgentIds: new Set(["unseen"]),
      paneAgentStatus: {
        "pane-1": makeLive("requires_input"),
        "pane-2": makeLive("requires_input"),
      },
    });

    const result = pickBestPaneStatus(["pane-1", "pane-2"], deps);
    expect(result.status).toBe("requires_input");
    expect(result.pulse).toBe(true);
  });

  it("live status with no agent record counts and yields pulse true", () => {
    const deps = makeDeps({ paneAgentStatus: { "pane-1": makeLive("working") } });

    const result = pickBestPaneStatus(["pane-1"], deps);
    expect(result.status).toBe("working");
    expect(result.pulse).toBe(true);
  });
});

describe("pickBestPaneStatus — on-screen panes", () => {
  it("does not pulse an unseen responded pane that is on screen", () => {
    const deps = makeDeps({
      paneAgentStatus: { "pane-1": makeLive("responded") },
      agents: [makeAgent({ id: "a1", paneId: "pane-1" })],
      unseenRespondedAgentIds: new Set(["a1"]),
    });
    expect(pickBestPaneStatus(["pane-1"], deps).pulse).toBe(true);
    const onScreen = pickBestPaneStatus(["pane-1"], { ...deps, visiblePaneIds: new Set(["pane-1"]) });
    expect(onScreen).toEqual({ status: "responded", pulse: false });
  });

  it("does not pulse an on-screen pane with no agent row", () => {
    const deps = makeDeps({ paneAgentStatus: { "pane-1": makeLive("responded") } });
    expect(pickBestPaneStatus(["pane-1"], deps).pulse).toBe(true);
    expect(pickBestPaneStatus(["pane-1"], { ...deps, visiblePaneIds: new Set(["pane-1"]) }).pulse).toBe(false);
  });

  it("prefers an off-screen unseen pane over an on-screen one on a tie", () => {
    const deps = makeDeps({
      paneAgentStatus: { "pane-1": makeLive("responded"), "pane-2": makeLive("responded") },
      agents: [makeAgent({ id: "a1", paneId: "pane-1" }), makeAgent({ id: "a2", paneId: "pane-2" })],
      unseenRespondedAgentIds: new Set(["a1", "a2"]),
      visiblePaneIds: new Set(["pane-1"]),
    });
    expect(pickBestPaneStatus(["pane-1", "pane-2"], deps).pulse).toBe(true);
  });
});
