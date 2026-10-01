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
): PaneAgentStatusUpdate {
  return { paneId, status, reason: "test", kind };
}

/** Compute the highest-priority status across all panes (mirrors useTabAgentStatus logic) */
function aggregateTabStatus(): AgentStatus | null {
  const paneStatus = useAppStore.getState().paneAgentStatus;
  const agents = Object.values(paneStatus);
  if (agents.length === 0) return null;

  let best: AgentStatus | null = null;
  let bestPriority = 0;

  for (const agent of agents) {
    const p = STATUS_PRIORITY[agent.status] ?? 0;
    if (p > bestPriority) {
      bestPriority = p;
      best = agent.status;
    }
  }

  return best;
}

describe("Full multi-pane tab — status aggregation", () => {
  beforeEach(() => {
    useAppStore.setState({ paneAgentStatus: {} });
  });

  it("Scenario: Full multi-pane tab lifecycle", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    // 1. Pane A: FG → "claude", Hook: UserPromptSubmit → thinking
    setPaneAgentStatus(makeUpdate("pane-a", "thinking"));
    expect(aggregateTabStatus()).toBe("thinking");

    // 2. Pane B: FG → "claude", Hook: UserPromptSubmit → thinking
    setPaneAgentStatus(makeUpdate("pane-b", "thinking"));
    expect(aggregateTabStatus()).toBe("thinking");

    // 3. Pane A: Hook: PermissionRequest → requires_input
    setPaneAgentStatus(makeUpdate("pane-a", "requires_input"));

    // 4. Tab status: requires_input (highest priority across panes)
    expect(aggregateTabStatus()).toBe("requires_input");

    // 5. Pane A: Hook: PostToolUse → thinking
    setPaneAgentStatus(makeUpdate("pane-a", "thinking"));

    // 6. Tab status: thinking (both panes thinking)
    expect(aggregateTabStatus()).toBe("thinking");

    // 7. Pane B: Hook: Stop → responded
    setPaneAgentStatus(makeUpdate("pane-b", "responded"));

    // 8. Tab status: thinking (pane A still thinking)
    expect(aggregateTabStatus()).toBe("thinking");

    // 9. Pane A: Hook: Stop → responded
    setPaneAgentStatus(makeUpdate("pane-a", "responded"));

    // 10. Tab status: responded (both done)
    expect(aggregateTabStatus()).toBe("responded");
  });

  it("Scenario: Mixed statuses across many panes — highest priority wins", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    setPaneAgentStatus(makeUpdate("pane-1", "idle"));
    setPaneAgentStatus(makeUpdate("pane-2", "responded"));
    setPaneAgentStatus(makeUpdate("pane-3", "thinking"));
    setPaneAgentStatus(makeUpdate("pane-4", "error"));

    // idle has priority 0, so it never wins: thinking (3) > error (2) > responded (1)
    expect(aggregateTabStatus()).toBe("thinking");

    // Add requires_input — it should win
    setPaneAgentStatus(makeUpdate("pane-5", "requires_input"));
    expect(aggregateTabStatus()).toBe("requires_input");

    // Add working — requires_input still wins (priority 5 > 4)
    setPaneAgentStatus(makeUpdate("pane-6", "working"));
    expect(aggregateTabStatus()).toBe("requires_input");
  });

  it("Scenario: Panes going idle reduces to next highest", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    setPaneAgentStatus(makeUpdate("pane-a", "requires_input"));
    setPaneAgentStatus(makeUpdate("pane-b", "working"));
    setPaneAgentStatus(makeUpdate("pane-c", "thinking"));

    expect(aggregateTabStatus()).toBe("requires_input");

    // Pane A goes idle → no longer contends for best
    setPaneAgentStatus(makeUpdate("pane-a", "idle"));
    expect(aggregateTabStatus()).toBe("working");

    // Pane B goes idle → no longer contends for best
    setPaneAgentStatus(makeUpdate("pane-b", "idle"));
    expect(aggregateTabStatus()).toBe("thinking");

    // Pane C goes idle → nothing contends
    setPaneAgentStatus(makeUpdate("pane-c", "idle"));
    expect(aggregateTabStatus()).toBeNull();
  });

  it("Scenario: Status transitions tracked per-pane independently", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    // Pane A lifecycle
    setPaneAgentStatus(makeUpdate("pane-a", "thinking"));
    setPaneAgentStatus(makeUpdate("pane-a", "working"));
    setPaneAgentStatus(makeUpdate("pane-a", "responded"));

    // Pane B lifecycle (overlapping)
    setPaneAgentStatus(makeUpdate("pane-b", "thinking"));
    setPaneAgentStatus(makeUpdate("pane-b", "requires_input"));

    // Pane A is responded, Pane B requires_input → tab = requires_input
    expect(aggregateTabStatus()).toBe("requires_input");

    // Pane B resolves
    setPaneAgentStatus(makeUpdate("pane-b", "thinking"));
    expect(aggregateTabStatus()).toBe("thinking");

    setPaneAgentStatus(makeUpdate("pane-b", "responded"));
    // Both responded
    expect(aggregateTabStatus()).toBe("responded");
  });

  it("Scenario: Error in one pane while others work", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    setPaneAgentStatus(makeUpdate("pane-a", "thinking"));
    setPaneAgentStatus(makeUpdate("pane-b", "error"));

    // thinking (3) > error (2) → tab = thinking
    expect(aggregateTabStatus()).toBe("thinking");

    // Pane A stops
    setPaneAgentStatus(makeUpdate("pane-a", "responded"));

    // responded (1) vs error (2) → tab = error
    expect(aggregateTabStatus()).toBe("error");

    // Error pane recovers
    setPaneAgentStatus(makeUpdate("pane-b", "idle"));
    expect(aggregateTabStatus()).toBe("responded");
  });

  it("Scenario: Rapid updates across panes — no lost writes", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    const panes = ["p1", "p2", "p3", "p4", "p5"];
    const statusSeq: AgentStatus[] = [
      "thinking",
      "working",
      "requires_input",
      "thinking",
      "responded",
    ];

    // Rapidly update all panes through the sequence
    for (const status of statusSeq) {
      for (const pane of panes) {
        setPaneAgentStatus(makeUpdate(pane, status));
      }
    }

    // All panes should be at "responded"
    const state = useAppStore.getState().paneAgentStatus;
    for (const pane of panes) {
      expect(state[pane]?.status).toBe("responded");
    }
    expect(aggregateTabStatus()).toBe("responded");
  });

  it("Regression: transition snapshot — multi-pane tab", () => {
    const { setPaneAgentStatus } = useAppStore.getState();
    const snapshots: (AgentStatus | null)[] = [];

    setPaneAgentStatus(makeUpdate("pane-a", "thinking"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus(makeUpdate("pane-b", "thinking"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus(makeUpdate("pane-a", "requires_input"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus(makeUpdate("pane-a", "thinking"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus(makeUpdate("pane-b", "responded"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus(makeUpdate("pane-a", "responded"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus(makeUpdate("pane-a", "idle"));
    setPaneAgentStatus(makeUpdate("pane-b", "idle"));
    snapshots.push(aggregateTabStatus());

    expect(snapshots).toMatchInlineSnapshot(`
      [
        "thinking",
        "thinking",
        "requires_input",
        "thinking",
        "thinking",
        "responded",
        null,
      ]
    `);
  });
});
