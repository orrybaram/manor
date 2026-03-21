import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDetector } from "../agent-detector";
import type { AgentState, AgentStatus } from "../types";

function createTestHarness() {
  const detector = new AgentDetector();
  const transitions: AgentState[] = [];
  detector.onStatusChange = (state) => transitions.push({ ...state });
  return { detector, transitions };
}

/** Extract just the statuses from captured transitions */
function statuses(transitions: AgentState[]): AgentStatus[] {
  return transitions.map((t) => t.status);
}

describe("Agent Lifecycle E2E Scenarios", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Scenario 1: Normal Claude session (happy path)", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"  (agent appears, transitions idle -> idle is no-op since already idle)
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3. Hook: PostToolUse -> running (no-op, already running)
    detector.setStatus("running");

    // 4. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // 5. Hook: UserPromptSubmit -> running (another prompt)
    detector.setStatus("running");

    // 6. Hook: PermissionRequest -> waiting
    detector.setStatus("waiting");

    // 7. Hook: PostToolUse -> running (permission granted, tool ran)
    detector.setStatus("running");

    // 8. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // 9. FG -> null (agent exits -> complete)
    detector.updateForegroundProcess(null);

    // 10. advance timer 3000ms -> idle
    vi.advanceTimersByTime(3000);

    expect(statuses(transitions)).toEqual([
      "running",
      "waiting",
      "running",
      "waiting",
      "running",
      "waiting",
      "complete",
      "idle",
    ]);

    detector.dispose();
  });

  it("Scenario 2: Agent crash (no Stop hook)", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3. FG -> null (crash, no Stop received -> complete)
    detector.updateForegroundProcess(null);

    // 4. advance 3000ms -> idle
    vi.advanceTimersByTime(3000);

    expect(statuses(transitions)).toEqual(["running", "complete", "idle"]);

    detector.dispose();
  });

  it("Scenario 3: Rapid agent restart", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3. FG -> null -> complete
    detector.updateForegroundProcess(null);

    // 4. FG -> "claude" before timer fires -> same agent kind reappears
    //    Since the kind hasn't changed, the detector doesn't reset to idle.
    //    The complete-clear timer is still pending.
    detector.updateForegroundProcess("claude");

    // 5. Hook: UserPromptSubmit -> running (transitions from complete to running)
    detector.setStatus("running");

    expect(statuses(transitions)).toEqual([
      "running",
      "complete",
      "running",
    ]);

    detector.dispose();
  });

  it("Scenario 4: Agent spawns child processes", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3. FG -> "git" (no change — agent spawned git)
    detector.updateForegroundProcess("git");

    // 4. FG -> "node" (no change — still agent's child)
    detector.updateForegroundProcess("node");

    // 5. FG -> "claude" (no change — still running)
    detector.updateForegroundProcess("claude");

    // 6. Hook: Stop -> waiting
    detector.setStatus("waiting");

    expect(statuses(transitions)).toEqual(["running", "waiting"]);

    detector.dispose();
  });

  it("Scenario 5: Permission -> approval -> tool use cycle", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3. Hook: PermissionRequest -> waiting
    detector.setStatus("waiting");

    // 4. Hook: PostToolUse -> running (user approved, tool ran)
    detector.setStatus("running");

    // 5. Hook: PermissionRequest -> waiting (another permission)
    detector.setStatus("waiting");

    // 6. Hook: PostToolUse -> running
    detector.setStatus("running");

    // 7. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // 8. FG -> null -> complete
    detector.updateForegroundProcess(null);

    expect(statuses(transitions)).toEqual([
      "running",
      "waiting",
      "running",
      "waiting",
      "running",
      "waiting",
      "complete",
    ]);

    detector.dispose();
  });

  it("Scenario 6: Multiple tool uses in sequence", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3-6. Hook: PostToolUse / PostToolUseFailure -> running (no-op, already running)
    detector.setStatus("running");
    detector.setStatus("running");
    detector.setStatus("running");
    detector.setStatus("running");

    // 7. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // Only two transitions: running and waiting
    expect(statuses(transitions)).toEqual(["running", "waiting"]);

    detector.dispose();
  });

  it("Scenario 7: Agent detected but never gets hook event", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude" (idle, just detected — no transition since already idle)
    detector.updateForegroundProcess("claude");

    // 2. advance 60000ms (still idle — no hook means no dot)
    vi.advanceTimersByTime(60000);

    // 3. FG -> null (still idle — never was running, so no complete transition)
    detector.updateForegroundProcess(null);

    // No transitions should have occurred
    expect(statuses(transitions)).toEqual([]);

    detector.dispose();
  });

  it("Scenario 8: Hook fires before process detected (race condition)", () => {
    const { detector, transitions } = createTestHarness();

    // 1. Hook: UserPromptSubmit (ignored — no agent kind set)
    detector.setStatus("running");

    // 2. FG -> "claude" (idle)
    detector.updateForegroundProcess("claude");

    // 3. Hook: UserPromptSubmit -> running (now it works)
    detector.setStatus("running");

    // The first setStatus should be ignored, only the second produces a transition
    expect(statuses(transitions)).toEqual(["running"]);

    detector.dispose();
  });

  it("Scenario 9: opencode agent (different kind)", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "opencode"
    detector.updateForegroundProcess("opencode");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // Verify it's detected as opencode
    expect(detector.getState().kind).toBe("opencode");

    // 3. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // 4. FG -> null -> complete
    detector.updateForegroundProcess(null);

    // 5. advance timer -> idle
    vi.advanceTimersByTime(3000);

    expect(statuses(transitions)).toEqual([
      "running",
      "waiting",
      "complete",
      "idle",
    ]);

    // Verify kind was opencode throughout the running/waiting phases
    expect(transitions[0].kind).toBe("opencode");
    expect(transitions[1].kind).toBe("opencode");

    detector.dispose();
  });

  it("Scenario 10: Rapid status flapping", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG -> "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit -> running
    detector.setStatus("running");

    // 3. Hook: PermissionRequest -> waiting
    detector.setStatus("waiting");

    // 4. Hook: UserPromptSubmit -> running (user responded instantly)
    detector.setStatus("running");

    // 5. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // 6. Hook: UserPromptSubmit -> running (rapid follow-up)
    detector.setStatus("running");

    // 7. Hook: Stop -> waiting
    detector.setStatus("waiting");

    // Verify no transitions were lost or coalesced
    expect(statuses(transitions)).toEqual([
      "running",
      "waiting",
      "running",
      "waiting",
      "running",
      "waiting",
    ]);

    // Verify each transition has a unique timestamp or at least they're all recorded
    expect(transitions).toHaveLength(6);

    detector.dispose();
  });
});
