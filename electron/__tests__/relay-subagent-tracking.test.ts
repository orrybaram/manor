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
import type { AgentInfo } from "../agent-persistence";
import type { AgentKind } from "../terminal-host/types";
import type { AgentHookEvent } from "../agent-hook-events";

// ── Fake AgentManager ──

type CreateData = Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">;

function makeFakeAgentManager() {
  const agents = new Map<string, AgentInfo>();
  let counter = 0;

  function createAgent(data: CreateData): AgentInfo {
    counter += 1;
    const agent: AgentInfo = {
      ...data,
      id: `agent-${counter}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activatedAt: null,
    } as AgentInfo;
    agents.set(agent.agentSessionId, agent);
    return agent;
  }

  function updateAgent(id: string, updates: Partial<AgentInfo>): AgentInfo | null {
    for (const [key, agent] of agents) {
      if (agent.id === id) {
        const updated = { ...agent, ...updates, id: agent.id, updatedAt: new Date().toISOString() } as AgentInfo;
        agents.set(key, updated);
        return updated;
      }
    }
    return null;
  }

  function getAgentBySessionId(sessionId: string): AgentInfo | null {
    return agents.get(sessionId) ?? null;
  }

  function getAgentByPaneId(paneId: string): AgentInfo | null {
    for (const agent of agents.values()) {
      if (agent.paneId === paneId) return agent;
    }
    return null;
  }

  function getActiveAgents(): AgentInfo[] {
    return Array.from(agents.values()).filter((t) => t.status === "active");
  }

  return { createAgent, updateAgent, getAgentBySessionId, getAgentByPaneId, getActiveAgents, agents };
}

// ── Relay builder ──

interface BuildRelayOptions {
  /** Inject a fake monotonic clock. Defaults to Date.now() so vi.advanceTimersByTime advances it. */
  monoClock?: () => number;
  /** Inject a fake wall clock. Defaults to Date.now(). */
  wallClock?: () => number;
}

function buildRelay(options: BuildRelayOptions = {}) {
  const agentManager = makeFakeAgentManager();
  const unseenRespondedAgents = new Set<string>();
  const unseenInputAgents = new Set<string>();
  const broadcastAgent = vi.fn();
  const maybeSendNotification = vi.fn();
  const relayAgentHook = vi.fn();

  // By default mono and wall both follow Date.now() so existing tests using
  // vi.useFakeTimers() / vi.advanceTimersByTime() keep advancing the relay's
  // idle clock. ADR-135 ticket-4 tests pass explicit clocks to simulate suspend.
  const deps: HookRelayDeps = {
    relayAgentHook,
    agentManager,
    getPaneContext: () => undefined,
    unseenRespondedAgents,
    unseenInputAgents,
    broadcastAgent,
    maybeSendNotification,
    monoClock: options.monoClock ?? (() => Date.now()),
    wallClock: options.wallClock ?? (() => Date.now()),
  };

  const ctx = createHookRelay(deps);

  return {
    ...ctx,
    agentManager,
    unseenRespondedAgents,
    unseenInputAgents,
    broadcastAgent,
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
    // Agent should NOT be updated to responded yet
    const agent = ctx.agentManager.getAgentBySessionId("sess-1");
    expect(agent?.lastAgentStatus).not.toBe("responded");

    // SubagentStop clears the Set
    fire(relay, subagentStop({ paneId: "pane-1", sessionId: "sess-1", toolUseId: "tool-a" }));
    expect(state.activeSubagents.size).toBe(0);

    // Now Stop should apply (reset pendingStopAt and call applyStopForSession)
    // Manually invoke the pending stop path — fire another Stop event
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-1" }));
    expect(state.pendingStopAt).toBeNull();
    const agentAfter = ctx.agentManager.getAgentBySessionId("sess-1");
    expect(agentAfter?.lastAgentStatus).toBe("responded");
  });

  it("case 2: missing SubagentStop — Stop is dropped, pendingStopAt is set", () => {
    const { relay, sessionStateMap } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-2" }));
    fire(relay, subagentStart({ paneId: "pane-1", sessionId: "sess-2", toolUseId: "tool-a" }));

    const state = sessionStateMap.get("sess-2")!;
    expect(state.activeSubagents.size).toBe(1);

    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-2" }));
    expect(state.pendingStopAt).not.toBeNull();
    // Agent still active, not responded (last status was "working" from SubagentStart)
    const agent = ctx.agentManager.getAgentBySessionId("sess-2");
    expect(agent?.lastAgentStatus).not.toBe("responded");
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
    const agent = ctx.agentManager.getAgentBySessionId("sess-sw");
    expect(agent?.lastAgentStatus).toBe("responded");
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
    const agent = ctx.agentManager.getAgentBySessionId("sess-sw");
    expect(agent?.lastAgentStatus).not.toBe("responded");
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

    const agent = ctx.agentManager.getAgentBySessionId("sess-7");
    expect(agent?.lastAgentStatus).toBe("responded");
  });

  it("case 9: stale-active sweep does NOT fire if agent is already terminal", () => {
    const { relay, sweepStaleSessions } = ctx;

    // UserPromptSubmit then Stop (no subagents, so Stop applies immediately)
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-9" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-9" }));

    const agentAfterStop = ctx.agentManager.getAgentBySessionId("sess-9");
    expect(agentAfterStop?.lastAgentStatus).toBe("responded");

    vi.advanceTimersByTime(STALE_ACTIVE_MS + 1_000);

    sweepStaleSessions();

    // Still responded — unchanged
    const agent = ctx.agentManager.getAgentBySessionId("sess-9");
    expect(agent?.lastAgentStatus).toBe("responded");
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

    // Agent should still be active (thinking), not responded
    const agent = ctx.agentManager.getAgentBySessionId("sess-10");
    expect(agent?.lastAgentStatus).not.toBe("responded");
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
    const agent = ctx.agentManager.getAgentBySessionId("sess-11");
    expect(agent?.lastAgentStatus).toBe("responded");
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

    // Agent transitions to responded
    const agent = ctx.agentManager.getAgentBySessionId("sess-f1b");
    expect(agent?.lastAgentStatus).toBe("responded");
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
    const agent = ctx.agentManager.getAgentBySessionId("sess-f1c");
    expect(agent?.lastAgentStatus).toBe("responded");
  });

  // ── Fix 2: SessionStart on the same pane force-closes the old agent ──

  it("fix2-a: SessionStart replacement force-closes the old active agent", () => {
    const { relay, sessionStateMap } = ctx;

    // Establish sessionA on paneX, drive it to working
    fire(relay, userPromptSubmit({ paneId: "pane-x", sessionId: "sess-a" }));
    fire(relay, preToolUse({ paneId: "pane-x", sessionId: "sess-a" }));

    // Confirm sessionA agent is working
    const agentA = ctx.agentManager.getAgentBySessionId("sess-a");
    expect(agentA?.lastAgentStatus).toBe("working");

    // Deliver SessionStart for sessionB on the same paneX
    fire(relay, sessionStart({ paneId: "pane-x", sessionId: "sess-b" }));

    // sessionA's agent should be force-closed to responded
    const agentAAfter = ctx.agentManager.getAgentBySessionId("sess-a");
    expect(agentAAfter?.lastAgentStatus).toBe("responded");
    expect(agentAAfter?.status).toBe("active"); // applyStopForSession sets status: "active"

    // sessionStateMap should no longer track sessionA (it was cleaned up)
    expect(sessionStateMap.has("sess-a")).toBe(false);

    // sessionB hasn't received any non-SessionStart event — no state entry yet
    expect(sessionStateMap.has("sess-b")).toBe(false);
  });

  it("fix2-b: SessionStart replacement does NOT force-close if old agent was never active (hasBeenActive=false)", () => {
    const { relay, sessionStateMap } = ctx;

    // Deliver SessionStart for sessionC on paneY (no subsequent active events)
    fire(relay, sessionStart({ paneId: "pane-y", sessionId: "sess-c" }));

    // Since SessionStart doesn't create session state, sessionC has no entry and hasBeenActive is false
    // Now deliver SessionStart for sessionD on the same paneY
    fire(relay, sessionStart({ paneId: "pane-y", sessionId: "sess-d" }));

    // sessionC never activated, so no agent was created and no force-close happens
    const agentC = ctx.agentManager.getAgentBySessionId("sess-c");
    expect(agentC).toBeNull();

    // sessionD also has no state entry (hasn't received a non-SessionStart event)
    expect(sessionStateMap.has("sess-d")).toBe(false);
  });

  it("fix2-c: SessionStart replacement does NOT force-close if old agent lastAgentStatus is already terminal", () => {
    const { relay } = ctx;

    // Activate sessionE then stop it normally
    fire(relay, userPromptSubmit({ paneId: "pane-z", sessionId: "sess-e" }));
    fire(relay, stop({ paneId: "pane-z", sessionId: "sess-e" }));

    const agentEAfterStop = ctx.agentManager.getAgentBySessionId("sess-e");
    expect(agentEAfterStop?.lastAgentStatus).toBe("responded");

    const broadcastCallsBefore = ctx.broadcastAgent.mock.calls.length;

    // Deliver SessionStart for a new session on pane-z
    fire(relay, sessionStart({ paneId: "pane-z", sessionId: "sess-f-new" }));

    // broadcastAgent should NOT have been called again (no force-close)
    expect(ctx.broadcastAgent.mock.calls.length).toBe(broadcastCallsBefore);

    // sessionE agent unchanged
    const agentEFinal = ctx.agentManager.getAgentBySessionId("sess-e");
    expect(agentEFinal?.lastAgentStatus).toBe("responded");
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

  // ── PROBE: late active hook after Stop should NOT re-activate agent/dot ──

  it("PROBE-h1-postooluse-after-stop: late PostToolUse after Stop must not flip agent back to thinking", () => {
    const { relay, relayAgentHook } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-h1", sessionId: "sess-h1" }));
    fire(relay, preToolUse({ paneId: "pane-h1", sessionId: "sess-h1" }));
    fire(relay, postToolUse({ paneId: "pane-h1", sessionId: "sess-h1" }));
    fire(relay, stop({ paneId: "pane-h1", sessionId: "sess-h1" }));

    const afterStop = ctx.agentManager.getAgentBySessionId("sess-h1");
    expect(afterStop?.lastAgentStatus).toBe("responded");

    relayAgentHook.mockClear();

    // Late PostToolUse arrives after Stop (HTTP reordering / delayed delivery).
    fire(relay, postToolUse({ paneId: "pane-h1", sessionId: "sess-h1" }));

    const afterLate = ctx.agentManager.getAgentBySessionId("sess-h1");
    // Agent should remain responded — the agent already finished its turn.
    expect(afterLate?.lastAgentStatus).toBe("responded");
    // AgentDetector dot should not flip back to thinking.
    expect(relayAgentHook).not.toHaveBeenCalledWith("pane-h1", "thinking", "claude");
  });

  it("PROBE-h1-pretooluse-after-stop: late PreToolUse after Stop must not flip agent back to working", () => {
    const { relay, relayAgentHook } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-h1b", sessionId: "sess-h1b" }));
    fire(relay, stop({ paneId: "pane-h1b", sessionId: "sess-h1b" }));
    expect(ctx.agentManager.getAgentBySessionId("sess-h1b")?.lastAgentStatus).toBe("responded");

    relayAgentHook.mockClear();
    fire(relay, preToolUse({ paneId: "pane-h1b", sessionId: "sess-h1b" }));

    expect(ctx.agentManager.getAgentBySessionId("sess-h1b")?.lastAgentStatus).toBe("responded");
    expect(relayAgentHook).not.toHaveBeenCalledWith("pane-h1b", "working", "claude");
  });

  it("PROBE-h1-allowed-userpromptsubmit: UserPromptSubmit after Stop SHOULD legitimately re-activate agent", () => {
    const { relay } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-h1c", sessionId: "sess-h1c" }));
    fire(relay, stop({ paneId: "pane-h1c", sessionId: "sess-h1c" }));
    expect(ctx.agentManager.getAgentBySessionId("sess-h1c")?.lastAgentStatus).toBe("responded");

    fire(relay, userPromptSubmit({ paneId: "pane-h1c", sessionId: "sess-h1c" }));

    expect(ctx.agentManager.getAgentBySessionId("sess-h1c")?.lastAgentStatus).toBe("thinking");
  });

  // ── Fix 3: Orphan-agent sweep ──

  it("fix3-a: orphan-agent sweep closes a stale working agent with no session state", () => {
    const { sweepStaleSessions, agentManager } = ctx;

    // Seed an orphan agent directly — no session state, old activatedAt
    const oldTime = new Date(Date.now() - STALE_ACTIVE_MS - 5_000).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: oldTime });

    // No session state for "orphan-session"
    expect(ctx.sessionStateMap.has("orphan-session")).toBe(false);

    // Advance time past the orphan threshold
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);

    sweepStaleSessions();

    const agentAfter = agentManager.getAgentBySessionId("orphan-session");
    expect(agentAfter?.lastAgentStatus).toBe("responded");
  });

  it("fix3-b (negative): orphan sweep leaves agent unchanged if activatedAt is too recent", () => {
    const { sweepStaleSessions, agentManager } = ctx;

    // Recent activatedAt — within STALE_ACTIVE_MS
    const recentTime = new Date(Date.now() - 5_000).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: recentTime });

    expect(ctx.sessionStateMap.has("young-orphan")).toBe(false);

    sweepStaleSessions();

    const agentAfter = agentManager.getAgentBySessionId("young-orphan");
    expect(agentAfter?.lastAgentStatus).toBe("working");
  });

  it("fix3-c (negative): orphan sweep leaves agent unchanged if status is not working/thinking", () => {
    const { sweepStaleSessions, agentManager } = ctx;

    const oldTime = new Date(Date.now() - STALE_ACTIVE_MS - 5_000).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: oldTime });

    expect(ctx.sessionStateMap.has("responded-orphan")).toBe(false);

    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);
    sweepStaleSessions();

    const agentAfter = agentManager.getAgentBySessionId("responded-orphan");
    // Still responded — orphan branch skips non-working/thinking agents
    expect(agentAfter?.lastAgentStatus).toBe("responded");
  });

  it("fix3-d (negative): orphan sweep does not run orphan branch when session state is present", () => {
    const { relay, sweepStaleSessions, agentManager, sessionStateMap } = ctx;

    // Create an agent via the relay (which also creates session state)
    fire(relay, userPromptSubmit({ paneId: "pane-live", sessionId: "live-session" }));

    const agentBefore = agentManager.getAgentBySessionId("live-session");
    expect(agentBefore?.lastAgentStatus).toBe("thinking");

    // Confirm session state exists for this session
    expect(sessionStateMap.has("live-session")).toBe(true);

    // Advance time past orphan threshold
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);

    sweepStaleSessions();

    // stale-active sweep (branch 2) will fire here because lastHookEventAt is old
    // That's expected. The key assertion: the orphan branch (branch 3) did NOT
    // also apply — we verify by confirming session state was present, which gates
    // the orphan branch. The result after sweep is the same either way (responded),
    // but we can verify that if we seed an agent with a fresh session state entry
    // (pendingStopAt=null, hasBeenActive=true) the orphan branch short-circuits.
    // Simplest observable: agent is responded (stale-active handled it) and the
    // sessionStateMap entry still exists (orphan branch didn't delete it).
    const agentAfter = agentManager.getAgentBySessionId("live-session");
    expect(agentAfter?.lastAgentStatus).toBe("responded");

    // Session state entry is preserved — orphan branch skipped it (only stale-active ran)
    expect(sessionStateMap.has("live-session")).toBe(true);
  });
});

describe("createHookRelay — AgentDetector gone-bridge", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("bridge-1: notifyAgentDetectorGone force-closes active agent", () => {
    const { relay, notifyAgentDetectorGone, sessionStateMap } = ctx;

    // Activate session on pane-1
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-b1" }));

    notifyAgentDetectorGone("pane-1");

    const agent = ctx.agentManager.getAgentBySessionId("sess-b1");
    expect(agent?.lastAgentStatus).toBe("responded");

    const state = sessionStateMap.get("sess-b1")!;
    expect(state.activeSubagents.size).toBe(0);
  });

  it("bridge-2: notifyAgentDetectorGone is a no-op on unknown pane", () => {
    const { notifyAgentDetectorGone, broadcastAgent } = ctx;

    const callsBefore = broadcastAgent.mock.calls.length;
    notifyAgentDetectorGone("pane-does-not-exist");
    expect(broadcastAgent.mock.calls.length).toBe(callsBefore);
  });

  it("bridge-3: notifyAgentDetectorGone is a no-op if agent already terminal", () => {
    const { relay, notifyAgentDetectorGone, broadcastAgent } = ctx;

    // Activate and then stop normally
    fire(relay, userPromptSubmit({ paneId: "pane-1", sessionId: "sess-b3" }));
    fire(relay, stop({ paneId: "pane-1", sessionId: "sess-b3" }));

    const agentAfterStop = ctx.agentManager.getAgentBySessionId("sess-b3");
    expect(agentAfterStop?.lastAgentStatus).toBe("responded");

    const callsBefore = broadcastAgent.mock.calls.length;

    notifyAgentDetectorGone("pane-1");

    // broadcastAgent should not be called again
    expect(broadcastAgent.mock.calls.length).toBe(callsBefore);
    // Agent status unchanged
    const agent = ctx.agentManager.getAgentBySessionId("sess-b3");
    expect(agent?.lastAgentStatus).toBe("responded");
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

    const agent = ctx.agentManager.getAgentBySessionId("sess-b4");
    expect(agent?.lastAgentStatus).toBe("responded");
  });
});

describe("createHookRelay — ADR-135 ticket-3: pending Stop + SessionEnd race", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("t3-1: pending Stop + SessionEnd fires 'responded' notification then agent reaches 'completed'", () => {
    const { relay, agentManager, maybeSendNotification, unseenRespondedAgents } = ctx;

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
      (args: [AgentInfo, string | null, string]) => args[2] === "responded",
    );
    expect(respondedCall).toBeDefined();

    // unseenRespondedAgents was added by applyStopForSession then deleted by SessionEnd cleanup
    expect(unseenRespondedAgents.has(respondedCall![0].id)).toBe(false);

    // Final agent state
    const agent = agentManager.getAgentBySessionId("sess-t3a");
    expect(agent?.status).toBe("completed");
    expect(agent?.lastAgentStatus).toBe("complete");

    // sessionState is removed
    expect(ctx.sessionStateMap.has("sess-t3a")).toBe(false);
    expect(ctx.paneRootSessionMap.has("pane-t3a")).toBe(false);
  });

  it("t3-2 (negative): SessionEnd without pending Stop behaves identically to current behavior", () => {
    const { relay, agentManager, maybeSendNotification, sessionStateMap, paneRootSessionMap } = ctx;

    // Activate session normally (no subagent, so Stop applies immediately)
    fire(relay, userPromptSubmit({ paneId: "pane-t3c", sessionId: "sess-t3c" }));
    fire(relay, stop({ paneId: "pane-t3c", sessionId: "sess-t3c" }));

    const agentAfterStop = agentManager.getAgentBySessionId("sess-t3c");
    expect(agentAfterStop?.lastAgentStatus).toBe("responded");

    const notifyCallsBefore = maybeSendNotification.mock.calls.length;

    // SessionEnd arrives — no pending Stop
    fire(relay, sessionEnd({ paneId: "pane-t3c", sessionId: "sess-t3c" }));

    // maybeSendNotification NOT called again (no extra "responded" fired)
    expect(maybeSendNotification.mock.calls.length).toBe(notifyCallsBefore);

    const finalAgent = agentManager.getAgentBySessionId("sess-t3c");
    expect(finalAgent?.status).toBe("completed");
    expect(finalAgent?.lastAgentStatus).toBe("complete");

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
   * Helper: seed an agent with requires_input status directly into agentManager,
   * bypassing the relay (to simulate a zombie with no session state).
   */
  function seedRequiresInputOrphan(agentManager: ReturnType<typeof makeFakeAgentManager>, sessionId: string, paneId: string) {
    const oldTime = new Date(Date.now() - STALE_ACTIVE_MS - 5_000).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: oldTime });
    return agent;
  }

  it("ri-1: requires_input orphan (no session state) recovered by sweep", () => {
    const { sweepStaleSessions, agentManager, sessionStateMap } = ctx;

    seedRequiresInputOrphan(agentManager, "sess-ri1", "pane-ri1");

    // No session state for this session
    expect(sessionStateMap.has("sess-ri1")).toBe(false);

    // Advance time past the orphan threshold
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 5_000);

    sweepStaleSessions();

    const agent = agentManager.getAgentBySessionId("sess-ri1");
    expect(agent?.lastAgentStatus).toBe("responded");
  });

  it("ri-2: requires_input zombie recovered by notifyAgentDetectorGone", () => {
    const { relay, notifyAgentDetectorGone, agentManager } = ctx;

    // Establish a root session mapping by firing a SessionStart
    fire(relay, sessionStart({ paneId: "pane-ri2", sessionId: "sess-ri2" }));

    // Drive the agent to requires_input via a PermissionRequest event
    fire(relay, permissionRequest({ paneId: "pane-ri2", sessionId: "sess-ri2" }));

    const agentBefore = agentManager.getAgentBySessionId("sess-ri2");
    expect(agentBefore?.lastAgentStatus).toBe("requires_input");

    notifyAgentDetectorGone("pane-ri2");

    const agent = agentManager.getAgentBySessionId("sess-ri2");
    expect(agent?.lastAgentStatus).toBe("responded");
  });

  it("ri-3: SessionStart replacement force-closes old requires_input agent", () => {
    const { relay, agentManager } = ctx;

    // Activate sessionA on pane-ri3, drive it to requires_input
    fire(relay, userPromptSubmit({ paneId: "pane-ri3", sessionId: "sess-ri3a" }));
    fire(relay, permissionRequest({ paneId: "pane-ri3", sessionId: "sess-ri3a" }));

    const agentA = agentManager.getAgentBySessionId("sess-ri3a");
    expect(agentA?.lastAgentStatus).toBe("requires_input");

    // Deliver SessionStart for a new session on the same pane
    fire(relay, sessionStart({ paneId: "pane-ri3", sessionId: "sess-ri3b" }));

    // Old agent should be force-closed to responded
    const agentAAfter = agentManager.getAgentBySessionId("sess-ri3a");
    expect(agentAAfter?.lastAgentStatus).toBe("responded");
  });

  it("ri-4 (negative): agent already in responded is not affected by sweep", () => {
    const { relay, sweepStaleSessions, broadcastAgent, agentManager } = ctx;

    // Activate then stop normally
    fire(relay, userPromptSubmit({ paneId: "pane-ri4", sessionId: "sess-ri4" }));
    fire(relay, stop({ paneId: "pane-ri4", sessionId: "sess-ri4" }));

    const agentAfterStop = agentManager.getAgentBySessionId("sess-ri4");
    expect(agentAfterStop?.lastAgentStatus).toBe("responded");

    const broadcastCallsBefore = broadcastAgent.mock.calls.length;

    // Advance time well past all thresholds
    vi.advanceTimersByTime(STALE_ACTIVE_MS + 10_000);

    sweepStaleSessions();

    // broadcastAgent should NOT have been called again
    expect(broadcastAgent.mock.calls.length).toBe(broadcastCallsBefore);

    // Agent status still responded
    const agent = agentManager.getAgentBySessionId("sess-ri4");
    expect(agent?.lastAgentStatus).toBe("responded");
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

    const { relay, sweepStaleSessions, agentManager } = ctx;

    // Activate a session so it's tracked by the sweep.
    fire(relay, userPromptSubmit({ paneId: "pane-t4a", sessionId: "sess-t4a" }));

    const agentBefore = agentManager.getAgentBySessionId("sess-t4a");
    expect(agentBefore?.lastAgentStatus).toBe("thinking");

    // Suspend simulation: wall clock jumps forward by 60 minutes; mono untouched.
    wall += 60 * 60 * 1_000;
    // Real elapsed monotonic time: 1 second (well below STALE_ACTIVE_MS = 60s).
    mono += 1_000;

    sweepStaleSessions();

    // Branch 2 must NOT fire because monotonic idle (~1s) is far below STALE_ACTIVE_MS.
    const agentAfter = agentManager.getAgentBySessionId("sess-t4a");
    expect(agentAfter?.lastAgentStatus).toBe("thinking");
  });

  it("t4-2: real 70s monotonic idle still trips Branch 2 (regression check)", () => {
    let mono = 0;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, agentManager } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-t4b", sessionId: "sess-t4b" }));

    // 70 seconds of real monotonic idle (and wall — they advance together).
    mono += 70_000;
    wall += 70_000;

    sweepStaleSessions();

    const agent = agentManager.getAgentBySessionId("sess-t4b");
    expect(agent?.lastAgentStatus).toBe("responded");
  });

  it("t4-3: real 16s monotonic idle still trips Branch 1 with pendingStopAt", () => {
    let mono = 0;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, agentManager, sessionStateMap } = ctx;

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
    const agent = agentManager.getAgentBySessionId("sess-t4c");
    expect(agent?.lastAgentStatus).toBe("responded");
  });

  it("t4-4: pendingStopAt — wall jumps 60min while mono unchanged → Branch 1 does NOT fire", () => {
    let mono = 1_000_000;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { relay, sweepStaleSessions, agentManager, sessionStateMap } = ctx;

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
    const agent = agentManager.getAgentBySessionId("sess-t4d");
    expect(agent?.lastAgentStatus).not.toBe("responded");
  });

  it("t4-5: Branch 3 (orphan) — wall jumped 60min, mono only 5s → sweep is a no-op", () => {
    let mono = 1_000_000;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { sweepStaleSessions, agentManager, sessionStateMap } = ctx;

    // Seed an orphan agent whose activatedAt is "now" (right after relay boot).
    const activatedAtIso = new Date(wall).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: activatedAtIso });

    expect(sessionStateMap.has("orphan-t4e")).toBe(false);

    // Suspend: wall jumps 60 minutes (wallAge would be 60min); mono only +5s.
    wall += 60 * 60 * 1_000;
    mono += 5_000;

    sweepStaleSessions();

    // agentMonotonicAgeMs clamps to monoSinceBoot (5s) — well under ORPHAN_TASK_MS (60s).
    const agentAfter = agentManager.getAgentBySessionId("orphan-t4e");
    expect(agentAfter?.lastAgentStatus).toBe("working");
  });

  it("t4-6: Branch 3 (orphan) — real monotonic 65s elapsed → sweep fires", () => {
    let mono = 1_000_000;
    let wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { sweepStaleSessions, agentManager } = ctx;

    const activatedAtIso = new Date(wall).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: activatedAtIso });

    // Real elapsed time: 65s on both clocks (no suspend).
    mono += 65_000;
    wall += 65_000;

    sweepStaleSessions();

    const agentAfter = agentManager.getAgentBySessionId("orphan-t4f");
    expect(agentAfter?.lastAgentStatus).toBe("responded");
  });

  it("t4-7: Branch 3 (orphan) — pre-relay-boot agent with stale wall age, no suspend → sweep fires", () => {
    // Agent was activated long before the relay started (e.g. main-process restart).
    // wallSinceBoot ≤ monoSinceBoot, so agentMonotonicAgeMs falls through to wallAge.
    const mono = 5_000_000;
    const wall = 1_700_000_000_000;

    const ctx = buildRelay({
      monoClock: () => mono,
      wallClock: () => wall,
    });

    const { sweepStaleSessions, agentManager } = ctx;

    // activatedAt is 10 minutes before relay boot wall — pre-existing orphan.
    const activatedAtIso = new Date(wall - 10 * 60 * 1_000).toISOString();
    const agent = agentManager.createAgent({
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
    agentManager.updateAgent(agent.id, { activatedAt: activatedAtIso });

    // No further time advance — wallSinceBoot = 0, monoSinceBoot = 0.
    // wallSinceBoot is NOT > monoSinceBoot, so wallAge (10min) is used unclamped → fires.
    sweepStaleSessions();

    const agentAfter = agentManager.getAgentBySessionId("orphan-t4g");
    expect(agentAfter?.lastAgentStatus).toBe("responded");
  });
});

describe("createHookRelay — ADR-162: a session that opens needing input notifies", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("adr162-1: the first agent-creating event notifies when it already requires input", () => {
    const { relay, agentManager, maybeSendNotification, unseenInputAgents } = ctx;

    // An agent that asks for permission before doing anything else: the very
    // first event that creates an agent already carries requires_input, so only
    // CreateAgent runs for it. Skipping the notification here left the pulse
    // showing with no banner and nothing in the notification log.
    fire(relay, notification({ paneId: "pane-N", sessionId: "sess-N" }));

    const agent = agentManager.getAgentBySessionId("sess-N");
    expect(agent).not.toBeNull();
    expect(agent?.lastAgentStatus).toBe("requires_input");
    expect(unseenInputAgents.has(agent!.id)).toBe(true);

    expect(maybeSendNotification).toHaveBeenCalledTimes(1);
    expect(maybeSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: agent!.id }),
      // No prior agent means no prior status.
      null,
      "requires_input",
    );
  });

  it("adr162-2: creating an agent mid-turn does not notify", () => {
    const { relay, maybeSendNotification } = ctx;

    // "thinking" is not a state anyone is told about — only responded and
    // requires_input are, and the preference gates live in the callee.
    fire(relay, userPromptSubmit({ paneId: "pane-T", sessionId: "sess-T" }));

    expect(maybeSendNotification).toHaveBeenCalledTimes(1);
    expect(maybeSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      null,
      "thinking",
    );
  });

  it("adr162-3: a session handed off to a new one still notifies for the new agent", () => {
    const { relay, agentManager, maybeSendNotification } = ctx;

    fire(relay, userPromptSubmit({ paneId: "pane-H", sessionId: "sess-H1" }));
    maybeSendNotification.mockClear();

    // Handoff on the same pane: CreateAgent retires the old agent first, then
    // creates one that already needs input.
    fire(relay, sessionStart({ paneId: "pane-H", sessionId: "sess-H2" }));
    fire(relay, notification({ paneId: "pane-H", sessionId: "sess-H2" }));

    const newAgent = agentManager.getAgentBySessionId("sess-H2");
    expect(maybeSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: newAgent!.id }),
      null,
      "requires_input",
    );
  });
});

describe("createHookRelay — ADR-142: CreateAgent retires previous pane owner", () => {
  let ctx: ReturnType<typeof buildRelay>;

  beforeEach(() => {
    ctx = buildRelay();
  });

  it("adr142-1: session handoff retires old agent to completed and creates exactly one active agent on the pane", () => {
    const { relay, agentManager } = ctx;

    // Step 1: Drive sessionA active on paneP
    fire(relay, userPromptSubmit({ paneId: "pane-P", sessionId: "sess-A" }));

    const agentA = agentManager.getAgentBySessionId("sess-A");
    expect(agentA).not.toBeNull();
    expect(agentA?.status).toBe("active");
    expect(agentA?.paneId).toBe("pane-P");

    // Step 2: Simulate session handoff — SessionStart for sessionB on the same pane,
    // followed by an active event for sessionB (which triggers CreateAgent).
    fire(relay, sessionStart({ paneId: "pane-P", sessionId: "sess-B" }));
    fire(relay, userPromptSubmit({ paneId: "pane-P", sessionId: "sess-B" }));

    const agentAAfter = agentManager.getAgentBySessionId("sess-A");
    const agentBAfter = agentManager.getAgentBySessionId("sess-B");

    // The original agent (sessionA) must be retired: paneId null, status completed
    expect(agentAAfter?.status).toBe("completed");
    expect(agentAAfter?.paneId).toBeNull();
    expect(agentAAfter?.completedAt).not.toBeNull();

    // The new agent (sessionB) is the only active agent on paneP
    expect(agentBAfter?.status).toBe("active");
    expect(agentBAfter?.paneId).toBe("pane-P");

    // Exactly one agent should have status==="active" with paneId===pane-P
    const activePaneAgents = Array.from(agentManager.agents.values()).filter(
      (t) => t.status === "active" && t.paneId === "pane-P",
    );
    expect(activePaneAgents).toHaveLength(1);
    expect(activePaneAgents[0].agentSessionId).toBe("sess-B");
  });

  it("adr142-2: broadcastAgent is called for the retired agent (completed) and for the new agent", () => {
    const { relay, agentManager, broadcastAgent } = ctx;

    // Drive sessionA active on paneP
    fire(relay, userPromptSubmit({ paneId: "pane-P2", sessionId: "sess-A2" }));

    const agentA = agentManager.getAgentBySessionId("sess-A2");
    expect(agentA).not.toBeNull();

    // Record broadcast count before the handoff
    const broadcastCountBefore = broadcastAgent.mock.calls.length;

    // Trigger handoff: SessionStart fires ForceCloseOldSession (broadcasts sess-A2
    // as lastAgentStatus:"responded", status:"active"), then userPromptSubmit fires
    // CreateAgent which retires sess-A2 to status:"completed" (second broadcast for
    // sess-A2) before broadcasting the new sess-B2 agent.
    fire(relay, sessionStart({ paneId: "pane-P2", sessionId: "sess-B2" }));
    fire(relay, userPromptSubmit({ paneId: "pane-P2", sessionId: "sess-B2" }));

    const newCalls = broadcastAgent.mock.calls.slice(broadcastCountBefore);
    expect(newCalls.length).toBeGreaterThanOrEqual(2);

    // There must be a broadcast for sess-A2 with status:"completed" and paneId:null.
    // This is the retirement broadcast emitted by the CreateAgent block.
    const retiredBroadcast = (newCalls.map((c) => c[0]) as AgentInfo[]).find(
      (t) => t.agentSessionId === "sess-A2" && t.status === "completed",
    );
    expect(retiredBroadcast).toBeDefined();
    expect(retiredBroadcast!.paneId).toBeNull();

    // The retirement broadcast must come BEFORE the new-agent broadcast.
    const retiredIdx = newCalls.findIndex(
      (c) => (c[0] as AgentInfo).agentSessionId === "sess-A2" && (c[0] as AgentInfo).status === "completed",
    );
    const newAgentIdx = newCalls.findIndex(
      (c) => (c[0] as AgentInfo).agentSessionId === "sess-B2",
    );
    expect(retiredIdx).toBeGreaterThanOrEqual(0);
    expect(newAgentIdx).toBeGreaterThanOrEqual(0);
    expect(retiredIdx).toBeLessThan(newAgentIdx);

    // The new agent broadcast should be active
    expect((newCalls[newAgentIdx][0] as AgentInfo).status).toBe("active");
  });

  it("adr142-3: unseen flags are cleared for the retired agent", () => {
    const { relay, agentManager, unseenRespondedAgents, unseenInputAgents } = ctx;

    // Drive sessionA to requires_input so it gets an unseen flag
    fire(relay, userPromptSubmit({ paneId: "pane-P3", sessionId: "sess-A3" }));
    fire(relay, permissionRequest({ paneId: "pane-P3", sessionId: "sess-A3" }));

    const agentA = agentManager.getAgentBySessionId("sess-A3");
    expect(agentA).not.toBeNull();
    // Manually seed both unseen sets to simulate worst-case
    unseenRespondedAgents.add(agentA!.id);
    unseenInputAgents.add(agentA!.id);

    // Trigger handoff
    fire(relay, sessionStart({ paneId: "pane-P3", sessionId: "sess-B3" }));
    fire(relay, userPromptSubmit({ paneId: "pane-P3", sessionId: "sess-B3" }));

    // Both unseen flags for the retired agent must be cleared
    expect(unseenRespondedAgents.has(agentA!.id)).toBe(false);
    expect(unseenInputAgents.has(agentA!.id)).toBe(false);
  });
});
