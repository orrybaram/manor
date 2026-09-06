import { describe, it, expect, beforeEach } from "vitest";

import {
  createSignalTracker,
  deltasForHookEvent,
  isKill,
  KILL_STATUSES,
  type SignalTrackerState,
  type StatDelta,
} from "../stats-signals";
import type { AgentHookEvent } from "../agent-hook-events";
import type { Effect } from "../hook-relay-transition";

describe("stats-signals", () => {
  describe("KILL_STATUSES", () => {
    it("covers exactly the in-flight and waiting statuses", () => {
      expect([...KILL_STATUSES].sort()).toEqual([
        "requires_input",
        "thinking",
        "working",
      ]);
    });
  });

  describe("isKill", () => {
    const cases: Array<{
      status: string;
      lastAgentStatus: string | null;
      expected: boolean;
    }> = [
      { status: "active", lastAgentStatus: "working", expected: true },
      { status: "active", lastAgentStatus: "thinking", expected: true },
      { status: "active", lastAgentStatus: "requires_input", expected: true },
      // Done means done — closing a finished agent is not a kill.
      { status: "active", lastAgentStatus: "responded", expected: false },
      { status: "active", lastAgentStatus: "idle", expected: false },
      { status: "active", lastAgentStatus: null, expected: false },
      // Only live agents can be killed.
      { status: "completed", lastAgentStatus: "working", expected: false },
      { status: "error", lastAgentStatus: "thinking", expected: false },
      { status: "abandoned", lastAgentStatus: "requires_input", expected: false },
    ];

    for (const { status, lastAgentStatus, expected } of cases) {
      it(`${status} + ${lastAgentStatus} → ${expected}`, () => {
        expect(isKill({ status, lastAgentStatus })).toBe(expected);
      });
    }

    it("ignores an unknown last status", () => {
      expect(isKill({ status: "active", lastAgentStatus: "daydreaming" })).toBe(false);
    });
  });
});

// ── Hook-event → deltas ──

function makeEvent(
  type: AgentHookEvent["type"],
  overrides: { sessionId?: string | null; paneId?: string } = {},
): AgentHookEvent {
  const base = {
    paneId: overrides.paneId ?? "pane-1",
    sessionId: overrides.sessionId === undefined ? "sess-1" : overrides.sessionId,
    agentKind: "claude" as const,
  };
  switch (type) {
    case "SubagentStart":
      return { ...base, type, status: "working", toolUseId: "tool-1" };
    case "SubagentStop":
      return { ...base, type, status: "thinking", toolUseId: "tool-1" };
    case "SessionStart":
      return { ...base, type, status: "thinking" };
    case "SessionEnd":
      return { ...base, type, status: "idle" };
    case "UserPromptSubmit":
      return { ...base, type, status: "thinking" };
    case "PreToolUse":
      return { ...base, type, status: "working" };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { ...base, type, status: "thinking" };
    case "Stop":
      return { ...base, type, status: "responded" };
    case "StopFailure":
      return { ...base, type, status: "error" };
    case "PermissionRequest":
    case "Notification":
      return { ...base, type, status: "requires_input" };
  }
}

const createAgentEffect = (sessionId = "sess-1"): Effect => ({
  kind: "CreateAgent",
  sessionId,
  paneId: "pane-1",
  agentKind: "claude",
  status: "thinking",
});

describe("deltasForHookEvent", () => {
  let tracker: SignalTrackerState;

  beforeEach(() => {
    tracker = createSignalTracker();
  });

  function run(
    event: AgentHookEvent,
    opts: { effects?: Effect[]; monoNow?: number; activeAgentCount?: number } = {},
  ): StatDelta[] {
    return deltasForHookEvent(event, opts.effects ?? [], tracker, {
      monoNow: opts.monoNow ?? 0,
      activeAgentCount: opts.activeAgentCount ?? 1,
    });
  }

  it("counts a prompt", () => {
    expect(run(makeEvent("UserPromptSubmit"))).toEqual([{ counter: "prompts", n: 1 }]);
  });

  it("counts a tool call", () => {
    expect(run(makeEvent("PreToolUse"))).toEqual([{ counter: "toolCalls", n: 1 }]);
  });

  it("counts a subagent", () => {
    expect(run(makeEvent("SubagentStart"))).toEqual([{ counter: "subagents", n: 1 }]);
  });

  it("counts a response on Stop", () => {
    expect(run(makeEvent("Stop"))).toEqual([{ counter: "agentsResponded", n: 1 }]);
  });

  it("ignores events that carry no signal", () => {
    expect(run(makeEvent("PostToolUse"))).toEqual([]);
    expect(run(makeEvent("SubagentStop"))).toEqual([]);
    expect(run(makeEvent("StopFailure"))).toEqual([]);
    expect(run(makeEvent("SessionStart"))).toEqual([]);
  });

  it("counts a block for both requires_input events", () => {
    expect(run(makeEvent("PermissionRequest"))).toEqual([{ counter: "blocks", n: 1 }]);
    tracker = createSignalTracker();
    expect(run(makeEvent("Notification"))).toEqual([{ counter: "blocks", n: 1 }]);
  });

  describe("unblock latency", () => {
    it("measures from the block to the next prompt", () => {
      run(makeEvent("Notification"), { monoNow: 1_000 });
      expect(run(makeEvent("UserPromptSubmit"), { monoNow: 4_500 })).toEqual([
        { counter: "prompts", n: 1 },
        { counter: "unblocks", n: 1 },
        { counter: "unblockMsTotal", n: 3_500 },
        { counter: "fastUnblocks", n: 1 },
      ]);
    });

    it("does not call exactly 10 000 ms fast", () => {
      run(makeEvent("Notification"), { monoNow: 0 });
      expect(run(makeEvent("UserPromptSubmit"), { monoNow: 10_000 })).toEqual([
        { counter: "prompts", n: 1 },
        { counter: "unblocks", n: 1 },
        { counter: "unblockMsTotal", n: 10_000 },
      ]);
    });

    it("clears the block, so a second prompt is not a second unblock", () => {
      run(makeEvent("PermissionRequest"), { monoNow: 0 });
      run(makeEvent("UserPromptSubmit"), { monoNow: 500 });
      expect(run(makeEvent("UserPromptSubmit"), { monoNow: 900 })).toEqual([
        { counter: "prompts", n: 1 },
      ]);
    });

    it("keeps the first timestamp when a session blocks again mid-wait", () => {
      run(makeEvent("Notification"), { monoNow: 1_000 });
      run(makeEvent("Notification"), { monoNow: 9_000 });
      run(makeEvent("PermissionRequest"), { monoNow: 11_000 });
      expect(run(makeEvent("UserPromptSubmit"), { monoNow: 21_000 })).toEqual([
        { counter: "prompts", n: 1 },
        { counter: "unblocks", n: 1 },
        { counter: "unblockMsTotal", n: 20_000 },
      ]);
    });

    it("tracks blocks per session", () => {
      run(makeEvent("Notification", { sessionId: "a" }), { monoNow: 0 });
      run(makeEvent("Notification", { sessionId: "b" }), { monoNow: 5_000 });
      expect(run(makeEvent("UserPromptSubmit", { sessionId: "b" }), { monoNow: 6_000 })).toEqual([
        { counter: "prompts", n: 1 },
        { counter: "unblocks", n: 1 },
        { counter: "unblockMsTotal", n: 1_000 },
        { counter: "fastUnblocks", n: 1 },
      ]);
      expect(tracker.blockedAt.get("a")).toBe(0);
    });

    it("drops the pending block on SessionEnd", () => {
      run(makeEvent("Notification"), { monoNow: 0 });
      expect(run(makeEvent("SessionEnd"), { monoNow: 100 })).toEqual([]);
      expect(tracker.blockedAt.size).toBe(0);
      expect(run(makeEvent("UserPromptSubmit"), { monoNow: 200 })).toEqual([
        { counter: "prompts", n: 1 },
      ]);
    });

    it("drops the pending block on a DeleteSessionState effect", () => {
      run(makeEvent("Notification"), { monoNow: 0 });
      const effects: Effect[] = [{ kind: "DeleteSessionState", sessionId: "sess-1" }];
      expect(run(makeEvent("Stop"), { effects, monoNow: 50 })).toEqual([
        { counter: "agentsResponded", n: 1 },
      ]);
      expect(tracker.blockedAt.size).toBe(0);
    });
  });

  describe("null session id", () => {
    it("still counts the event but never touches the block map", () => {
      expect(run(makeEvent("Notification", { sessionId: null }), { monoNow: 0 })).toEqual([
        { counter: "blocks", n: 1 },
      ]);
      expect(tracker.blockedAt.size).toBe(0);
      expect(run(makeEvent("UserPromptSubmit", { sessionId: null }), { monoNow: 1_000 })).toEqual([
        { counter: "prompts", n: 1 },
      ]);
      expect(run(makeEvent("PreToolUse", { sessionId: null }))).toEqual([
        { counter: "toolCalls", n: 1 },
      ]);
      expect(run(makeEvent("SessionEnd", { sessionId: null }))).toEqual([]);
    });
  });

  describe("CreateAgent effect", () => {
    it("counts a session and samples concurrency", () => {
      expect(
        run(makeEvent("SessionStart"), {
          effects: [createAgentEffect()],
          activeAgentCount: 3,
        }),
      ).toEqual([
        { counter: "agentSessions", n: 1 },
        { gauge: "maxConcurrentAgents", value: 3 },
      ]);
    });

    it("appends after the event's own deltas", () => {
      expect(
        run(makeEvent("UserPromptSubmit"), {
          effects: [createAgentEffect()],
          activeAgentCount: 2,
        }),
      ).toEqual([
        { counter: "prompts", n: 1 },
        { counter: "agentSessions", n: 1 },
        { gauge: "maxConcurrentAgents", value: 2 },
      ]);
    });

    it("ignores effects that carry no signal", () => {
      const effects: Effect[] = [
        { kind: "RelayAgentHook", paneId: "pane-1", status: "working", agentKind: "claude" },
        { kind: "SetPaneRoot", paneId: "pane-1", sessionId: "sess-1" },
        { kind: "UpdateAgentActiveStatus", sessionId: "sess-1", status: "working" },
      ];
      expect(run(makeEvent("PreToolUse"), { effects })).toEqual([
        { counter: "toolCalls", n: 1 },
      ]);
    });
  });
});
