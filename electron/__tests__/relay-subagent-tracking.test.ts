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
import type { AgentStatus, AgentKind } from "../terminal-host/types";

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

  return { createTask, updateTask, getTaskBySessionId, getTaskByPaneId, tasks };
}

// ── Relay builder ──

function buildRelay() {
  const taskManager = makeFakeTaskManager();
  const unseenRespondedTasks = new Set<string>();
  const unseenInputTasks = new Set<string>();
  const broadcastTask = vi.fn();
  const maybeSendNotification = vi.fn();
  const relayAgentHook = vi.fn();

  const deps: HookRelayDeps = {
    relayAgentHook,
    taskManager,
    getPaneContext: () => undefined,
    unseenRespondedTasks,
    unseenInputTasks,
    broadcastTask,
    maybeSendNotification,
  };

  const ctx = createHookRelay(deps);

  return {
    ...ctx,
    taskManager,
    unseenRespondedTasks,
    broadcastTask,
    relayAgentHook,
  };
}

// Shorthand event types
type FireArgs = [
  paneId: string,
  status: AgentStatus,
  kind: AgentKind,
  sessionId: string | null,
  eventType: string,
  toolUseId: string | null,
];

function fire(relay: ReturnType<typeof buildRelay>["relay"], ...args: FireArgs) {
  return relay(...args);
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
    fire(relay, "pane-1", "thinking", "claude", "sess-1", "UserPromptSubmit", null);

    // First SubagentStart
    fire(relay, "pane-1", "working", "claude", "sess-1", "SubagentStart", "tool-a");
    // Second SubagentStart with same id
    fire(relay, "pane-1", "working", "claude", "sess-1", "SubagentStart", "tool-a");

    const state = sessionStateMap.get("sess-1")!;
    expect(state.activeSubagents.size).toBe(1);

    // Stop is dropped because subagent is still running
    fire(relay, "pane-1", "responded", "claude", "sess-1", "Stop", null);
    expect(state.pendingStopAt).not.toBeNull();
    // Task should NOT be updated to responded yet
    const task = ctx.taskManager.getTaskBySessionId("sess-1");
    expect(task?.lastAgentStatus).not.toBe("responded");

    // SubagentStop clears the Set
    fire(relay, "pane-1", "thinking", "claude", "sess-1", "SubagentStop", "tool-a");
    expect(state.activeSubagents.size).toBe(0);

    // Now Stop should apply (reset pendingStopAt and call applyStopForSession)
    // Manually invoke the pending stop path — fire another Stop event
    fire(relay, "pane-1", "responded", "claude", "sess-1", "Stop", null);
    expect(state.pendingStopAt).toBeNull();
    const taskAfter = ctx.taskManager.getTaskBySessionId("sess-1");
    expect(taskAfter?.lastAgentStatus).toBe("responded");
  });

  it("case 2: missing SubagentStop — Stop is dropped, pendingStopAt is set", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, "pane-1", "thinking", "claude", "sess-2", "UserPromptSubmit", null);
    fire(relay, "pane-1", "working", "claude", "sess-2", "SubagentStart", "tool-a");

    const state = sessionStateMap.get("sess-2")!;
    expect(state.activeSubagents.size).toBe(1);

    fire(relay, "pane-1", "responded", "claude", "sess-2", "Stop", null);
    expect(state.pendingStopAt).not.toBeNull();
    // Task still active, not responded (last status was "working" from SubagentStart)
    const task = ctx.taskManager.getTaskBySessionId("sess-2");
    expect(task?.lastAgentStatus).not.toBe("responded");
  });

  it("case 5: SubagentStop with unknown toolUseId is a no-op", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, "pane-1", "thinking", "claude", "sess-5", "UserPromptSubmit", null);
    fire(relay, "pane-1", "working", "claude", "sess-5", "SubagentStart", "tool-known");

    const state = sessionStateMap.get("sess-5")!;
    expect(state.activeSubagents.size).toBe(1);

    // Stop with unknown id
    fire(relay, "pane-1", "thinking", "claude", "sess-5", "SubagentStop", "tool-unknown");
    // Set should still have the original entry
    expect(state.activeSubagents.size).toBe(1);
    expect(state.activeSubagents.has("tool-known")).toBe(true);
  });

  it("case 6: null toolUseId on SubagentStart stores a synthesized fallback id", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, "pane-1", "thinking", "claude", "sess-6", "UserPromptSubmit", null);
    fire(relay, "pane-1", "working", "claude", "sess-6", "SubagentStart", null);

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
    fire(relay, "pane-1", "thinking", "claude", "sess-sw", "UserPromptSubmit", null);
    fire(relay, "pane-1", "working", "claude", "sess-sw", "SubagentStart", "tool-a");
    fire(relay, "pane-1", "responded", "claude", "sess-sw", "Stop", null);
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
    fire(relay, "pane-1", "thinking", "claude", "sess-sw", "PostToolUse", null);

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
    fire(relay, "pane-1", "thinking", "claude", "sess-7", "UserPromptSubmit", null);

    // Advance time by 61s (> STALE_ACTIVE_MS = 60s)
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 1_000);

    sweepStaleSessions();

    const task = ctx.taskManager.getTaskBySessionId("sess-7");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("case 9: stale-active sweep does NOT fire if task is already terminal", () => {
    const { relay, sweepStaleSessions } = ctx;

    // UserPromptSubmit then Stop (no subagents, so Stop applies immediately)
    fire(relay, "pane-1", "thinking", "claude", "sess-9", "UserPromptSubmit", null);
    fire(relay, "pane-1", "responded", "claude", "sess-9", "Stop", null);

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
    fire(relay, "pane-1", "thinking", "claude", "sess-10", "UserPromptSubmit", null);

    // Advance a bit then fire PostToolUse to refresh lastHookEventAt
    vi.advanceTimersByTime(10_000);
    fire(relay, "pane-1", "thinking", "claude", "sess-10", "PostToolUse", null);

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
    fire(relay, "pane-1", "thinking", "claude", "sess-11", "UserPromptSubmit", null);
    fire(relay, "pane-1", "working", "claude", "sess-11", "SubagentStart", "tool-a");
    fire(relay, "pane-1", "responded", "claude", "sess-11", "Stop", null);

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

describe("createHookRelay — AgentDetector gone-bridge", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("bridge-1: notifyAgentDetectorGone force-closes active task", () => {
    const { relay, notifyAgentDetectorGone, sessionStateMap } = ctx;

    // Activate session on pane-1
    fire(relay, "pane-1", "thinking", "claude", "sess-b1", "UserPromptSubmit", null);

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
    fire(relay, "pane-1", "thinking", "claude", "sess-b3", "UserPromptSubmit", null);
    fire(relay, "pane-1", "responded", "claude", "sess-b3", "Stop", null);

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
    fire(relay, "pane-1", "thinking", "claude", "sess-b4", "UserPromptSubmit", null);
    fire(relay, "pane-1", "working", "claude", "sess-b4", "SubagentStart", "tool-a");
    fire(relay, "pane-1", "responded", "claude", "sess-b4", "Stop", null);

    const state = sessionStateMap.get("sess-b4")!;
    expect(state.pendingStopAt).not.toBeNull();

    notifyAgentDetectorGone("pane-1");

    expect(state.pendingStopAt).toBeNull();
    expect(state.activeSubagents.size).toBe(0);

    const task = ctx.taskManager.getTaskBySessionId("sess-b4");
    expect(task?.lastAgentStatus).toBe("responded");
  });
});
