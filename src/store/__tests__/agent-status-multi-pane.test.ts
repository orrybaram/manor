import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { AgentState, AgentStatus } from "../../electron.d";
import { STATUS_PRIORITY } from "../../hooks/useTabAgentStatus";

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
    setPaneAgentStatus("pane-a", makeAgentState("thinking"));
    expect(aggregateTabStatus()).toBe("thinking");

    // 2. Pane B: FG → "claude", Hook: UserPromptSubmit → thinking
    setPaneAgentStatus("pane-b", makeAgentState("thinking"));
    expect(aggregateTabStatus()).toBe("thinking");

    // 3. Pane A: Hook: PermissionRequest → requires_input
    setPaneAgentStatus("pane-a", makeAgentState("requires_input"));

    // 4. Tab status: requires_input (highest priority across panes)
    expect(aggregateTabStatus()).toBe("requires_input");

    // 5. Pane A: Hook: PostToolUse → thinking
    setPaneAgentStatus("pane-a", makeAgentState("thinking"));

    // 6. Tab status: thinking (both panes thinking)
    expect(aggregateTabStatus()).toBe("thinking");

    // 7. Pane B: Hook: Stop → complete
    setPaneAgentStatus("pane-b", makeAgentState("complete"));

    // 8. Tab status: thinking (pane A still thinking)
    expect(aggregateTabStatus()).toBe("thinking");

    // 9. Pane A: Hook: Stop → complete
    setPaneAgentStatus("pane-a", makeAgentState("complete"));

    // 10. Tab status: complete (both done)
    expect(aggregateTabStatus()).toBe("complete");
  });

  it("Scenario: Mixed statuses across many panes — highest priority wins", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    setPaneAgentStatus("pane-1", makeAgentState("idle"));
    setPaneAgentStatus("pane-2", makeAgentState("complete"));
    setPaneAgentStatus("pane-3", makeAgentState("thinking"));
    setPaneAgentStatus("pane-4", makeAgentState("error"));

    // idle is removed from store, so effective panes: complete, thinking, error
    // Priority: thinking (3) > error (2) > complete (1)
    expect(aggregateTabStatus()).toBe("thinking");

    // Add requires_input — it should win
    setPaneAgentStatus("pane-5", makeAgentState("requires_input"));
    expect(aggregateTabStatus()).toBe("requires_input");

    // Add working — requires_input still wins (priority 5 > 4)
    setPaneAgentStatus("pane-6", makeAgentState("working"));
    expect(aggregateTabStatus()).toBe("requires_input");
  });

  it("Scenario: Panes going idle reduces to next highest", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    setPaneAgentStatus("pane-a", makeAgentState("requires_input"));
    setPaneAgentStatus("pane-b", makeAgentState("working"));
    setPaneAgentStatus("pane-c", makeAgentState("thinking"));

    expect(aggregateTabStatus()).toBe("requires_input");

    // Pane A goes idle → removed
    setPaneAgentStatus("pane-a", makeAgentState("idle"));
    expect(aggregateTabStatus()).toBe("working");

    // Pane B goes idle → removed
    setPaneAgentStatus("pane-b", makeAgentState("idle"));
    expect(aggregateTabStatus()).toBe("thinking");

    // Pane C goes idle → all removed
    setPaneAgentStatus("pane-c", makeAgentState("idle"));
    expect(aggregateTabStatus()).toBeNull();
  });

  it("Scenario: Status transitions tracked per-pane independently", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    // Pane A lifecycle
    setPaneAgentStatus("pane-a", makeAgentState("thinking"));
    setPaneAgentStatus("pane-a", makeAgentState("working"));
    setPaneAgentStatus("pane-a", makeAgentState("complete"));

    // Pane B lifecycle (overlapping)
    setPaneAgentStatus("pane-b", makeAgentState("thinking"));
    setPaneAgentStatus("pane-b", makeAgentState("requires_input"));

    // Pane A is complete, Pane B requires_input → tab = requires_input
    expect(aggregateTabStatus()).toBe("requires_input");

    // Pane B resolves
    setPaneAgentStatus("pane-b", makeAgentState("thinking"));
    expect(aggregateTabStatus()).toBe("thinking");

    setPaneAgentStatus("pane-b", makeAgentState("complete"));
    // Both complete
    expect(aggregateTabStatus()).toBe("complete");
  });

  it("Scenario: Error in one pane while others work", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    setPaneAgentStatus("pane-a", makeAgentState("thinking"));
    setPaneAgentStatus("pane-b", makeAgentState("error"));

    // thinking (3) > error (2) → tab = thinking
    expect(aggregateTabStatus()).toBe("thinking");

    // Pane A stops
    setPaneAgentStatus("pane-a", makeAgentState("complete"));

    // complete (1) vs error (2) → tab = error
    expect(aggregateTabStatus()).toBe("error");

    // Error pane recovers
    setPaneAgentStatus("pane-b", makeAgentState("idle"));
    expect(aggregateTabStatus()).toBe("complete");
  });

  it("Scenario: Rapid updates across panes — no lost writes", () => {
    const { setPaneAgentStatus } = useAppStore.getState();

    const panes = ["p1", "p2", "p3", "p4", "p5"];
    const statusSeq: AgentStatus[] = [
      "thinking",
      "working",
      "requires_input",
      "thinking",
      "complete",
    ];

    // Rapidly update all panes through the sequence
    for (const status of statusSeq) {
      for (const pane of panes) {
        setPaneAgentStatus(pane, makeAgentState(status));
      }
    }

    // All panes should be at "complete"
    const state = useAppStore.getState().paneAgentStatus;
    for (const pane of panes) {
      expect(state[pane]?.status).toBe("complete");
    }
    expect(aggregateTabStatus()).toBe("complete");
  });

  it("Regression: transition snapshot — multi-pane tab", () => {
    const { setPaneAgentStatus } = useAppStore.getState();
    const snapshots: (AgentStatus | null)[] = [];

    setPaneAgentStatus("pane-a", makeAgentState("thinking"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus("pane-b", makeAgentState("thinking"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus("pane-a", makeAgentState("requires_input"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus("pane-a", makeAgentState("thinking"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus("pane-b", makeAgentState("complete"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus("pane-a", makeAgentState("complete"));
    snapshots.push(aggregateTabStatus());

    setPaneAgentStatus("pane-a", makeAgentState("idle"));
    setPaneAgentStatus("pane-b", makeAgentState("idle"));
    snapshots.push(aggregateTabStatus());

    expect(snapshots).toMatchInlineSnapshot(`
      [
        "thinking",
        "thinking",
        "requires_input",
        "thinking",
        "thinking",
        "complete",
        null,
      ]
    `);
  });
});
