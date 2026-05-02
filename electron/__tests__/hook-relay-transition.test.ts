/**
 * Transition-table tests for the pure state machine function.
 *
 * See ADR-139. Tests are organized by state/event pairs to pin invariants
 * directly. Each test case covers one transition cell and verifies the exact
 * effects and state delta.
 */

import { describe, it, expect } from "vitest";
import { transitionSession, type SessionState } from "../hook-relay-transition";
import type { AgentHookEvent } from "../agent-hook-events";
import type { TaskInfo } from "../task-persistence";

// ── Fixtures ──

const baseCtx = (extra: Partial<Record<string, any>> = {}) => ({
  paneRootSession: null,
  existingTask: null,
  nowMs: 1000,
  ...extra,
});

const activeState = (extra: Partial<SessionState> = {}): SessionState => ({
  phase: "active",
  activeSubagents: new Set(),
  lastHookEventAt: 0,
  ...extra,
});

const pendingStopState = (extra: Partial<SessionState> = {}): SessionState => ({
  phase: "pendingStop",
  activeSubagents: new Set(),
  lastHookEventAt: 0,
  ...extra,
});

const respondedState = (extra: Partial<SessionState> = {}): SessionState => ({
  phase: "responded",
  activeSubagents: new Set(),
  lastHookEventAt: 0,
  ...extra,
});

const task = (overrides: Partial<TaskInfo> = {}): TaskInfo => ({
  id: "task-1",
  agentSessionId: "sess-1",
  name: "test task",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  activatedAt: null,
  projectId: null,
  projectName: null,
  workspacePath: null,
  cwd: "",
  agentKind: "claude",
  agentCommand: null,
  paneId: "pane-1",
  lastAgentStatus: "thinking",
  resumedAt: null,
  ...overrides,
});

const respondedTask = (overrides: Partial<TaskInfo> = {}): TaskInfo =>
  task({ lastAgentStatus: "responded", ...overrides });

// ── Event builders ──

const sessionStart = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "SessionStart",
  status: "thinking",
});

const sessionEnd = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "SessionEnd",
  status: "idle",
});

const userPromptSubmit = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "UserPromptSubmit",
  status: "thinking",
});

const preToolUse = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "PreToolUse",
  status: "working",
});

const postToolUse = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "PostToolUse",
  status: "thinking",
});

const stop = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "Stop",
  status: "responded",
});

const stopFailure = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "StopFailure",
  status: "error",
});

const permissionRequest = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "PermissionRequest",
  status: "requires_input",
});

const notification = (sessionId: string | null = "sess-1"): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "Notification",
  status: "requires_input",
});

const subagentStart = (
  sessionId: string | null = "sess-1",
  toolUseId: string | null = "tool-1",
): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "SubagentStart",
  status: "working",
  toolUseId,
});

const subagentStop = (
  sessionId: string | null = "sess-1",
  toolUseId: string | null = "tool-1",
): AgentHookEvent => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude",
  type: "SubagentStop",
  status: "thinking",
  toolUseId,
});

// ── Tests ──

describe("transitionSession — Group A: fresh session (state: null)", () => {
  it("SessionStart with sessionId → SetPaneRoot, no RelayAgentHook, returns state: null", () => {
    const event = sessionStart("sess-1");
    const { state, effects } = transitionSession(null, event, baseCtx());

    expect(state).toBeNull();
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      kind: "SetPaneRoot",
      paneId: "pane-1",
      sessionId: "sess-1",
    });
    // Verify no RelayAgentHook
    expect(effects.some((e) => e.kind === "RelayAgentHook")).toBe(false);
  });

  it("SessionStart with null sessionId → no effects, returns state: null", () => {
    const event = sessionStart(null);
    const { state, effects } = transitionSession(null, event, baseCtx());

    expect(state).toBeNull();
    expect(effects).toHaveLength(0);
  });

  it("UserPromptSubmit on fresh session → RelayAgentHook + CreateTask, phase: active", () => {
    const event = userPromptSubmit("sess-1");
    const { state, effects } = transitionSession(
      null,
      event,
      baseCtx({ paneRootSession: null, existingTask: null }),
    );

    expect(state).not.toBeNull();
    expect(state?.phase).toBe("active");
    expect(state?.activeSubagents.size).toBe(0);

    // Effects in order: RelayAgentHook, SetPaneRoot, CreateTask
    expect(effects).toHaveLength(3);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "thinking",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "SetPaneRoot",
      paneId: "pane-1",
      sessionId: "sess-1",
    });
    expect(effects[2]).toEqual({
      kind: "CreateTask",
      sessionId: "sess-1",
      paneId: "pane-1",
      agentKind: "claude",
      status: "thinking",
    });
  });

  it("Stop on fresh session (no prior state) → no effects, no state change", () => {
    const event = stop("sess-1");
    const { state, effects } = transitionSession(
      null,
      event,
      baseCtx({ paneRootSession: "sess-1" }),
    );

    expect(state).toBeNull();
    expect(effects).toBe(effects); // Only RelayAgentHook, no ApplyStop
    expect(effects.some((e) => e.kind === "ApplyStop")).toBe(false);
  });

  it("SessionEnd on fresh session → no effects, no state change", () => {
    const event = sessionEnd("sess-1");
    const { state, effects } = transitionSession(
      null,
      event,
      baseCtx({ paneRootSession: "sess-1" }),
    );

    expect(state).toBeNull();
    expect(effects.some((e) => e.kind === "MarkCompleted")).toBe(false);
  });
});

describe("transitionSession — Group B: phase: active", () => {
  it("PostToolUse → RelayAgentHook + UpdateTaskActiveStatus, phase stays active", () => {
    const state = activeState();
    const event = postToolUse("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.phase).toBe("active");
    expect(effects).toHaveLength(2);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "thinking",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "UpdateTaskActiveStatus",
      sessionId: "sess-1",
      status: "thinking",
    });
  });

  it("PreToolUse → RelayAgentHook + UpdateTaskActiveStatus, phase stays active", () => {
    const state = activeState();
    const event = preToolUse("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.phase).toBe("active");
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "working",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "UpdateTaskActiveStatus",
      sessionId: "sess-1",
      status: "working",
    });
  });

  it("Stop with no subagents → RelayAgentHook + ApplyStop, phase → responded", () => {
    const state = activeState();
    const event = stop("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.phase).toBe("responded");
    expect(effects).toHaveLength(2);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "responded",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "ApplyStop",
      sessionId: "sess-1",
    });
  });

  it("Stop with active subagents → RelayAgentHook only, phase → pendingStop, no ApplyStop", () => {
    const state = activeState({ activeSubagents: new Set(["tool-1"]) });
    const event = stop("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.phase).toBe("pendingStop");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "responded",
      agentKind: "claude",
    });
    expect(effects.some((e) => e.kind === "ApplyStop")).toBe(false);
  });

  it("SubagentStart → RelayAgentHook + UpdateTaskActiveStatus, activeSubagents grows", () => {
    const state = activeState();
    const event = subagentStart("sess-1", "tool-a");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.activeSubagents.has("tool-a")).toBe(true);
    expect(nextState?.activeSubagents.size).toBe(1);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "working",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "UpdateTaskActiveStatus",
      sessionId: "sess-1",
      status: "working",
    });
  });

  it("SubagentStart with null toolUseId → uses synthesized fallback id", () => {
    const state = activeState();
    const event = subagentStart("sess-1", null);
    const { state: nextState } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    const stored = [...nextState!.activeSubagents][0];
    expect(stored).toMatch(/^__fallback_/);
  });

  it("SubagentStop with known toolUseId → set shrinks", () => {
    const state = activeState({ activeSubagents: new Set(["tool-a", "tool-b"]) });
    const event = subagentStop("sess-1", "tool-a");
    const { state: nextState } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.activeSubagents.has("tool-a")).toBe(false);
    expect(nextState?.activeSubagents.has("tool-b")).toBe(true);
    expect(nextState?.activeSubagents.size).toBe(1);
  });

  it("SubagentStop with unknown toolUseId → no-op on set", () => {
    const state = activeState({ activeSubagents: new Set(["tool-known"]) });
    const event = subagentStop("sess-1", "tool-unknown");
    const { state: nextState } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.activeSubagents.has("tool-known")).toBe(true);
    expect(nextState?.activeSubagents.size).toBe(1);
  });

  it("SessionStart with same paneRoot, different sessionId → ForceCloseOldSession + DeletePaneRoot + DeleteSessionState + SetPaneRoot, returns state: null", () => {
    const state = activeState();
    const event = sessionStart("sess-2");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ agentSessionId: "sess-1" }),
      }),
    );

    expect(nextState).toBeNull();
    expect(effects).toHaveLength(4);
    expect(effects[0]).toEqual({
      kind: "ForceCloseOldSession",
      sessionId: "sess-1",
    });
    expect(effects[1]).toEqual({
      kind: "DeletePaneRoot",
      paneId: "pane-1",
    });
    expect(effects[2]).toEqual({
      kind: "DeleteSessionState",
      sessionId: "sess-1",
    });
    expect(effects[3]).toEqual({
      kind: "SetPaneRoot",
      paneId: "pane-1",
      sessionId: "sess-2",
    });
  });

  it("SessionStart with no old root → just SetPaneRoot, returns state: null", () => {
    const state = activeState();
    const event = sessionStart("sess-2");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({ paneRootSession: null }),
    );

    expect(nextState).toBeNull();
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      kind: "SetPaneRoot",
      paneId: "pane-1",
      sessionId: "sess-2",
    });
  });
});

describe("transitionSession — Group C: phase: pendingStop", () => {
  it("SubagentStop that empties the set → RelayAgentHook + UpdateTaskActiveStatus, phase → active (SubagentStop is active status)", () => {
    const state = pendingStopState({ activeSubagents: new Set(["tool-1"]) });
    const event = subagentStop("sess-1", "tool-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState?.activeSubagents.size).toBe(0);
    // SubagentStop has status "thinking" which is ACTIVE_STATUS, so phase flips to active
    expect(nextState?.phase).toBe("active");
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "thinking",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "UpdateTaskActiveStatus",
      sessionId: "sess-1",
      status: "thinking",
    });
  });

  it("Stop again while pendingStop with no subagents → applies immediately, phase → responded", () => {
    const state = pendingStopState({ activeSubagents: new Set() });
    const event = stop("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    // Stop has terminal status, activeSubagents is empty so ApplyStop fires
    expect(nextState?.phase).toBe("responded");
    expect(effects).toHaveLength(2);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "responded",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "ApplyStop",
      sessionId: "sess-1",
    });
  });

  it("SessionEnd with pendingStop → ApplyStop + MarkCompleted + DeletePaneRoot, returns state: null", () => {
    const state = pendingStopState();
    const event = sessionEnd("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState).toBeNull();
    expect(effects).toHaveLength(4);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "idle",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "ApplyStop",
      sessionId: "sess-1",
    });
    expect(effects[2]).toEqual({
      kind: "MarkCompleted",
      sessionId: "sess-1",
    });
    expect(effects[3]).toEqual({
      kind: "DeletePaneRoot",
      paneId: "pane-1",
    });
  });
});

describe("transitionSession — Group D: phase: responded (late-event guard)", () => {
  it("PostToolUse on responded task → effects: [], state unchanged", () => {
    const state = respondedState();
    const event = postToolUse("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(0);
  });

  it("PreToolUse on responded task → effects: [], state unchanged", () => {
    const state = respondedState();
    const event = preToolUse("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(0);
  });

  it("PermissionRequest on responded task → effects: [], state unchanged", () => {
    const state = respondedState();
    const event = permissionRequest("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(0);
  });

  it("Notification on responded task → effects: [], state unchanged", () => {
    const state = respondedState();
    const event = notification("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(0);
  });

  it("UserPromptSubmit on responded task → RelayAgentHook + UpdateTaskActiveStatus, phase → active", () => {
    const state = respondedState();
    const event = userPromptSubmit("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState?.phase).toBe("active");
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "thinking",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "UpdateTaskActiveStatus",
      sessionId: "sess-1",
      status: "thinking",
    });
  });

  it("SessionEnd on responded → RelayAgentHook + MarkCompleted + DeletePaneRoot, returns state: null", () => {
    const state = respondedState();
    const event = sessionEnd("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState).toBeNull();
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "idle",
      agentKind: "claude",
    });
    expect(effects[1]).toEqual({
      kind: "MarkCompleted",
      sessionId: "sess-1",
    });
    expect(effects[2]).toEqual({
      kind: "DeletePaneRoot",
      paneId: "pane-1",
    });
  });

  it("SessionStart on responded → ForceCloseOldSession + DeletePaneRoot + DeleteSessionState + SetPaneRoot, returns state: null", () => {
    const state = respondedState();
    const event = sessionStart("sess-2");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: respondedTask(),
      }),
    );

    expect(nextState).toBeNull();
    expect(effects[0]).toEqual({
      kind: "ForceCloseOldSession",
      sessionId: "sess-1",
    });
    expect(effects[1]).toEqual({
      kind: "DeletePaneRoot",
      paneId: "pane-1",
    });
    expect(effects[2]).toEqual({
      kind: "DeleteSessionState",
      sessionId: "sess-1",
    });
    expect(effects[3]).toEqual({
      kind: "SetPaneRoot",
      paneId: "pane-1",
      sessionId: "sess-2",
    });
  });
});

describe("transitionSession — Group E: sessionId === null", () => {
  it("UserPromptSubmit with sessionId: null → RelayAgentHook only, no state changes", () => {
    const state = activeState();
    const event = userPromptSubmit(null);
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({ paneRootSession: null }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "thinking",
      agentKind: "claude",
    });
  });

  it("PostToolUse with sessionId: null → RelayAgentHook only, no state changes", () => {
    const state = activeState();
    const event = postToolUse(null);
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({ paneRootSession: null }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(1);
    expect(effects[0].kind).toBe("RelayAgentHook");
  });

  it("SessionStart with sessionId: null → no effects, returns state: null", () => {
    const state = activeState();
    const event = sessionStart(null);
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({ paneRootSession: null }),
    );

    // SessionStart always returns state: null, regardless of current state or sessionId value
    expect(nextState).toBeNull();
    expect(effects).toHaveLength(0);
  });
});

describe("transitionSession — Group F: subagent session detection", () => {
  it("Event with different sessionId than paneRootSession → RelayAgentHook only, no state or task work", () => {
    const state = activeState();
    const event = postToolUse("subagent-sess");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "root-sess",
        existingTask: null,
      }),
    );

    expect(nextState).toEqual(state);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      kind: "RelayAgentHook",
      paneId: "pane-1",
      status: "thinking",
      agentKind: "claude",
    });
    expect(effects.some((e) => e.kind === "CreateTask")).toBe(false);
    expect(effects.some((e) => e.kind === "UpdateTaskActiveStatus")).toBe(false);
  });

  it("UserPromptSubmit on subagent sessionId → RelayAgentHook only, no task ops", () => {
    const state = activeState();
    const event = userPromptSubmit("subagent-sess");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "root-sess",
        existingTask: null,
      }),
    );

    expect(nextState).toEqual(state);
    expect(effects.some((e) => e.kind === "CreateTask")).toBe(false);
  });
});

describe("transitionSession — Additional edge cases and invariants", () => {
  it("lastHookEventAt is stamped on every state change", () => {
    const state = activeState({ lastHookEventAt: 100 });
    const event = userPromptSubmit("sess-1");
    const { state: nextState } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task(),
        nowMs: 5000,
      }),
    );

    expect(nextState?.lastHookEventAt).toBe(5000);
  });

  it("freshActiveState sets lastHookEventAt to nowMs", () => {
    const event = userPromptSubmit("sess-1");
    const { state: nextState } = transitionSession(
      null,
      event,
      baseCtx({
        paneRootSession: null,
        existingTask: null,
        nowMs: 7000,
      }),
    );

    expect(nextState?.lastHookEventAt).toBe(7000);
  });

  it("activeSubagents Set is cloned on mutations", () => {
    const original = new Set(["tool-a"]);
    const state = activeState({ activeSubagents: original });
    const event = subagentStart("sess-1", "tool-b");
    const { state: nextState } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task(),
      }),
    );

    // Original set unchanged
    expect(original.size).toBe(1);
    // New state has a fresh set
    expect(nextState?.activeSubagents).not.toBe(original);
    expect(nextState?.activeSubagents.has("tool-a")).toBe(true);
    expect(nextState?.activeSubagents.has("tool-b")).toBe(true);
  });

  it("StopFailure returns MarkError effect and clears state", () => {
    const state = activeState();
    const event = stopFailure("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task({ lastAgentStatus: "thinking" }),
      }),
    );

    expect(nextState).toBeNull();
    expect(effects.some((e) => e.kind === "MarkError")).toBe(true);
  });

  it("PostToolUseFailure is treated like PostToolUse (active status, no special guard)", () => {
    const state = activeState();
    const event: AgentHookEvent = {
      paneId: "pane-1",
      sessionId: "sess-1",
      agentKind: "claude",
      type: "PostToolUseFailure",
      status: "thinking",
    };
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task(),
      }),
    );

    expect(nextState?.phase).toBe("active");
    expect(effects.some((e) => e.kind === "UpdateTaskActiveStatus")).toBe(true);
  });

  it("PermissionRequest is an active status and updates task", () => {
    const state = activeState();
    const event = permissionRequest("sess-1");
    const { state: nextState, effects } = transitionSession(
      state,
      event,
      baseCtx({
        paneRootSession: "sess-1",
        existingTask: task(),
      }),
    );

    expect(nextState?.phase).toBe("active");
    expect(effects[1]).toEqual({
      kind: "UpdateTaskActiveStatus",
      sessionId: "sess-1",
      status: "requires_input",
    });
  });
});
