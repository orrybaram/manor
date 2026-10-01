import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { AgentStatus, PaneAgentStatusUpdate } from "../../electron.d";
import { STATUS_PRIORITY } from "../agent-rollup";

// Mock window.electronAPI since it doesn't exist in test
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: undefined,
});

function makeUpdate(
  paneId: string,
  status: AgentStatus,
  kind: "claude" | "opencode" | "codex" | null = "claude",
  reason = "test",
): PaneAgentStatusUpdate {
  return { paneId, status, reason, kind };
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
      "responded",
      "error",
    ];

    for (const status of statuses) {
      useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-1", status));
      expect(useAppStore.getState().paneAgentStatus["pane-1"]?.status).toBe(
        status,
      );
    }
  });

  it("stores idle exactly like any other status — the renderer does not filter it", () => {
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-1", "thinking"));
    expect(useAppStore.getState().paneAgentStatus["pane-1"]).toBeDefined();

    useAppStore
      .getState()
      .setPaneAgentStatus(makeUpdate("pane-1", "idle", null, "agent process exited"));

    const entry = useAppStore.getState().paneAgentStatus["pane-1"];
    expect(entry).toEqual({ status: "idle", kind: null, reason: "agent process exited" });
  });

  it("deduplicates: same status+kind+reason produces no state update", () => {
    const update = makeUpdate("pane-1", "thinking");
    useAppStore.getState().setPaneAgentStatus(update);

    const stateAfterFirst = useAppStore.getState().paneAgentStatus;

    // Fresh object, same values — zustand skips the update.
    useAppStore.getState().setPaneAgentStatus({ ...update });

    expect(useAppStore.getState().paneAgentStatus).toBe(stateAfterFirst);
  });

  it("different paneIds are independent", () => {
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-1", "thinking"));
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-2", "requires_input"));

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
      "responded",
    ];

    for (const status of sequence) {
      useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-1", status));
    }

    expect(useAppStore.getState().paneAgentStatus["pane-1"]?.status).toBe(
      "responded",
    );
  });
});

describe("STATUS_PRIORITY aggregation logic", () => {
  it("priority order: requires_input > working > thinking > error > responded > idle", () => {
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
      STATUS_PRIORITY["responded"],
    );
    expect(STATUS_PRIORITY["responded"]).toBeGreaterThan(
      STATUS_PRIORITY["idle"],
    );
  });

  it("single pane returns that pane's status", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-1", "thinking"));

    const paneStatus = useAppStore.getState().paneAgentStatus;
    const statuses = Object.values(paneStatus);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("thinking");
  });

  it("multiple panes: highest priority wins", () => {
    useAppStore.setState({ paneAgentStatus: {} });
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-1", "thinking"));
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-2", "requires_input"));
    useAppStore.getState().setPaneAgentStatus(makeUpdate("pane-3", "responded"));

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
});
