import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { AgentState, AgentStatus } from "../../electron.d";
import { STATUS_PRIORITY } from "../../components/useSessionAgentStatus";

// Mock window.electronAPI since it doesn't exist in test
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: undefined,
});

function makeAgentState(
  status: AgentStatus,
  kind: "claude" | "opencode" | "codex" | null = "claude",
): AgentState {
  return { kind, status, processName: kind, since: Date.now(), title: null };
}

describe("setPaneAgentStatus", () => {
  beforeEach(() => {
    // Reset the store before each test
    useAppStore.setState({ paneAgentStatus: {} });
  });

  it("updates store for each status value", () => {
    const statuses: AgentStatus[] = [
      "thinking",
      "working",
      "requires_input",
      "complete",
      "error",
    ];

    for (const status of statuses) {
      useAppStore
        .getState()
        .setPaneAgentStatus("pane-1", makeAgentState(status));
      expect(useAppStore.getState().paneAgentStatus["pane-1"]?.status).toBe(
        status,
      );
    }
  });

  it("removes entry when status is idle", () => {
    // First set a non-idle status
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("thinking"));
    expect(useAppStore.getState().paneAgentStatus["pane-1"]).toBeDefined();

    // Set to idle — should remove the entry
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("idle"));
    expect(useAppStore.getState().paneAgentStatus["pane-1"]).toBeUndefined();
  });

  it("deduplicates: same status+kind produces no state update", () => {
    const agent = makeAgentState("thinking");
    useAppStore.getState().setPaneAgentStatus("pane-1", agent);

    const stateAfterFirst = useAppStore.getState().paneAgentStatus;

    // Set same status+kind again
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("thinking"));

    // Should be the exact same object reference (zustand skips update)
    expect(useAppStore.getState().paneAgentStatus).toBe(stateAfterFirst);
  });

  it("different paneIds are independent", () => {
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("thinking"));
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-2", makeAgentState("requires_input"));

    const state = useAppStore.getState().paneAgentStatus;
    expect(state["pane-1"]?.status).toBe("thinking");
    expect(state["pane-2"]?.status).toBe("requires_input");
  });

  it("handles rapid updates without lost writes", () => {
    const sequence: AgentStatus[] = [
      "thinking",
      "requires_input",
      "thinking",
      "requires_input",
      "complete",
    ];

    for (const status of sequence) {
      useAppStore
        .getState()
        .setPaneAgentStatus("pane-1", makeAgentState(status));
    }

    expect(useAppStore.getState().paneAgentStatus["pane-1"]?.status).toBe(
      "complete",
    );
  });
});

describe("STATUS_PRIORITY aggregation logic", () => {
  it("priority order: requires_input > working > thinking > error > complete > idle", () => {
    expect(STATUS_PRIORITY["requires_input"]).toBeGreaterThan(
      STATUS_PRIORITY["working"],
    );
    expect(STATUS_PRIORITY["working"]).toBeGreaterThan(
      STATUS_PRIORITY["thinking"],
    );
    expect(STATUS_PRIORITY["thinking"]).toBeGreaterThan(
      STATUS_PRIORITY["error"],
    );
    expect(STATUS_PRIORITY["error"]).toBeGreaterThan(
      STATUS_PRIORITY["complete"],
    );
    expect(STATUS_PRIORITY["complete"]).toBeGreaterThan(
      STATUS_PRIORITY["idle"],
    );
  });

  it("single pane returns that pane's status", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("thinking"));

    const paneStatus = useAppStore.getState().paneAgentStatus;
    const statuses = Object.values(paneStatus);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("thinking");
  });

  it("multiple panes: highest priority wins", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("thinking"));
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-2", makeAgentState("requires_input"));
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-3", makeAgentState("complete"));

    const paneStatus = useAppStore.getState().paneAgentStatus;
    const best = Object.values(paneStatus).reduce(
      (acc, agent) => {
        const p = STATUS_PRIORITY[agent.status] ?? 0;
        return p > acc.priority ? { status: agent.status, priority: p } : acc;
      },
      { status: null as AgentStatus | null, priority: 0 },
    );

    expect(best.status).toBe("requires_input");
  });

  it("pane goes idle -> falls back to next highest", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("requires_input"));
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-2", makeAgentState("thinking"));

    // Pane 1 goes idle (removed from store)
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("idle"));

    const paneStatus = useAppStore.getState().paneAgentStatus;
    expect(paneStatus["pane-1"]).toBeUndefined();

    const remaining = Object.values(paneStatus);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe("thinking");
  });

  it("all panes idle -> empty status map (returns null equivalent)", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("thinking"));
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-2", makeAgentState("requires_input"));

    // Both go idle
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("idle"));
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-2", makeAgentState("idle"));

    const paneStatus = useAppStore.getState().paneAgentStatus;
    expect(Object.keys(paneStatus)).toHaveLength(0);
  });

  it("new pane added -> recalculates correctly", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-1", makeAgentState("complete"));

    // Add a new pane with higher priority
    useAppStore
      .getState()
      .setPaneAgentStatus("pane-2", makeAgentState("thinking"));

    const paneStatus = useAppStore.getState().paneAgentStatus;
    const best = Object.values(paneStatus).reduce(
      (acc, agent) => {
        const p = STATUS_PRIORITY[agent.status] ?? 0;
        return p > acc.priority ? { status: agent.status, priority: p } : acc;
      },
      { status: null as AgentStatus | null, priority: 0 },
    );

    expect(best.status).toBe("thinking");
  });
});
