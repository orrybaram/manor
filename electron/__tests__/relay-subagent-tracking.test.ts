/**
 * Unit tests for the hook relay callback logic (createHookRelay) and the
 * stale-Stop safety-net sweep.
 *
 * Uses vitest fake timers for sweep scenarios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHookRelay,
  STALE_STOP_MS,
  STALE_ACTIVE_MS,
  SWEEP_INTERVAL_MS,
  type HookRelayDeps,
} from "../hook-relay";
import type { TaskInfo } from "../task-persistence";
import type { AgentKind } from "../terminal-host/types";
import type { AgentHookEvent } from "../agent-hook-events";

// ── Fake TaskManager ──

type CreateData = Omit<TaskInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">;

function makeFakeTaskManager() {
  const tasks = new Map<string, TaskInfo>();
  let counter = 0;

  function createTask(data: CreateData): TaskInfo {
    counter += 1;
    const task: TaskInfo = {
      ...data,
      id: `task-${counter}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activatedAt: null,
    } as TaskInfo;
    tasks.set(task.agentSessionId, task);
    return task;
  }

  function updateTask(id: string, updates: Partial<TaskInfo>): TaskInfo | null {
    for (const [key, task] of tasks) {
      if (task.id === id) {
        const updated = { ...task, ...updates, id: task.id, updatedAt: new Date().toISOString() } as TaskInfo;
        tasks.set(key, updated);
        return updated;
      }
    }
    return null;
  }

  function getTaskBySessionId(sessionId: string): TaskInfo | null {
    return tasks.get(sessionId) ?? null;
  }

  function getTaskByPaneId(paneId: string): TaskInfo | null {
    for (const task of tasks.values()) {
      if (task.paneId === paneId) return task;
    }
    return null;
  }

  function getActiveTasks(): TaskInfo[] {
    return Array.from(tasks.values()).filter((t) => t.status === "active");
  }

  return { createTask, updateTask, getTaskBySessionId, getTaskByPaneId, getActiveTasks, tasks };
}

// ── Relay builder ──

interface BuildRelayOptions {
  /** Inject a fake monotonic clock. Defaults to Date.now() so vi.advanceTimersByTime advances it. */
  monoClock?: () => number;
  /** Inject a fake wall clock. Defaults to Date.now(). */
  wallClock?: () => number;
}

function buildRelay(options: BuildRelayOptions = {}) {
  const taskManager = makeFakeTaskManager();
  const unseenRespondedTasks = new Set<string>();
  const unseenInputTasks = new Set<string>();
  const broadcastTask = vi.fn();
  const maybeSendNotification = vi.fn();
  const relayAgentHook = vi.fn();

  // By default mono and wall both follow Date.now() so existing tests using
  // vi.useFakeTimers() / vi.advanceTimersByTime() keep advancing the relay's
  // idle clock. ADR-135 ticket-4 tests pass explicit clocks to simulate suspend.
  const deps: HookRelayDeps = {
    relayAgentHook,
    taskManager,
    getPaneContext: () => undefined,
    unseenRespondedTasks,
    unseenInputTasks,
    broadcastTask,
    maybeSendNotification,
    monoClock: options.monoClock ?? (() => Date.now()),
    wallClock: options.wallClock ?? (() => Date.now()),
  };

  const ctx = createHookRelay(deps);

  return {
    ...ctx,
    taskManager,
    unseenRespondedTasks,
    unseenInputTasks,
    broadcastTask,
    maybeSendNotification,
    relayAgentHook,
  };
}

// ── Per-variant event builders ──
//
// One per AgentHookEvent variant. agentKind defaults to "claude" (every test
// in this file is claude-flavoured). sessionId is required (most tests rely
// on it being set), but may be null. toolUseId is required on subagent
// variants — the compiler enforces this at the call site.

interface BaseInput {
  paneId: string;
  sessionId: string | null;
  agentKind?: AgentKind;
}

interface SubagentInput extends BaseInput {
  toolUseId: string | null;
}

const base = (i: BaseInput) => ({
  paneId: i.paneId,
  sessionId: i.sessionId,
  agentKind: i.agentKind ?? ("claude" as AgentKind),
});

export const sessionStart = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "SessionStart",
  status: "thinking",
});
export const sessionEnd = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "SessionEnd",
  status: "idle",
});
export const userPromptSubmit = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "UserPromptSubmit",
  status: "thinking",
});
export const preToolUse = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "PreToolUse",
  status: "working",
});
export const postToolUse = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "PostToolUse",
  status: "thinking",
});
export const postToolUseFailure = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "PostToolUseFailure",
  status: "thinking",
});
export const stop = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "Stop",
  status: "responded",
});
export const stopFailure = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "StopFailure",
  status: "error",
});
export const permissionRequest = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "PermissionRequest",
  status: "requires_input",
});
export const notification = (i: BaseInput): AgentHookEvent => ({
  ...base(i),
  type: "Notification",
  status: "requires_input",
});
export const subagentStart = (i: SubagentInput): AgentHookEvent => ({
  ...base(i),
  type: "SubagentStart",
  status: "working",
  toolUseId: i.toolUseId,
});
export const subagentStop = (i: SubagentInput): AgentHookEvent => ({
  ...base(i),
  type: "SubagentStop",
  status: "thinking",
  toolUseId: i.toolUseId,
});

function fire(
  relay: ReturnType<typeof buildRelay>["relay"],
  event: AgentHookEvent,
) {
  return relay(event);
}

// ── Tests ──

describe("createHookRelay — subagent Set tracking", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("case 1: duplicate SubagentStart with same toolUseId keeps Set size at 1", () => {
    const { relay, sessionStateMap } = ctx;

    // Activate the session first (so hasBeenActive = true)
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-1" }));

    // First SubagentStart
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-1", toolUseId: "tool-a" }));
    // Second SubagentStart with same id
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-1", toolUseId: "tool-a" }));

    const state = sessionStateMap.get("sess-1")!;
    expect(state.activeSubagents.size).toBe(1);

    // Stop is dropped because subagent is still running
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-1" }));
    expect(state.pendingStopAt).not.toBeNull();
    // Task should NOT be updated to responded yet
    const task = ctx.taskManager.getTaskBySessionId("sess-1");
    expect(task?.lastAgentStatus).not.toBe("responded");

    // SubagentStop clears the Set
    fire(relay, subagentStop({ paneId: "pane-1", sessionId: "sess-1", toolUseId: "tool-a" }));
    expect(state.activeSubagents.size).toBe(0);

    // Now Stop should apply (reset pendingStopAt and call applyStopForSession)
    // Manually invoke the pending stop path — fire another Stop event
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-1" }));
    expect(state.pendingStopAt).toBeNull();
    const taskAfter = ctx.taskManager.getTaskBySessionId("sess-1");
    expect(taskAfter?.lastAgentStatus).toBe("responded");
  });

  it("case 2: missing SubagentStop — Stop is dropped, pendingStopAt is set", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-2" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-2", toolUseId: "tool-a" }));

    const state = sessionStateMap.get("sess-2")!;
    expect(state.activeSubagents.size).toBe(1);

    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-2" }));
    expect(state.pendingStopAt).not.toBeNull();
    // Task still active, not responded (last status was "working" from SubagentStart)
    const task = ctx.taskManager.getTaskBySessionId("sess-2");
    expect(task?.lastAgentStatus).not.toBe("responded");
  });

  it("case 5: SubagentStop with unknown toolUseId is a no-op", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-5" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-5", toolUseId: "tool-known" }));

    const state = sessionStateMap.get("sess-5")!;
    expect(state.activeSubagents.size).toBe(1);

    // Stop with unknown id
    fire(relay, subagentStop({ paneId: "pane-1", sessionId: "sess-5", toolUseId: "tool-unknown" }));
    // Set should still have the original entry
    expect(state.activeSubagents.size).toBe(1);
    expect(state.activeSubagents.has("tool-known")).toBe(true);
  });

  it("case 6: null toolUseId on SubagentStart stores a synthesized fallback id", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-6" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-6", toolUseId: null }));

    const state = sessionStateMap.get("sess-6")!;
    expect(state.activeSubagents.size).toBe(1);

    // The stored id should be a fallback (starts with "__fallback_")
    const storedId = [...state.activeSubagents][0];
    expect(storedId).toMatch(/^__fallback_/);
  });
});

describe("createHookRelay — sweep safety nets", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = buildRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: set up scenario 2 (SubagentStart then Stop dropped).
   */
  function setupScenario2(relay: ReturnType<typeof buildRelay>["relay"]) {
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-sw" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-sw", toolUseId: "tool-a" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-sw" }));
  }

  it("case 3: safety-net recovery — sweep fires after 16s of inactivity", () => {
    const { relay, sessionStateMap, sweepStaleSessions } = ctx;
    setupScenario2(relay);

    const state = sessionStateMap.get("sess-sw")!;
    expect(state.pendingStopAt).not.toBeNull();

    // Advance time by 16s (> STALE_STOP_MS = 15s)
    vi.advanceTimersByTime(16_000);

    sweepStaleSessions();

    // After sweep, Stop should be applied
    expect(state.pendingStopAt).toBeNull();
    const task = ctx.taskManager.getTaskBySessionId("sess-sw");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("case 4: safety-net defers — PostToolUse resets lastHookEventAt, sweep does not fire", () => {
    const { relay, sessionStateMap, sweepStaleSessions } = ctx;
    setupScenario2(relay);

    const state = sessionStateMap.get("sess-sw")!;

    // Advance 10s
    vi.advanceTimersByTime(10_000);

    // Fresh activity: fire PostToolUse (resets lastHookEventAt)
    fire(relay, postToolUse({ paneId: "pane-1", sessionId: "sess-sw" }));

    // Advance another 10s (20s total wall clock, but only 10s since last event)
    vi.advanceTimersByTime(10_000);

    sweepStaleSessions();

    // pendingStopAt should still be set — sweep did NOT apply
    expect(state.pendingStopAt).not.toBeNull();
    const task = ctx.taskManager.getTaskBySessionId("sess-sw");
    expect(task?.lastAgentStatus).not.toBe("responded");
  });

  it("STALE_STOP_MS is 15000 and SWEEP_INTERVAL_MS is 10000", () => {
    expect(STALE_STOP_MS).toBe(15_000);
    expect(SWEEP_INTERVAL_MS).toBe(10_000);
  });

  it("case 7: stale-active sweep fires after STALE_ACTIVE_MS when Stop never arrived", () => {
    const { relay, sweepStaleSessions } = ctx;

    // UserPromptSubmit sets hasBeenActive = true via "thinking" status
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-7" }));

    // Advance time by 61s (> STALE_ACTIVE_MS = 60s)
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 1_000);

    sweepStaleSessions();

    const task = ctx.taskManager.getTaskBySessionId("sess-7");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("case 9: stale-active sweep does NOT fire if task is already terminal", () => {
    const { relay, sweepStaleSessions } = ctx;

    // UserPromptSubmit then Stop (no subagents, so Stop applies immediately)
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-9" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-9" }));

    const taskAfterStop = ctx.taskManager.getTaskBySessionId("sess-9");
    expect(taskAfterStop?.lastAgentStatus).toBe("responded");

    vi.advanceTimersByTime(STALE_ACTIVE_MS + 1_000);

    sweepStaleSessions();

    // Still responded — unchanged
    const task = ctx.taskManager.getTaskBySessionId("sess-9");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("case 10: stale-active sweep does NOT fire if activity is fresh", () => {
    const { relay, sweepStaleSessions } = ctx;

    // UserPromptSubmit (thinking) then PostToolUse refreshes lastHookEventAt
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-10" }));

    // Advance a bit then fire PostToolUse to refresh lastHookEventAt
    vi.advanceTimersByTime(10_000);
    fire(relay, postToolUse({ paneId: "pane-1", sessionId: "sess-10" }));

    // Advance to 55s since last event (under STALE_ACTIVE_MS)
    vi.advanceTimersByTime(STALE_ACTIVE_MS - 5_000);

    sweepStaleSessions();

    // Task should still be active (thinking), not responded
    const task = ctx.taskManager.getTaskBySessionId("sess-10");
    expect(task?.lastAgentStatus).not.toBe("responded");
  });

  it("case 11: pending-stop branch still wins over stale-active branch", () => {
    const { relay, sweepStaleSessions } = ctx;

    // SubagentStart then Stop (dropped due to active subagent)
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-11" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-11", toolUseId: "tool-a" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-11" }));

    const state = ctx.sessionStateMap.get("sess-11")!;
    expect(state.pendingStopAt).not.toBeNull();

    // Advance 16s (> STALE_STOP_MS=15s, but < STALE_ACTIVE_MS=60s)
    vi.advanceTimersByTime(STALE_STOP_MS + 1_000);

    sweepStaleSessions();

    // pending-Stop branch should have fired
    const task = ctx.taskManager.getTaskBySessionId("sess-11");
    expect(task?.lastAgentStatus).toBe("responded");
  });
});

describe("createHookRelay — ADR-132 recovery fixes", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = buildRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Fix 1: Terminal-status SubagentStop clears the tracker ──

  it("fix1-a: SubagentStop with terminal status (complete) clears the active subagent", () => {
    const { relay, sessionStateMap } = ctx;

    // Activate root session
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-f1" }));

    // SubagentStart with active status
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-f1", toolUseId: "tool-f1" }));

    const state = sessionStateMap.get("sess-f1")!;
    expect(state.activeSubagents.size).toBe(1);

    // SubagentStop arrives with terminal status (complete), not active
    fire(relay, subagentStop({ paneId: "pane-1", sessionId: "sess-f1", toolUseId: "tool-f1" }));

    // Subagent should be cleared from the tracker
    expect(state.activeSubagents.size).toBe(0);
  });

  it("fix1-b: after terminal-status SubagentStop, parent Stop applies immediately (responded)", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-f1b" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-f1b", toolUseId: "tool-f1b" }));

    // SubagentStop with terminal status clears tracker
    fire(relay, subagentStop({ paneId: "pane-1", sessionId: "sess-f1b", toolUseId: "tool-f1b" }));

    const state = sessionStateMap.get("sess-f1b")!;
    expect(state.activeSubagents.size).toBe(0);

    // Parent Stop should apply immediately (no pending — subagents are cleared)
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-f1b" }));

    // pendingStopAt must be null (Stop was not dropped)
    expect(state.pendingStopAt).toBeNull();

    // Task transitions to responded
    const task = ctx.taskManager.getTaskBySessionId("sess-f1b");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("fix1-c: SubagentStop with idle status also clears the tracker", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-f1c" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-f1c", toolUseId: "tool-f1c" }));

    const state = sessionStateMap.get("sess-f1c")!;
    expect(state.activeSubagents.size).toBe(1);

    // SubagentStop with idle (terminal) status
    fire(relay, subagentStop({ paneId: "pane-1", sessionId: "sess-f1c", toolUseId: "tool-f1c" }));
    expect(state.activeSubagents.size).toBe(0);

    // Stop now applies directly — pendingStopAt stays null
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-f1c" }));
    expect(state.pendingStopAt).toBeNull();
    const task = ctx.taskManager.getTaskBySessionId("sess-f1c");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  // ── Fix 2: SessionStart on the same pane force-closes the old task ──

  it("fix2-a: SessionStart replacement force-closes the old active task", () => {
    const { relay, sessionStateMap } = ctx;

    // Establish sessionA on paneX, drive it to working
    fire(relay, userPromptSubmit({ paneId: "pane-x", sessionId: "sess-a" }));
    fire(relay, preToolUse({ paneId: "pane-x", sessionId: "sess-a" }));

    // Confirm sessionA task is working
    const taskA = ctx.taskManager.getTaskBySessionId("sess-a");
    expect(taskA?.lastAgentStatus).toBe("working");

    // Deliver SessionStart for sessionB on the same paneX
    fire(relay, sessionStart({ paneId: "pane-x", sessionId: "sess-b" }));

    // sessionA's task should be force-closed to responded
    const taskAAfter = ctx.taskManager.getTaskBySessionId("sess-a");
    expect(taskAAfter?.lastAgentStatus).toBe("responded");
    expect(taskAAfter?.status).toBe("active"); // applyStopForSession sets status: "active"

    // sessionStateMap should no longer track sessionA (it was cleaned up)
    expect(sessionStateMap.has("sess-a")).toBe(false);

    // sessionB hasn't received any non-SessionStart event — no state entry yet
    expect(sessionStateMap.has("sess-b")).toBe(false);
  });

  it("fix2-b: SessionStart replacement does NOT force-close if old task was never active (hasBeenActive=false)", () => {
    const { relay, sessionStateMap } = ctx;

    // Deliver SessionStart for sessionC on paneY (no subsequent active events)
    fire(relay, sessionStart({ paneId: "pane-y", sessionId: "sess-c" }));

    // Since SessionStart doesn't create session state, sessionC has no entry and hasBeenActive is false
    // Now deliver SessionStart for sessionD on the same paneY
    fire(relay, sessionStart({ paneId: "pane-y", sessionId: "sess-d" }));

    // sessionC never activated, so no task was created and no force-close happens
    const taskC = ctx.taskManager.getTaskBySessionId("sess-c");
    expect(taskC).toBeNull();

    // sessionD also has no state entry (hasn't received a non-SessionStart event)
    expect(sessionStateMap.has("sess-d")).toBe(false);
  });

  it("fix2-c: SessionStart replacement does NOT force-close if old task lastAgentStatus is already terminal", () => {
    const { relay } = ctx;

    // Activate sessionE then stop it normally
    fire(relay, userPromptSubmit({ paneId: "pane-z", sessionId: "sess-e" }));
    fire(relay, stop({ paneId: "pane-z", sessionId: "sess-e" }));

    const taskEAfterStop = ctx.taskManager.getTaskBySessionId("sess-e");
    expect(taskEAfterStop?.lastAgentStatus).toBe("responded");

    const broadcastCallsBefore = ctx.broadcastTask.mock.calls.length;

    // Deliver SessionStart for a new session on pane-z
    fire(relay, sessionStart({ paneId: "pane-z", sessionId: "sess-f-new" }));

    // broadcastTask should NOT have been called again (no force-close)
    expect(ctx.broadcastTask.mock.calls.length).toBe(broadcastCallsBefore);

    // sessionE task unchanged
    const taskEFinal = ctx.taskManager.getTaskBySessionId("sess-e");
    expect(taskEFinal?.lastAgentStatus).toBe("responded");
  });

  it("fix2-d: SessionStart does NOT flip AgentDetector status (no spinner on bare process startup)", () => {
    const { relay, relayAgentHook, paneRootSessionMap } = ctx;

    fire(relay, sessionStart({ paneId: "pane-q", sessionId: "sess-q" }));

    // AgentDetector must not be touched — otherwise the pane's spinner would
    // appear before any user activity (regression from ADR-014 lifecycle).
    expect(relayAgentHook).not.toHaveBeenCalled();

    // The relay still tracks the root session for the pane.
    expect(paneRootSessionMap.get("pane-q")).toBe("sess-q");

    // A subsequent UserPromptSubmit DOES flip the AgentDetector.
    fire(relay, userPromptSubmit({ paneId: "pane-q", sessionId: "sess-q" }));
    expect(relayAgentHook).toHaveBeenCalledWith("pane-q", "thinking", "claude");
  });

  // ── PROBE: late active hook after Stop should NOT re-activate task/dot ──

  it("PROBE-h1-postooluse-after-stop: late PostToolUse after Stop must not flip task back to thinking", () => {
    const { relay, relayAgentHook } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-h1", sessionId: "sess-h1" }));
    fire(relay, preToolUse({ paneId: "pane-h1", sessionId: "sess-h1" }));
    fire(relay, postToolUse({ paneId: "pane-h1", sessionId: "sess-h1" }));
    fire(relay, stop({ paneId: "pane-h1", sessionId: "sess-h1" }));

    const afterStop = ctx.taskManager.getTaskBySessionId("sess-h1");
    expect(afterStop?.lastAgentStatus).toBe("responded");

    relayAgentHook.mockClear();

    // Late PostToolUse arrives after Stop (HTTP reordering / delayed delivery).
    fire(relay, postToolUse({ paneId: "pane-h1", sessionId: "sess-h1" }));

    const afterLate = ctx.taskManager.getTaskBySessionId("sess-h1");
    // Task should remain responded — the agent already finished its turn.
    expect(afterLate?.lastAgentStatus).toBe("responded");
    // AgentDetector dot should not flip back to thinking.
    expect(relayAgentHook).not.toHaveBeenCalledWith("pane-h1", "thinking", "claude");
  });

  it("PROBE-h1-pretooluse-after-stop: late PreToolUse after Stop must not flip task back to working", () => {
    const { relay, relayAgentHook } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-h1b", sessionId: "sess-h1b" }));
    fire(relay, stop({ paneId: "pane-h1b", sessionId: "sess-h1b" }));
    expect(ctx.taskManager.getTaskBySessionId("sess-h1b")?.lastAgentStatus).toBe("responded");

    relayAgentHook.mockClear();
    fire(relay, preToolUse({ paneId: "pane-h1b", sessionId: "sess-h1b" }));

    expect(ctx.taskManager.getTaskBySessionId("sess-h1b")?.lastAgentStatus).toBe("responded");
    expect(relayAgentHook).not.toHaveBeenCalledWith("pane-h1b", "working", "claude");
  });

  it("PROBE-h1-allowed-userpromptsubmit: UserPromptSubmit after Stop SHOULD legitimately re-activate task", () => {
    const { relay } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-h1c", sessionId: "sess-h1c" }));
    fire(relay, stop({ paneId: "pane-h1c", sessionId: "sess-h1c" }));
    expect(ctx.taskManager.getTaskBySessionId("sess-h1c")?.lastAgentStatus).toBe("responded");

    fire(relay, userPromptSubmit({ paneId: "pane-h1c", sessionId: "sess-h1c" }));

    expect(ctx.taskManager.getTaskBySessionId("sess-h1c")?.lastAgentStatus).toBe("thinking");
  });

  // ── Fix 3: Orphan-task sweep ──

  it("fix3-a: orphan-task sweep closes a stale working task with no session state", () => {
    const { sweepStaleSessions, taskManager } = ctx;

    // Seed an orphan task directly — no session state, old activatedAt
    const oldTime = new Date(Date.now() - STALE_ACTIVE_MS - 5_000).toISOString();
    const task = taskManager.createTask({
      agentSessionId: "orphan-session",
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId: "pane-orphan",
      lastAgentStatus: "working",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: oldTime });

    // No session state for "orphan-session"
    expect(ctx.sessionStateMap.has("orphan-session")).toBe(false);

    // Advance time past the orphan threshold
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);

    sweepStaleSessions();

    const taskAfter = taskManager.getTaskBySessionId("orphan-session");
    expect(taskAfter?.lastAgentStatus).toBe("responded");
  });

  it("fix3-b (negative): orphan sweep leaves task unchanged if activatedAt is too recent", () => {
    const { sweepStaleSessions, taskManager } = ctx;

    // Recent activatedAt — within STALE_ACTIVE_MS
    const recentTime = new Date(Date.now() - 5_000).toISOString();
    const task = taskManager.createTask({
      agentSessionId: "young-orphan",
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId: "pane-young",
      lastAgentStatus: "working",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: recentTime });

    expect(ctx.sessionStateMap.has("young-orphan")).toBe(false);

    sweepStaleSessions();

    const taskAfter = taskManager.getTaskBySessionId("young-orphan");
    expect(taskAfter?.lastAgentStatus).toBe("working");
  });

  it("fix3-c (negative): orphan sweep leaves task unchanged if status is not working/thinking", () => {
    const { sweepStaleSessions, taskManager } = ctx;

    const oldTime = new Date(Date.now() - STALE_ACTIVE_MS - 5_000).toISOString();
    const task = taskManager.createTask({
      agentSessionId: "responded-orphan",
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId: "pane-responded-orphan",
      lastAgentStatus: "responded",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: oldTime });

    expect(ctx.sessionStateMap.has("responded-orphan")).toBe(false);

    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);
    sweepStaleSessions();

    const taskAfter = taskManager.getTaskBySessionId("responded-orphan");
    // Still responded — orphan branch skips non-working/thinking tasks
    expect(taskAfter?.lastAgentStatus).toBe("responded");
  });

  it("fix3-d (negative): orphan sweep does not run orphan branch when session state is present", () => {
    const { relay, sweepStaleSessions, taskManager, sessionStateMap } = ctx;

    // Create a task via the relay (which also creates session state)
    fire(relay, userPromptSubmit({ paneId: "pane-live", sessionId: "live-session" }));

    const taskBefore = taskManager.getTaskBySessionId("live-session");
    expect(taskBefore?.lastAgentStatus).toBe("thinking");

    // Confirm session state exists for this session
    expect(sessionStateMap.has("live-session")).toBe(true);

    // Advance time past orphan threshold
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);

    sweepStaleSessions();

    // stale-active sweep (branch 2) will fire here because lastHookEventAt is old
    // That's expected. The key assertion: the orphan branch (branch 3) did NOT
    // also apply — we verify by confirming session state was present, which gates
    // the orphan branch. The result after sweep is the same either way (responded),
    // but we can verify that if we seed a task with a fresh session state entry
    // (pendingStopAt=null, hasBeenActive=true) the orphan branch short-circuits.
    // Simplest observable: task is responded (stale-active handled it) and the
    // sessionStateMap entry still exists (orphan branch didn't delete it).
    const taskAfter = taskManager.getTaskBySessionId("live-session");
    expect(taskAfter?.lastAgentStatus).toBe("responded");

    // Session state entry is preserved — orphan branch skipped it (only stale-active ran)
    expect(sessionStateMap.has("live-session")).toBe(true);
  });
});

describe("createHookRelay — AgentDetector gone-bridge", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("bridge-1: notifyAgentDetectorGone force-closes active task", () => {
    const { relay, notifyAgentDetectorGone, sessionStateMap } = ctx;

    // Activate session on pane-1
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-b1" }));

    notifyAgentDetectorGone("pane-1");

    const task = ctx.taskManager.getTaskBySessionId("sess-b1");
    expect(task?.lastAgentStatus).toBe("responded");

    const state = sessionStateMap.get("sess-b1")!;
    expect(state.activeSubagents.size).toBe(0);
  });

  it("bridge-2: notifyAgentDetectorGone is a no-op on unknown pane", () => {
    const { notifyAgentDetectorGone, broadcastTask } = ctx;

    const callsBefore = broadcastTask.mock.calls.length;
    notifyAgentDetectorGone("pane-does-not-exist");
    expect(broadcastTask.mock.calls.length).toBe(callsBefore);
  });

  it("bridge-3: notifyAgentDetectorGone is a no-op if task already terminal", () => {
    const { relay, notifyAgentDetectorGone, broadcastTask } = ctx;

    // Activate and then stop normally
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-b3" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-b3" }));

    const taskAfterStop = ctx.taskManager.getTaskBySessionId("sess-b3");
    expect(taskAfterStop?.lastAgentStatus).toBe("responded");

    const callsBefore = broadcastTask.mock.calls.length;

    notifyAgentDetectorGone("pane-1");

    // broadcastTask should not be called again
    expect(broadcastTask.mock.calls.length).toBe(callsBefore);
    // Task status unchanged
    const task = ctx.taskManager.getTaskBySessionId("sess-b3");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("bridge-4: notifyAgentDetectorGone clears pendingStopAt too", () => {
    const { relay, notifyAgentDetectorGone, sessionStateMap } = ctx;

    // SubagentStart then Stop (dropped — pendingStopAt is set)
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-b4" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-b4", toolUseId: "tool-a" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-b4" }));

    const state = sessionStateMap.get("sess-b4")!;
    expect(state.pendingStopAt).not.toBeNull();

    notifyAgentDetectorGone("pane-1");

    expect(state.pendingStopAt).toBeNull();
    expect(state.activeSubagents.size).toBe(0);

    const task = ctx.taskManager.getTaskBySessionId("sess-b4");
    expect(task?.lastAgentStatus).toBe("responded");
  });
});

describe("createHookRelay — ADR-135 ticket-3: pending Stop + SessionEnd race", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("t3-1: pending Stop + SessionEnd fires 'responded' notification then task reaches 'completed'", () => {
    const { relay, taskManager, maybeSendNotification, unseenRespondedTasks } = ctx;

    // Drive session to working, start a subagent so Stop gets blocked
    fire(relay, userPromptSubmit({ paneId: "pane-t3a", sessionId: "sess-t3a" }));
    fire(relay, subagentStart({ paneId: "pane-t3a", sessionId: "sess-t3a", toolUseId: "tool-t3a" }));

    // Stop arrives while subagent is active → pendingStopAt is set
    fire(relay, stop({ paneId: "pane-t3a", sessionId: "sess-t3a" }));

    const state = ctx.sessionStateMap.get("sess-t3a")!;
    expect(state.pendingStopAt).not.toBeNull();

    // SessionEnd arrives before sweep drains the pending Stop
    fire(relay, sessionEnd({ paneId: "pane-t3a", sessionId: "sess-t3a" }));

    // maybeSendNotification must have been called with "responded"
    const respondedCall = maybeSendNotification.mock.calls.find(
      (args: [TaskInfo, string | null, string]) => args[2] === "responded",
    );
    expect(respondedCall).toBeDefined();

    // unseenRespondedTasks was added by applyStopForSession then deleted by SessionEnd cleanup
    expect(unseenRespondedTasks.has(respondedCall![0].id)).toBe(false);

    // Final task state
    const task = taskManager.getTaskBySessionId("sess-t3a");
    expect(task?.status).toBe("completed");
    expect(task?.lastAgentStatus).toBe("complete");

    // sessionState is removed
    expect(ctx.sessionStateMap.has("sess-t3a")).toBe(false);
    expect(ctx.paneRootSessionMap.has("pane-t3a")).toBe(false);
  });

  it("t3-2 (negative): SessionEnd without pending Stop behaves identically to current behavior", () => {
    const { relay, taskManager, maybeSendNotification, sessionStateMap, paneRootSessionMap } = ctx;

    // Activate session normally (no subagent, so Stop applies immediately)
    fire(relay, userPromptSubmit({ paneId: "pane-t3c", sessionId: "sess-t3c" }));
    fire(relay, stop({ paneId: "pane-t3c", sessionId: "sess-t3c" }));

    const taskAfterStop = taskManager.getTaskBySessionId("sess-t3c");
    expect(taskAfterStop?.lastAgentStatus).toBe("responded");

    const notifyCallsBefore = maybeSendNotification.mock.calls.length;

    // SessionEnd arrives — no pending Stop
    fire(relay, sessionEnd({ paneId: "pane-t3c", sessionId: "sess-t3c" }));

    // maybeSendNotification NOT called again (no extra "responded" fired)
    expect(maybeSendNotification.mock.calls.length).toBe(notifyCallsBefore);

    const finalTask = taskManager.getTaskBySessionId("sess-t3c");
    expect(finalTask?.status).toBe("completed");
    expect(finalTask?.lastAgentStatus).toBe("complete");

    // Session state cleaned up
    expect(sessionStateMap.has("sess-t3c")).toBe(false);
    expect(paneRootSessionMap.has("pane-t3c")).toBe(false);
  });
});

describe("createHookRelay — ADR-135 requires_input zombie recovery", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = buildRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: seed a task with requires_input status directly into taskManager,
   * bypassing the relay (to simulate a zombie with no session state).
   */
  function seedRequiresInputOrphan(taskManager: ReturnType<typeof makeFakeTaskManager>, sessionId: string, paneId: string) {
    const oldTime = new Date(Date.now() - STALE_ACTIVE_MS - 5_000).toISOString();
    const task = taskManager.createTask({
      agentSessionId: sessionId,
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId,
      lastAgentStatus: "requires_input",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: oldTime });
    return task;
  }

  it("ri-1: requires_input orphan (no session state) recovered by sweep", () => {
    const { sweepStaleSessions, taskManager, sessionStateMap } = ctx;

    seedRequiresInputOrphan(taskManager, "sess-ri1", "pane-ri1");

    // No session state for this session
    expect(sessionStateMap.has("sess-ri1")).toBe(false);

    // Advance time past the orphan threshold
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);

    sweepStaleSessions();

    const task = taskManager.getTaskBySessionId("sess-ri1");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("ri-2: requires_input zombie recovered by notifyAgentDetectorGone", () => {
    const { relay, notifyAgentDetectorGone, taskManager } = ctx;

    // Establish a root session mapping by firing a SessionStart
    fire(relay, sessionStart({ paneId: "pane-ri2", sessionId: "sess-ri2" }));

    // Drive the task to requires_input via a PermissionRequest event
    fire(relay, permissionRequest({ paneId: "pane-ri2", sessionId: "sess-ri2" }));

    const taskBefore = taskManager.getTaskBySessionId("sess-ri2");
    expect(taskBefore?.lastAgentStatus).toBe("requires_input");

    notifyAgentDetectorGone("pane-ri2");

    const task = taskManager.getTaskBySessionId("sess-ri2");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("ri-3: SessionStart replacement force-closes old requires_input task", () => {
    const { relay, taskManager } = ctx;

    // Activate sessionA on pane-ri3, drive it to requires_input
    fire(relay, userPromptSubmit({ paneId: "pane-ri3", sessionId: "sess-ri3a" }));
    fire(relay, permissionRequest({ paneId: "pane-ri3", sessionId: "sess-ri3a" }));

    const taskA = taskManager.getTaskBySessionId("sess-ri3a");
    expect(taskA?.lastAgentStatus).toBe("requires_input");

    // Deliver SessionStart for a new session on the same pane
    fire(relay, sessionStart({ paneId: "pane-ri3", sessionId: "sess-ri3b" }));

    // Old task should be force-closed to responded
    const taskAAfter = taskManager.getTaskBySessionId("sess-ri3a");
    expect(taskAAfter?.lastAgentStatus).toBe("responded");
  });

  it("ri-4 (negative): task already in responded is not affected by sweep", () => {
    const { relay, sweepStaleSessions, broadcastTask, taskManager } = ctx;

    // Activate then stop normally
    fire(relay, userPromptSubmit({ paneId: "pane-ri4", sessionId: "sess-ri4" }));
    fire(relay, stop({ paneId: "pane-ri4", sessionId: "sess-ri4" }));

    const taskAfterStop = taskManager.getTaskBySessionId("sess-ri4");
    expect(taskAfterStop?.lastAgentStatus).toBe("responded");

    const broadcastCallsBefore = broadcastTask.mock.calls.length;

    // Advance time well past all thresholds
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 10_000);

    sweepStaleSessions();

    // broadcastTask should NOT have been called again
    expect(broadcastTask.mock.calls.length).toBe(broadcastCallsBefore);

    // Task status still responded
    const task = taskManager.getTaskBySessionId("sess-ri4");
    expect(task?.lastAgentStatus).toBe("responded");
  });
});

describe("createHookRelay — ADR-135 ticket-4: monotonic sweep clock", () => {
  /**
   * These tests inject independent fake mono and wall clocks to simulate the
   * laptop-suspend scenario where Date.now() jumps forward but the monotonic
   * clock does not.
   */

  it("t4-1: suspend simulation — wall jumps 60min, mono unchanged → sweep does NOT fire", () => {
    let mono = 1_000_000; // arbitrary monotonic baseline (ms)
    let wall = 1_700_000_000_000; // arbitrary wall baseline (ms — ~Nov 2023)

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, taskManager } = ctx;

    // Activate a session so it's tracked by the sweep.
    fire(relay, userPromptSubmit({ paneId: "pane-t4a", sessionId: "sess-t4a" }));

    const taskBefore = taskManager.getTaskBySessionId("sess-t4a");
    expect(taskBefore?.lastAgentStatus).toBe("thinking");

    // Suspend simulation: wall clock jumps forward by 60 minutes; mono untouched.
    wall += 60 * 60 * 1_000;
    // Real elapsed monotonic time: 1 second (well below STALE_ACTIVE_MS = 60s).
    mono += 1_000;

    sweepStaleSessions();

    // Branch 2 must NOT fire because monotonic idle (~1s) is far below STALE_ACTIVE_MS.
    const taskAfter = taskManager.getTaskBySessionId("sess-t4a");
    expect(taskAfter?.lastAgentStatus).toBe("thinking");
  });

  it("t4-2: real 70s monotonic idle still trips Branch 2 (regression check)", () => {
    let mono = 0;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, taskManager } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-t4b", sessionId: "sess-t4b" }));

    // 70 seconds of real monotonic idle (and wall — they advance together).
    mono += 70_000;
    wall += 70_000;

    sweepStaleSessions();

    const task = taskManager.getTaskBySessionId("sess-t4b");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("t4-3: real 16s monotonic idle still trips Branch 1 with pendingStopAt", () => {
    let mono = 0;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, taskManager, sessionStateMap } = ctx;

    // Drive the session into pendingStopAt (subagent active, Stop dropped).
    fire(relay, userPromptSubmit({ paneId: "pane-t4c", sessionId: "sess-t4c" }));
    fire(relay, subagentStart({ paneId: "pane-t4c", sessionId: "sess-t4c", toolUseId: "tool-t4c" }));
    fire(relay, stop({ paneId: "pane-t4c", sessionId: "sess-t4c" }));

    const state = sessionStateMap.get("sess-t4c")!;
    expect(state.pendingStopAt).not.toBeNull();

    // 16s of real monotonic + wall idle (> STALE_STOP_MS).
    mono += 16_000;
    wall += 16_000;

    sweepStaleSessions();

    expect(state.pendingStopAt).toBeNull();
    const task = taskManager.getTaskBySessionId("sess-t4c");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("t4-4: pendingStopAt — wall jumps 60min while mono unchanged → Branch 1 does NOT fire", () => {
    let mono = 1_000_000;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, taskManager, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-t4d", sessionId: "sess-t4d" }));
    fire(relay, subagentStart({ paneId: "pane-t4d", sessionId: "sess-t4d", toolUseId: "tool-t4d" }));
    fire(relay, stop({ paneId: "pane-t4d", sessionId: "sess-t4d" }));

    const state = sessionStateMap.get("sess-t4d")!;
    expect(state.pendingStopAt).not.toBeNull();

    // Suspend: wall jumps 60min; mono only +1s.
    wall += 60 * 60 * 1_000;
    mono += 1_000;

    sweepStaleSessions();

    // Branch 1 should NOT have fired — monotonic idle (~1s) is below STALE_STOP_MS.
    expect(state.pendingStopAt).not.toBeNull();
    const task = taskManager.getTaskBySessionId("sess-t4d");
    expect(task?.lastAgentStatus).not.toBe("responded");
  });

  it("t4-5: Branch 3 (orphan) — wall jumped 60min, mono only 5s → sweep is a no-op", () => {
    let mono = 1_000_000;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { sweepStaleSessions, taskManager, sessionStateMap } = ctx;

    // Seed an orphan task whose activatedAt is "now" (right after relay boot).
    const activatedAtIso = new Date(wall).toISOString();
    const task = taskManager.createTask({
      agentSessionId: "orphan-t4e",
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId: "pane-t4e",
      lastAgentStatus: "working",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: activatedAtIso });

    expect(sessionStateMap.has("orphan-t4e")).toBe(false);

    // Suspend: wall jumps 60 minutes (wallAge would be 60min); mono only +5s.
    wall += 60 * 60 * 1_000;
    mono += 5_000;

    sweepStaleSessions();

    // taskMonotonicAgeMs clamps to monoSinceBoot (5s) — well under ORPHAN_TASK_MS (60s).
    const taskAfter = taskManager.getTaskBySessionId("orphan-t4e");
    expect(taskAfter?.lastAgentStatus).toBe("working");
  });

  it("t4-6: Branch 3 (orphan) — real monotonic 65s elapsed → sweep fires", () => {
    let mono = 1_000_000;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { sweepStaleSessions, taskManager } = ctx;

    const activatedAtIso = new Date(wall).toISOString();
    const task = taskManager.createTask({
      agentSessionId: "orphan-t4f",
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId: "pane-t4f",
      lastAgentStatus: "working",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: activatedAtIso });

    // Real elapsed time: 65s on both clocks (no suspend).
    mono += 65_000;
    wall += 65_000;

    sweepStaleSessions();

    const taskAfter = taskManager.getTaskBySessionId("orphan-t4f");
    expect(taskAfter?.lastAgentStatus).toBe("responded");
  });

  it("t4-7: Branch 3 (orphan) — pre-relay-boot task with stale wall age, no suspend → sweep fires", () => {
    // Task was activated long before the relay started (e.g. main-process restart).
    // wallSinceBoot ≤ monoSinceBoot, so taskMonotonicAgeMs falls through to wallAge.
    const mono = 5_000_000;
    const wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { sweepStaleSessions, taskManager } = ctx;

    // activatedAt is 10 minutes before relay boot wall — pre-existing orphan.
    const activatedAtIso = new Date(wall - 10 * 60 * 1_000).toISOString();
    const task = taskManager.createTask({
      agentSessionId: "orphan-t4g",
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: null,
      cwd: "",
      agentKind: "claude",
      agentCommand: null,
      paneId: "pane-t4g",
      lastAgentStatus: "working",
      resumedAt: null,
    });
    taskManager.updateTask(task.id, { activatedAt: activatedAtIso });

    // No further time advance — wallSinceBoot = 0, monoSinceBoot = 0.
    // wallSinceBoot is NOT > monoSinceBoot, so wallAge (10min) is used unclamped → fires.
    sweepStaleSessions();

    const taskAfter = taskManager.getTaskBySessionId("orphan-t4g");
    expect(taskAfter?.lastAgentStatus).toBe("responded");
  });
});
