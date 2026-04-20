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

describe("createHookRelay — stale-Stop safety-net sweep", () => {
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

  function runSweep(
    sessionStateMap: ReturnType<typeof buildRelay>["sessionStateMap"],
    applyStopForSession: ReturnType<typeof buildRelay>["applyStopForSession"],
  ) {
    const now = Date.now();
    for (const [sessionId, state] of sessionStateMap) {
      if (
        state.pendingStopAt !== null &&
        now - state.lastHookEventAt > STALE_STOP_MS
      ) {
        state.activeSubagents.clear();
        state.pendingStopAt = null;
        applyStopForSession(sessionId);
      }
    }
  }

  it("case 3: safety-net recovery — sweep fires after 16s of inactivity", () => {
    const { relay, sessionStateMap, applyStopForSession } = ctx;
    setupScenario2(relay);

    const state = sessionStateMap.get("sess-sw")!;
    expect(state.pendingStopAt).not.toBeNull();

    // Advance time by 16s (> STALE_STOP_MS = 15s)
    vi.advanceTimersByTime(16_000);

    runSweep(sessionStateMap, applyStopForSession);

    // After sweep, Stop should be applied
    expect(state.pendingStopAt).toBeNull();
    const task = ctx.taskManager.getTaskBySessionId("sess-sw");
    expect(task?.lastAgentStatus).toBe("responded");
  });

  it("case 4: safety-net defers — PostToolUse resets lastHookEventAt, sweep does not fire", () => {
    const { relay, sessionStateMap, applyStopForSession } = ctx;
    setupScenario2(relay);

    const state = sessionStateMap.get("sess-sw")!;

    // Advance 10s
    vi.advanceTimersByTime(10_000);

    // Fresh activity: fire PostToolUse (resets lastHookEventAt)
    fire(relay, "pane-1", "thinking", "claude", "sess-sw", "PostToolUse", null);

    // Advance another 10s (20s total wall clock, but only 10s since last event)
    vi.advanceTimersByTime(10_000);

    runSweep(sessionStateMap, applyStopForSession);

    // pendingStopAt should still be set — sweep did NOT apply
    expect(state.pendingStopAt).not.toBeNull();
    const task = ctx.taskManager.getTaskBySessionId("sess-sw");
    expect(task?.lastAgentStatus).not.toBe("responded");
  });

  it("STALE_STOP_MS is 15000 and SWEEP_INTERVAL_MS is 10000", () => {
    expect(STALE_STOP_MS).toBe(15_000);
    expect(SWEEP_INTERVAL_MS).toBe(10_000);
  });
});
