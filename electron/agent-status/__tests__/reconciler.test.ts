/**
 * Transition-table and sequence tests for the Status reconciler (ADR-184).
 *
 * Groups A–F port every case of ADR-139's `hook-relay-transition.test.ts`
 * (no `complete`; `RelayAgentHook` → `PublishPaneStatus`, emitted only when
 * the pane's status or kind changes; ApplyStop / MarkCompleted / MarkError /
 * UpdateAgentActiveStatus → `PersistAgentStatus` transitions). The remaining
 * groups cover the new rows: child activity, Pane facts, ticks, user signals,
 * and sequences for the known divergences.
 */

import { describe, it, expect } from "vitest";
import {
  reconcile,
  initialPaneState,
  STALE_STOP_MS,
  STALE_ACTIVE_MS,
  HOOK_DEBOUNCE_MS,
} from "../reconciler";
import type {
  Effect,
  PaneAgentState,
  PaneFacts,
  ReconcileContext,
  ReconcileResult,
  StatusSignal,
} from "../types";
import type { AgentHookEvent } from "../../agent-hook-events";
import type { AgentInfo } from "../../agent-persistence";
import type { AgentKind } from "../../terminal-host/types";

// ── Fixtures ──

const PANE = "pane-1";

const pane = (extra: Partial<PaneAgentState> = {}): PaneAgentState => ({
  ...initialPaneState(PANE),
  ...extra,
});

/** A hook-driven root `sess-1` mid-turn. */
const activePane = (extra: Partial<PaneAgentState> = {}): PaneAgentState =>
  pane({
    rootSessionId: "sess-1",
    hookDriven: true,
    kind: "claude",
    phase: "active",
    status: "thinking",
    statusReason: "UserPromptSubmit hook",
    lastHookAt: 0,
    ...extra,
  });

const pendingStopPane = (extra: Partial<PaneAgentState> = {}): PaneAgentState =>
  activePane({ phase: "pendingStop", pendingStopAt: 0, ...extra });

const respondedPane = (extra: Partial<PaneAgentState> = {}): PaneAgentState =>
  activePane({ phase: "responded", status: "responded", statusReason: "Stop hook", ...extra });

const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "agent-1",
  agentSessionId: "sess-1",
  name: "test agent",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  activatedAt: null,
  projectId: null,
  projectName: null,
  workspacePath: null,
  cwd: "",
  agentKind: "claude",
  agentCommand: null,
  paneId: PANE,
  lastAgentStatus: "thinking",
  resumedAt: null,
  ...overrides,
});

const respondedAgent = (overrides: Partial<AgentInfo> = {}): AgentInfo =>
  agent({ lastAgentStatus: "responded", ...overrides });

const ctx = (extra: Partial<ReconcileContext> = {}): ReconcileContext => ({
  nowMs: 1000,
  existingAgent: null,
  ...extra,
});

// ── Signal builders ──

type SimpleType = Exclude<AgentHookEvent["type"], "SubagentStart" | "SubagentStop">;
const STATUS_OF: Record<SimpleType, AgentHookEvent["status"]> = {
  SessionStart: "thinking",
  SessionEnd: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "thinking",
  PostToolUseFailure: "thinking",
  Stop: "responded",
  StopFailure: "error",
  PermissionRequest: "requires_input",
  Notification: "requires_input",
};

function ev(
  type: SimpleType,
  sessionId: string | null = "sess-1",
  agentKind: AgentKind = "claude",
): AgentHookEvent {
  return { paneId: PANE, sessionId, agentKind, type, status: STATUS_OF[type] } as AgentHookEvent;
}

const subagentStart = (
  sessionId: string | null = "sess-1",
  toolUseId: string | null = "tool-1",
): AgentHookEvent => ({
  paneId: PANE,
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
  paneId: PANE,
  sessionId,
  agentKind: "claude",
  type: "SubagentStop",
  status: "thinking",
  toolUseId,
});

const hook = (event: AgentHookEvent): StatusSignal => ({ type: "hook", event });
const tick = (nowMs: number): StatusSignal => ({ type: "tick", nowMs });

const facts = (f: Partial<PaneFacts> = {}): StatusSignal => ({
  type: "paneFacts",
  facts: { foreground: null, title: null, outputHint: null, ...f },
});
const fg = (name: string, kind: AgentKind | null = null): PaneFacts["foreground"] => ({ name, kind });

const persisted = (effects: Effect[]) => effects.filter((e) => e.kind !== "PublishPaneStatus");
const published = (effects: Effect[]) => effects.filter((e) => e.kind === "PublishPaneStatus");
const respond = (sessionId = "sess-1"): Effect => ({
  kind: "PersistAgentStatus",
  sessionId,
  transition: { to: "responded" },
});

/**
 * Run signals in order, feeding each result's state into the next. The agent
 * store is simulated from the effects, so `existingAgent` follows along.
 */
function run(
  signals: Array<StatusSignal | { signal: StatusSignal; nowMs?: number; ageMs?: number }>,
  start: PaneAgentState = pane(),
  startAgent: AgentInfo | null = null,
): ReconcileResult[] {
  let state = start;
  let stored = startAgent;
  const results: ReconcileResult[] = [];
  let clock = 1000;
  for (const item of signals) {
    const { signal, nowMs, ageMs } = "signal" in item ? item : { signal: item, nowMs: undefined, ageMs: undefined };
    clock = nowMs ?? (signal.type === "tick" ? signal.nowMs : clock + 10);
    const sessionForHook = signal.type === "hook" ? signal.event.sessionId : null;
    const existingAgent =
      signal.type === "hook"
        ? stored && stored.agentSessionId === sessionForHook
          ? stored
          : null
        : stored;
    const r = reconcile(state, signal, { nowMs: clock, existingAgent, existingAgentAgeMs: ageMs });
    for (const e of r.effects) {
      if (e.kind === "CreateAgent") {
        stored = agent({ agentSessionId: e.sessionId, lastAgentStatus: e.status });
      } else if (e.kind === "PersistAgentStatus" && stored?.agentSessionId === e.sessionId) {
        const t = e.transition;
        stored =
          t.to === "active"
            ? { ...stored, status: "active", lastAgentStatus: t.status }
            : t.to === "responded"
              ? { ...stored, status: "active", lastAgentStatus: "responded" }
              : t.to === "completed"
                ? { ...stored, status: "completed", lastAgentStatus: "idle" }
                : t.to === "error"
                  ? { ...stored, status: "error", lastAgentStatus: "error" }
                  : { ...stored, status: "abandoned" };
      }
    }
    results.push(r);
    state = r.state;
  }
  return results;
}

const last = (rs: ReconcileResult[]) => rs[rs.length - 1];

// ── Group A: fresh pane (ported) ──

describe("reconcile — Group A: fresh pane (ported from ADR-139)", () => {
  it("SessionStart with sessionId → claims root, hook-driven, status stays idle", () => {
    const r = reconcile(pane(), hook(ev("SessionStart")), ctx());
    expect(r.state.rootSessionId).toBe("sess-1");
    expect(r.state.hookDriven).toBe(true);
    expect(r.state.phase).toBe("none");
    expect(r.status).toBe("idle");
    expect(persisted(r.effects)).toEqual([]);
    // Only the kind changed — the status is still idle.
    expect(published(r.effects)).toEqual([
      { kind: "PublishPaneStatus", paneId: PANE, status: "idle", reason: "no agent", agentKind: "claude" },
    ]);
    expect(r.reason).toMatch(/SessionStart/);
  });

  it("SessionStart with null sessionId → no effects, state unchanged", () => {
    const start = pane();
    const r = reconcile(start, hook(ev("SessionStart", null)), ctx());
    expect(r.state).toEqual(start);
    expect(r.effects).toEqual([]);
    expect(r.reason).toMatch(/without a session id/);
  });

  it("UserPromptSubmit on fresh pane → Publish thinking + CreateAgent, phase active", () => {
    const r = reconcile(pane(), hook(ev("UserPromptSubmit")), ctx());
    expect(r.state.phase).toBe("active");
    expect(r.state.activeSubagents.size).toBe(0);
    expect(r.state.rootSessionId).toBe("sess-1");
    expect(r.state.hookDriven).toBe(true);
    expect(r.effects).toEqual([
      {
        kind: "PublishPaneStatus",
        paneId: PANE,
        status: "thinking",
        reason: "UserPromptSubmit hook",
        agentKind: "claude",
      },
      { kind: "CreateAgent", sessionId: "sess-1", paneId: PANE, agentKind: "claude", status: "thinking" },
    ]);
    expect(r.reason).toBe("UserPromptSubmit hook");
  });

  it("Stop on never-active root → dropped, no persistence", () => {
    const start = pane({ rootSessionId: "sess-1", hookDriven: true });
    const r = reconcile(start, hook(ev("Stop")), ctx());
    expect(r.state).toEqual(start);
    expect(r.effects).toEqual([]);
    expect(r.reason).toMatch(/never active/);
  });

  it("Stop on fresh pane → dropped and does not claim the root", () => {
    const r = reconcile(pane(), hook(ev("Stop")), ctx());
    expect(r.state.rootSessionId).toBeNull();
    expect(r.state.hookDriven).toBe(false);
    expect(r.effects).toEqual([]);
  });

  it("SessionEnd on a root that was never active → no completion, pane forgets the root", () => {
    const r = reconcile(pane({ rootSessionId: "sess-1", hookDriven: true, kind: "claude" }), hook(ev("SessionEnd")), ctx());
    expect(persisted(r.effects)).toEqual([]);
    expect(r.state.rootSessionId).toBeNull();
    expect(r.state.hookDriven).toBe(false);
    expect(r.status).toBe("idle");
  });
});

// ── Group B: phase active (ported) ──

describe("reconcile — Group B: phase active (ported from ADR-139)", () => {
  it("PostToolUse → PersistAgentStatus active/thinking, no publish (status unchanged)", () => {
    const r = reconcile(activePane(), hook(ev("PostToolUse")), ctx({ existingAgent: agent() }));
    expect(r.state.phase).toBe("active");
    expect(r.effects).toEqual([
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "active", status: "thinking" } },
    ]);
  });

  it("PreToolUse → Publish working + PersistAgentStatus active/working", () => {
    const r = reconcile(activePane(), hook(ev("PreToolUse")), ctx({ existingAgent: agent() }));
    expect(r.state.phase).toBe("active");
    expect(r.status).toBe("working");
    expect(r.effects).toEqual([
      { kind: "PublishPaneStatus", paneId: PANE, status: "working", reason: "PreToolUse hook", agentKind: "claude" },
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "active", status: "working" } },
    ]);
  });

  it("Stop with no subagents → responded, phase responded", () => {
    const r = reconcile(activePane(), hook(ev("Stop")), ctx({ existingAgent: agent() }));
    expect(r.state.phase).toBe("responded");
    expect(r.status).toBe("responded");
    expect(r.effects).toEqual([
      { kind: "PublishPaneStatus", paneId: PANE, status: "responded", reason: "Stop hook", agentKind: "claude" },
      respond(),
    ]);
  });

  it("Stop with active subagents → held: phase pendingStop, status unchanged, no persistence", () => {
    const r = reconcile(
      activePane({ activeSubagents: new Set(["tool-1"]) }),
      hook(ev("Stop")),
      ctx({ existingAgent: agent(), nowMs: 4242 }),
    );
    expect(r.state.phase).toBe("pendingStop");
    expect(r.state.pendingStopAt).toBe(4242);
    expect(r.status).toBe("thinking");
    expect(r.effects).toEqual([]);
    expect(r.reason).toBe("Stop hook held: 1 subagent active");
  });

  it("SubagentStart → activeSubagents grows, Publish working + persist", () => {
    const r = reconcile(activePane(), hook(subagentStart("sess-1", "tool-a")), ctx({ existingAgent: agent() }));
    expect(r.state.activeSubagents.has("tool-a")).toBe(true);
    expect(r.state.activeSubagents.size).toBe(1);
    expect(persisted(r.effects)).toEqual([
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "active", status: "working" } },
    ]);
    expect(r.status).toBe("working");
  });

  it("SubagentStart with null toolUseId → synthesized fallback id", () => {
    const r = reconcile(activePane(), hook(subagentStart("sess-1", null)), ctx({ existingAgent: agent() }));
    expect([...r.state.activeSubagents][0]).toMatch(/^__fallback_/);
  });

  it("SubagentStop with known toolUseId → set shrinks", () => {
    const r = reconcile(
      activePane({ activeSubagents: new Set(["tool-a", "tool-b"]) }),
      hook(subagentStop("sess-1", "tool-a")),
      ctx({ existingAgent: agent() }),
    );
    expect([...r.state.activeSubagents]).toEqual(["tool-b"]);
  });

  it("SubagentStop with unknown toolUseId → no-op on set", () => {
    const r = reconcile(
      activePane({ activeSubagents: new Set(["tool-known"]) }),
      hook(subagentStop("sess-1", "tool-unknown")),
      ctx({ existingAgent: agent() }),
    );
    expect([...r.state.activeSubagents]).toEqual(["tool-known"]);
  });

  it("SubagentStop with null toolUseId → removes the first subagent", () => {
    const r = reconcile(
      activePane({ activeSubagents: new Set(["tool-a", "tool-b"]) }),
      hook(subagentStop("sess-1", null)),
      ctx({ existingAgent: agent() }),
    );
    expect([...r.state.activeSubagents]).toEqual(["tool-b"]);
  });

  it("SessionStart replacing an active root → old root forced responded, new root claimed", () => {
    const r = reconcile(
      activePane({ activeSubagents: new Set(["t"]), children: new Set(["child"]) }),
      hook(ev("SessionStart", "sess-2")),
      ctx(),
    );
    expect(r.state.rootSessionId).toBe("sess-2");
    expect(r.state.phase).toBe("none");
    expect(r.state.activeSubagents.size).toBe(0);
    expect(r.state.children.size).toBe(0);
    expect(r.state.hookDriven).toBe(true);
    expect(r.status).toBe("responded");
    expect(r.effects).toEqual([
      {
        kind: "PublishPaneStatus",
        paneId: PANE,
        status: "responded",
        reason: "previous session replaced by SessionStart",
        agentKind: "claude",
      },
      respond("sess-1"),
    ]);
  });

  it("SessionStart with no old root → just claims the root", () => {
    const r = reconcile(pane({ kind: "claude" }), hook(ev("SessionStart", "sess-2")), ctx());
    expect(r.state.rootSessionId).toBe("sess-2");
    expect(r.effects).toEqual([]);
  });

  it("SessionStart repeated for the same root → no-op on status", () => {
    const r = reconcile(activePane(), hook(ev("SessionStart", "sess-1")), ctx());
    expect(r.state.rootSessionId).toBe("sess-1");
    expect(r.state.phase).toBe("active");
    expect(r.effects).toEqual([]);
  });
});

// ── Group C: pendingStop (ported) ──

describe("reconcile — Group C: phase pendingStop (ported from ADR-139)", () => {
  it("SubagentStop that empties the set → phase active, pendingStopAt kept for the tick drain", () => {
    const r = reconcile(
      pendingStopPane({ activeSubagents: new Set(["tool-1"]), pendingStopAt: 500 }),
      hook(subagentStop("sess-1", "tool-1")),
      ctx({ existingAgent: agent() }),
    );
    expect(r.state.activeSubagents.size).toBe(0);
    expect(r.state.phase).toBe("active");
    expect(r.state.pendingStopAt).toBe(500);
    expect(persisted(r.effects)).toEqual([
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "active", status: "thinking" } },
    ]);
  });

  it("Stop again while pendingStop with no subagents → applies immediately", () => {
    const r = reconcile(pendingStopPane(), hook(ev("Stop")), ctx({ existingAgent: agent() }));
    expect(r.state.phase).toBe("responded");
    expect(r.state.pendingStopAt).toBeNull();
    expect(r.status).toBe("responded");
    expect(persisted(r.effects)).toEqual([respond()]);
  });

  it("Stop again while subagents still active keeps the original pendingStopAt", () => {
    const r = reconcile(
      pendingStopPane({ activeSubagents: new Set(["t"]), pendingStopAt: 7 }),
      hook(ev("Stop")),
      ctx({ nowMs: 9999 }),
    );
    expect(r.state.pendingStopAt).toBe(7);
  });

  it("SessionEnd with pendingStop → responded then completed, pane idle", () => {
    const r = reconcile(pendingStopPane(), hook(ev("SessionEnd")), ctx({ existingAgent: agent() }));
    expect(r.effects).toEqual([
      { kind: "PublishPaneStatus", paneId: PANE, status: "idle", reason: "SessionEnd hook", agentKind: null },
      respond(),
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "completed" } },
    ]);
    expect(r.state.rootSessionId).toBeNull();
    expect(r.state.phase).toBe("none");
    expect(r.state.hookDriven).toBe(false);
  });
});

// ── Group D: responded (ported) ──

describe("reconcile — Group D: phase responded, late-active guard (ported from ADR-139)", () => {
  for (const type of ["PostToolUse", "PreToolUse", "PermissionRequest", "Notification"] as const) {
    it(`${type} on responded agent → dropped, state unchanged`, () => {
      const start = respondedPane();
      const r = reconcile(start, hook(ev(type)), ctx({ existingAgent: respondedAgent() }));
      expect(r.state).toEqual(start);
      expect(r.effects).toEqual([]);
      expect(r.reason).toBe(`late ${type} hook after Stop ignored`);
    });
  }

  it("guard also fires from pane state alone (agent record not yet responded)", () => {
    const r = reconcile(respondedPane(), hook(ev("PreToolUse")), ctx({ existingAgent: agent() }));
    expect(r.effects).toEqual([]);
    expect(r.status).toBe("responded");
  });

  it("UserPromptSubmit on responded agent → next turn: thinking, phase active", () => {
    const r = reconcile(respondedPane(), hook(ev("UserPromptSubmit")), ctx({ existingAgent: respondedAgent() }));
    expect(r.state.phase).toBe("active");
    expect(r.effects).toEqual([
      {
        kind: "PublishPaneStatus",
        paneId: PANE,
        status: "thinking",
        reason: "UserPromptSubmit hook",
        agentKind: "claude",
      },
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "active", status: "thinking" } },
    ]);
  });

  it("SessionEnd on responded → completed (no drain), pane idle", () => {
    const r = reconcile(respondedPane(), hook(ev("SessionEnd")), ctx({ existingAgent: respondedAgent() }));
    expect(persisted(r.effects)).toEqual([
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "completed" } },
    ]);
    expect(r.status).toBe("idle");
  });

  it("SessionStart replacing a responded root → no forced Stop, status unchanged", () => {
    const r = reconcile(respondedPane(), hook(ev("SessionStart", "sess-2")), ctx({ existingAgent: respondedAgent() }));
    expect(r.state.rootSessionId).toBe("sess-2");
    expect(r.state.phase).toBe("none");
    expect(r.effects).toEqual([]);
    expect(r.status).toBe("responded");
  });
});

// ── Group E: no session id (ported + new) ──

describe("reconcile — Group E: hook without a session id", () => {
  it("on a hook-driven pane → ignored", () => {
    const start = activePane();
    const r = reconcile(start, hook(ev("UserPromptSubmit", null)), ctx());
    expect(r.state).toEqual(start);
    expect(r.effects).toEqual([]);
    expect(r.reason).toMatch(/pane is hook-driven/);
  });

  it("on a pane that is not hook-driven → status applied, no persistence, not hook-driven", () => {
    const r = reconcile(pane(), hook(ev("PostToolUse", null)), ctx({ nowMs: 50 }));
    expect(r.status).toBe("thinking");
    expect(r.state.kind).toBe("claude");
    expect(r.state.hookDriven).toBe(false);
    expect(r.state.lastUnattributedHookAt).toBe(50);
    expect(persisted(r.effects)).toEqual([]);
  });

  it("Stop without session id and no turn in progress → ignored", () => {
    const r = reconcile(pane({ kind: "pi" }), hook(ev("Stop", null, "pi")), ctx());
    expect(r.status).toBe("idle");
  });

  it("Stop without session id after activity → responded; SessionEnd → idle, kind cleared", () => {
    const rs = run([hook(ev("PreToolUse", null, "pi")), hook(ev("Stop", null, "pi")), hook(ev("SessionEnd", null, "pi"))]);
    expect(rs.map((r) => r.status)).toEqual(["working", "responded", "idle"]);
    expect(last(rs).state.kind).toBeNull();
  });
});

// ── Group F: child sessions (ported + new) ──

describe("reconcile — Group F: child sessions", () => {
  it("child active hook → no persistence, child recorded", () => {
    const r = reconcile(activePane(), hook(ev("PostToolUse", "child-sess")), ctx());
    expect(persisted(r.effects)).toEqual([]);
    expect(r.state.children.has("child-sess")).toBe(true);
    expect(r.state.rootSessionId).toBe("sess-1");
  });

  it("child UserPromptSubmit → no CreateAgent", () => {
    const r = reconcile(activePane(), hook(ev("UserPromptSubmit", "child-sess")), ctx());
    expect(r.effects.some((e) => e.kind === "CreateAgent")).toBe(false);
  });

  it("child PreToolUse raises a thinking root turn to working", () => {
    const r = reconcile(activePane(), hook(ev("PreToolUse", "child-sess")), ctx());
    expect(r.status).toBe("working");
    expect(r.effects).toEqual([
      {
        kind: "PublishPaneStatus",
        paneId: PANE,
        status: "working",
        reason: "child session PreToolUse hook",
        agentKind: "claude",
      },
    ]);
  });

  it("child activity during a held Stop still shows", () => {
    const r = reconcile(pendingStopPane(), hook(ev("PreToolUse", "child-sess")), ctx());
    expect(r.status).toBe("working");
  });

  it("child activity does not override the root's requires_input", () => {
    const r = reconcile(
      activePane({ status: "requires_input", inputSessionId: "sess-1" }),
      hook(ev("PreToolUse", "child-sess")),
      ctx(),
    );
    expect(r.status).toBe("requires_input");
    expect(r.reason).toMatch(/another session requires input/);
  });

  it("child requires_input raises the pane to requires_input, owned by the child", () => {
    const r = reconcile(activePane(), hook(ev("PermissionRequest", "child-sess")), ctx());
    expect(r.status).toBe("requires_input");
    expect(r.state.inputSessionId).toBe("child-sess");
    expect(persisted(r.effects)).toEqual([]);
    expect(r.effects).toEqual([
      {
        kind: "PublishPaneStatus",
        paneId: PANE,
        status: "requires_input",
        reason: "child session PermissionRequest hook",
        agentKind: "claude",
      },
    ]);
  });

  it("child requires_input also shows during a held Stop", () => {
    const r = reconcile(pendingStopPane(), hook(ev("Notification", "child-sess")), ctx());
    expect(r.status).toBe("requires_input");
  });

  it("child requires_input after the root responded is ignored", () => {
    const r = reconcile(respondedPane(), hook(ev("PermissionRequest", "child-sess")), ctx());
    expect(r.status).toBe("responded");
  });

  it("child requires_input while the root already requires input keeps the root as owner", () => {
    const r = reconcile(
      activePane({ status: "requires_input", inputSessionId: "sess-1" }),
      hook(ev("PermissionRequest", "child-sess")),
      ctx(),
    );
    expect(r.state.inputSessionId).toBe("sess-1");
    expect(r.effects).toEqual([]);
  });

  it("the child that raised the prompt lowers it when it moves on", () => {
    const r = reconcile(
      activePane({ status: "requires_input", inputSessionId: "child-sess" }),
      hook(ev("PostToolUse", "child-sess")),
      ctx(),
    );
    expect(r.status).toBe("thinking");
    expect(r.state.inputSessionId).toBeNull();
  });

  it("another child cannot lower a child's prompt", () => {
    const r = reconcile(
      activePane({ status: "requires_input", inputSessionId: "child-a" }),
      hook(ev("PreToolUse", "child-b")),
      ctx(),
    );
    expect(r.status).toBe("requires_input");
  });

  it("a root hook takes over from a child's prompt", () => {
    const r = reconcile(
      activePane({ status: "requires_input", inputSessionId: "child-sess" }),
      hook(ev("PostToolUse")),
      ctx({ existingAgent: agent() }),
    );
    expect(r.status).toBe("thinking");
    expect(r.state.inputSessionId).toBeNull();
  });

  it("child activity after the root responded does not reopen the turn", () => {
    const r = reconcile(respondedPane(), hook(ev("PreToolUse", "child-sess")), ctx());
    expect(r.status).toBe("responded");
    expect(r.reason).toMatch(/root turn not in progress/);
  });

  for (const type of ["Stop", "StopFailure", "SessionEnd"] as const) {
    it(`child ${type} never ends the root's turn`, () => {
      const r = reconcile(activePane(), hook(ev(type, "child-sess")), ctx());
      expect(r.status).toBe("thinking");
      expect(r.state.phase).toBe("active");
      expect(persisted(r.effects)).toEqual([]);
      expect(r.reason).toMatch(/only the root session ends a turn/);
    });
  }
});

// ── Additional invariants (ported) ──

describe("reconcile — invariants", () => {
  it("lastHookAt is stamped on every root hook", () => {
    const r = reconcile(activePane({ lastHookAt: 100 }), hook(ev("UserPromptSubmit")), ctx({ existingAgent: agent(), nowMs: 5000 }));
    expect(r.state.lastHookAt).toBe(5000);
  });

  it("fresh turn stamps lastHookAt with nowMs", () => {
    const r = reconcile(pane(), hook(ev("UserPromptSubmit")), ctx({ nowMs: 7000 }));
    expect(r.state.lastHookAt).toBe(7000);
  });

  it("child hooks do not stamp lastHookAt", () => {
    const r = reconcile(activePane({ lastHookAt: 100 }), hook(ev("PreToolUse", "child")), ctx({ nowMs: 5000 }));
    expect(r.state.lastHookAt).toBe(100);
  });

  it("inputs are not mutated; Sets are copied on change", () => {
    const subs = new Set(["tool-a"]);
    const start = activePane({ activeSubagents: subs });
    const snapshot = JSON.stringify({ ...start, activeSubagents: [...subs], children: [] });
    const r = reconcile(start, hook(subagentStart("sess-1", "tool-b")), ctx({ existingAgent: agent() }));
    expect(subs.size).toBe(1);
    expect(r.state.activeSubagents).not.toBe(subs);
    expect([...r.state.activeSubagents]).toEqual(["tool-a", "tool-b"]);
    expect(JSON.stringify({ ...start, activeSubagents: [...start.activeSubagents], children: [] })).toBe(snapshot);
  });

  it("StopFailure → error, turn state dropped, root kept", () => {
    const r = reconcile(activePane(), hook(ev("StopFailure")), ctx({ existingAgent: agent() }));
    expect(r.state.phase).toBe("none");
    expect(r.state.rootSessionId).toBe("sess-1");
    expect(r.status).toBe("error");
    expect(persisted(r.effects)).toEqual([
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "error" } },
    ]);
  });

  it("PostToolUseFailure is treated like PostToolUse", () => {
    const r = reconcile(activePane(), hook(ev("PostToolUseFailure")), ctx({ existingAgent: agent() }));
    expect(r.state.phase).toBe("active");
    expect(persisted(r.effects)[0]).toMatchObject({ transition: { to: "active", status: "thinking" } });
  });

  it("PermissionRequest is an active status and persists requires_input", () => {
    const r = reconcile(activePane(), hook(ev("PermissionRequest")), ctx({ existingAgent: agent() }));
    expect(r.status).toBe("requires_input");
    expect(r.state.inputSessionId).toBe("sess-1");
    expect(persisted(r.effects)).toEqual([
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "active", status: "requires_input" } },
    ]);
  });

  it("every result carries a non-empty reason", () => {
    const signals: StatusSignal[] = [
      hook(ev("SessionStart")),
      hook(ev("UserPromptSubmit")),
      facts({ foreground: fg("claude", "claude") }),
      tick(1_000_000),
      { type: "user", action: "markSeen" },
      { type: "user", action: "abandon" },
    ];
    for (const r of run(signals)) expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ── Pane facts ──

describe("reconcile — Pane facts: liveness (every Agent)", () => {
  it("hook-driven active root, shell back in the foreground → idle, stuck Agent persisted responded", () => {
    const r = reconcile(
      activePane({ activeSubagents: new Set(["t"]), pendingStopAt: 5 }),
      facts({ foreground: fg("/bin/zsh") }),
      ctx({ existingAgent: agent({ lastAgentStatus: "working" }) }),
    );
    expect(r.status).toBe("idle");
    expect(r.reason).toBe("agent process exited");
    expect(r.state.hookDriven).toBe(false);
    expect(r.state.kind).toBeNull();
    expect(r.state.activeSubagents.size).toBe(0);
    expect(r.state.pendingStopAt).toBeNull();
    expect(r.state.phase).toBe("responded");
    expect(r.effects).toEqual([
      { kind: "PublishPaneStatus", paneId: PANE, status: "idle", reason: "agent process exited", agentKind: null },
      respond(),
    ]);
  });

  it("responded root, no foreground process → idle, nothing persisted (Agent not stuck)", () => {
    const r = reconcile(respondedPane(), facts({ foreground: null }), ctx({ existingAgent: respondedAgent() }));
    expect(r.status).toBe("idle");
    expect(persisted(r.effects)).toEqual([]);
  });

  it("active turn with a non-shell child process in the foreground → still alive", () => {
    const r = reconcile(activePane(), facts({ foreground: fg("node") }), ctx({ existingAgent: agent() }));
    expect(r.status).toBe("thinking");
  });

  it("responded turn with a non-agent, non-shell process in the foreground → gone", () => {
    const r = reconcile(respondedPane(), facts({ foreground: fg("vim") }), ctx({ existingAgent: respondedAgent() }));
    expect(r.status).toBe("idle");
  });

  it("agent process still in the foreground → alive", () => {
    const r = reconcile(respondedPane(), facts({ foreground: fg("claude", "claude") }), ctx());
    expect(r.status).toBe("responded");
    expect(r.state.hookDriven).toBe(true);
  });

  it("idle hook-driven pane with a shell foreground is left alone (hook may beat the process poll)", () => {
    const start = pane({ rootSessionId: "sess-1", hookDriven: true, kind: "claude" });
    const r = reconcile(start, facts({ foreground: fg("zsh") }), ctx());
    expect(r.state.hookDriven).toBe(true);
    expect(r.state.kind).toBe("claude");
  });

  it("error status is not cleared by the process leaving", () => {
    const r = reconcile(activePane({ status: "error", phase: "none" }), facts({ foreground: null }), ctx());
    expect(r.status).toBe("error");
  });
});

describe("reconcile — Pane facts on a hook-driven pane", () => {
  it("output hints and titles are ignored", () => {
    const r = reconcile(
      activePane(),
      facts({
        foreground: fg("claude", "claude"),
        title: "⠋ Working",
        outputHint: { hint: "requires_input", at: 1 },
      }),
      ctx(),
    );
    expect(r.status).toBe("thinking");
    expect(r.reason).toBe("pane facts ignored: pane is hook-driven");
    expect(r.state.lastFacts?.title).toBe("⠋ Working");
  });
});

describe("reconcile — Pane facts on a pane that is not hook-driven", () => {
  const opencode = fg("opencode", "opencode");

  it("agent process appears → kind tracked, idle", () => {
    const r = reconcile(pane(), facts({ foreground: opencode }), ctx());
    expect(r.state.kind).toBe("opencode");
    expect(r.status).toBe("idle");
    expect(r.effects).toEqual([
      { kind: "PublishPaneStatus", paneId: PANE, status: "idle", reason: "no agent", agentKind: "opencode" },
    ]);
  });

  it("hints are dropped when no agent is tracked", () => {
    const r = reconcile(pane(), facts({ foreground: fg("node"), outputHint: { hint: "thinking", at: 1 } }), ctx());
    expect(r.status).toBe("idle");
    expect(r.reason).toBe("no agent process in the foreground");
  });

  it("output hint decides the status", () => {
    const r = reconcile(pane({ kind: "opencode" }), facts({ foreground: opencode, outputHint: { hint: "thinking", at: 1 } }), ctx());
    expect(r.status).toBe("thinking");
    expect(r.reason).toBe("output hint: thinking");
  });

  it("the same hint (same `at`) is not re-applied", () => {
    const f: PaneFacts = { foreground: opencode, title: null, outputHint: { hint: "requires_input", at: 1 } };
    const start = pane({ kind: "opencode", status: "thinking", lastFacts: f });
    const r = reconcile(start, { type: "paneFacts", facts: f }, ctx());
    expect(r.status).toBe("thinking");
  });

  it("requires_input hint after responded is leftover prompt text → ignored", () => {
    const r = reconcile(
      pane({ kind: "opencode", status: "responded" }),
      facts({ foreground: opencode, outputHint: { hint: "requires_input", at: 5 } }),
      ctx(),
    );
    expect(r.status).toBe("responded");
    expect(r.reason).toMatch(/turn already responded/);
  });

  it("hints within HOOK_DEBOUNCE_MS of an unattributed hook are debounced", () => {
    const r = reconcile(
      pane({ kind: "opencode", status: "working", lastUnattributedHookAt: 1000 }),
      facts({ foreground: opencode, outputHint: { hint: "idle", at: 5 } }),
      ctx({ nowMs: 1000 + HOOK_DEBOUNCE_MS - 1 }),
    );
    expect(r.status).toBe("working");
    expect(r.reason).toMatch(/debounced/);
  });

  it("Claude title spinner → working; done marker → responded (Claude only)", () => {
    const claude = fg("claude", "claude");
    const rs = run([
      facts({ foreground: claude }),
      facts({ foreground: claude, title: "⠙ Fixing bug" }),
      facts({ foreground: claude, title: "✳ Fixing bug" }),
    ]);
    expect(rs.map((r) => r.status)).toEqual(["idle", "working", "responded"]);
    expect(last(rs).reason).toBe("title done marker");
  });

  it("title done marker does not finish a turn that never started", () => {
    const claude = fg("claude", "claude");
    const rs = run([facts({ foreground: claude }), facts({ foreground: claude, title: "✳ Claude Code" })]);
    expect(last(rs).status).toBe("idle");
  });

  it("title rules do not apply to other Agent kinds", () => {
    const r = reconcile(pane({ kind: "opencode", status: "thinking" }), facts({ foreground: opencode, title: "✳ Done" }), ctx());
    expect(r.status).toBe("thinking");
  });

  it("output hint wins over the title in the same snapshot", () => {
    const claude = fg("claude", "claude");
    const r = reconcile(
      pane({ kind: "claude", status: "idle" }),
      facts({ foreground: claude, title: "⠙ x", outputHint: { hint: "requires_input", at: 9 } }),
      ctx(),
    );
    expect(r.status).toBe("requires_input");
  });

  it("idle status with a shell back in the foreground clears the tracked kind", () => {
    const r = reconcile(pane({ kind: "opencode" }), facts({ foreground: fg("zsh") }), ctx());
    expect(r.state.kind).toBeNull();
    expect(r.status).toBe("idle");
  });
});

// ── Ticks ──

describe("reconcile — ticks", () => {
  it("T1: held Stop drained after STALE_STOP_MS of root quiet", () => {
    const start = pendingStopPane({ activeSubagents: new Set(["t"]), lastHookAt: 0, pendingStopAt: 0 });
    const early = reconcile(start, tick(STALE_STOP_MS), ctx({ existingAgent: agent() }));
    expect(early.effects).toEqual([]);
    expect(early.reason).toBe("tick: no time-based rule due");

    const r = reconcile(start, tick(STALE_STOP_MS + 1), ctx({ existingAgent: agent() }));
    expect(r.status).toBe("responded");
    expect(r.state.phase).toBe("responded");
    expect(r.state.activeSubagents.size).toBe(0);
    expect(r.state.pendingStopAt).toBeNull();
    expect(persisted(r.effects)).toEqual([respond()]);
    expect(r.reason).toMatch(/held Stop applied/);
  });

  it("T1 also drains a Stop held from before the last subagent finished (phase active)", () => {
    const start = activePane({ pendingStopAt: 0, lastHookAt: 100 });
    const r = reconcile(start, tick(100 + STALE_STOP_MS + 1), ctx({ existingAgent: agent() }));
    expect(r.status).toBe("responded");
  });

  it("T2: stuck-working recovery after STALE_ACTIVE_MS with the Agent still active", () => {
    const start = activePane({ status: "working", lastHookAt: 0 });
    const early = reconcile(start, tick(STALE_ACTIVE_MS), ctx({ existingAgent: agent({ lastAgentStatus: "working" }) }));
    expect(early.effects).toEqual([]);

    const r = reconcile(start, tick(STALE_ACTIVE_MS + 1), ctx({ existingAgent: agent({ lastAgentStatus: "working" }) }));
    expect(r.status).toBe("responded");
    expect(r.reason).toBe("no hook for 60s (stuck-working recovery)");
    expect(persisted(r.effects)).toEqual([respond()]);
  });

  it("T2 needs the root's Agent to be stuck active", () => {
    const start = activePane({ lastHookAt: 0 });
    const noAgent = reconcile(start, tick(STALE_ACTIVE_MS + 1), ctx());
    expect(noAgent.effects).toEqual([]);
    const otherAgent = reconcile(start, tick(STALE_ACTIVE_MS + 1), ctx({ existingAgent: agent({ agentSessionId: "other" }) }));
    expect(persisted(otherAgent.effects)).toEqual([]);
  });

  it("T2 does not fire on a responded turn", () => {
    const r = reconcile(respondedPane({ lastHookAt: 0 }), tick(STALE_ACTIVE_MS * 10), ctx({ existingAgent: respondedAgent() }));
    expect(r.effects).toEqual([]);
  });

  it("T3: orphaned active Agent (no turn state) forced responded at ORPHAN age", () => {
    const orphan = agent({ lastAgentStatus: "requires_input" });
    const young = reconcile(pane(), tick(1), ctx({ existingAgent: orphan, existingAgentAgeMs: STALE_ACTIVE_MS - 1 }));
    expect(young.effects).toEqual([]);

    const r = reconcile(pane(), tick(1), ctx({ existingAgent: orphan, existingAgentAgeMs: STALE_ACTIVE_MS }));
    expect(r.status).toBe("responded");
    expect(r.reason).toBe("orphaned agent recovered after 60s");
    expect(persisted(r.effects)).toEqual([respond()]);
  });

  it("T3 does not publish on a pane now owned by another root", () => {
    const orphan = agent({ agentSessionId: "old", lastAgentStatus: "working" });
    const start = pane({ rootSessionId: "new", hookDriven: true, kind: "claude" });
    const r = reconcile(start, tick(1), ctx({ existingAgent: orphan, existingAgentAgeMs: STALE_ACTIVE_MS }));
    expect(r.status).toBe("idle");
    expect(r.effects).toEqual([respond("old")]);
  });

  it("T3 skips Agents whose session has turn state, non-active lifecycles, and unknown age", () => {
    const withState = reconcile(activePane(), tick(1), ctx({ existingAgent: agent(), existingAgentAgeMs: 1e9 }));
    expect(withState.effects).toEqual([]);
    const abandoned = reconcile(pane(), tick(1), ctx({ existingAgent: agent({ status: "abandoned" }), existingAgentAgeMs: 1e9 }));
    expect(abandoned.effects).toEqual([]);
    const noAge = reconcile(pane(), tick(1), ctx({ existingAgent: agent() }));
    expect(noAge.effects).toEqual([]);
  });
});

// ── User signals ──

describe("reconcile — user signals", () => {
  for (const action of ["abandon", "end"] as const) {
    it(`${action}: active Agent → abandoned, pane idle and forgets its root`, () => {
      const r = reconcile(activePane(), { type: "user", action }, ctx({ existingAgent: agent() }));
      expect(r.status).toBe("idle");
      expect(r.state.rootSessionId).toBeNull();
      expect(r.state.hookDriven).toBe(false);
      expect(persisted(r.effects)).toEqual([
        { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "abandoned" } },
      ]);
    });

    it(`${action}: a completed Agent keeps its outcome`, () => {
      const r = reconcile(pane(), { type: "user", action }, ctx({ existingAgent: agent({ status: "completed" }) }));
      expect(persisted(r.effects)).toEqual([]);
    });
  }

  it("markSeen → MarkSeen effect, status unchanged", () => {
    const r = reconcile(respondedPane(), { type: "user", action: "markSeen" }, ctx({ existingAgent: respondedAgent() }));
    expect(r.effects).toEqual([{ kind: "MarkSeen", agentId: "agent-1" }]);
    expect(r.status).toBe("responded");
  });
});

// ── Sequences: the known divergences (ADR-184 Context) ──

describe("reconcile — sequences for the known divergences", () => {
  it("held Stop does not show responded until the subagents finish (drained by tick)", () => {
    const rs = run([
      { signal: hook(ev("UserPromptSubmit")), nowMs: 0 },
      { signal: hook(subagentStart()), nowMs: 10 },
      { signal: hook(ev("Stop")), nowMs: 20 },
      { signal: hook(subagentStop()), nowMs: 30 },
      tick(30 + STALE_STOP_MS + 1),
    ]);
    expect(rs.map((r) => r.status)).toEqual(["thinking", "working", "working", "thinking", "responded"]);
    expect(rs[2].reason).toBe("Stop hook held: 1 subagent active");
    expect(last(rs).reason).toMatch(/held Stop applied/);
    // Nothing persisted `responded` before the drain.
    const earlyResponds = rs.slice(0, 4).flatMap((r) => r.effects).filter((e) => e.kind === "PersistAgentStatus" && e.transition.to === "responded");
    expect(earlyResponds).toEqual([]);
  });

  it("held Stop then SessionEnd drains before completing", () => {
    const rs = run([hook(ev("UserPromptSubmit")), hook(subagentStart()), hook(ev("Stop")), hook(ev("SessionEnd"))]);
    expect(last(rs).status).toBe("idle");
    expect(persisted(last(rs).effects)).toEqual([
      respond(),
      { kind: "PersistAgentStatus", sessionId: "sess-1", transition: { to: "completed" } },
    ]);
  });

  it("a child session's Stop does not overwrite the root's dot", () => {
    const rs = run([
      hook(ev("UserPromptSubmit", "root")),
      hook(ev("PreToolUse", "root")),
      hook(ev("UserPromptSubmit", "child")),
      hook(ev("Stop", "child")),
      hook(ev("SessionEnd", "child")),
    ]);
    expect(rs.map((r) => r.status)).toEqual(["thinking", "working", "thinking", "thinking", "thinking"]);
    expect(rs[3].reason).toMatch(/only the root session ends a turn/);
    expect(last(rs).state.rootSessionId).toBe("root");
    expect(last(rs).state.children.has("child")).toBe(true);
  });

  it("a subagent's permission prompt is visible, clears when it moves on, and its Stop never ends the turn", () => {
    const rs = run([
      hook(ev("UserPromptSubmit", "root")),
      hook(ev("PreToolUse", "child")),
      hook(ev("PermissionRequest", "child")),
      hook(ev("PreToolUse", "child")),
      hook(ev("Stop", "child")),
      hook(ev("Stop", "root")),
    ]);
    expect(rs.map((r) => r.status)).toEqual([
      "thinking",
      "working",
      "requires_input",
      "working",
      "working",
      "responded",
    ]);
    expect(rs[2].reason).toBe("child session PermissionRequest hook");
    expect(rs[4].reason).toMatch(/only the root session ends a turn/);
    // The child's prompt is never persisted on the root's Agent.
    expect(rs.slice(1, 5).flatMap((r) => persisted(r.effects))).toEqual([]);
  });

  it("title '✳ Done' on a hook-driven pane does not change the status", () => {
    const claude = fg("claude", "claude");
    const rs = run([
      hook(ev("SessionStart")),
      facts({ foreground: claude }),
      hook(ev("UserPromptSubmit")),
      hook(ev("PreToolUse")),
      facts({ foreground: claude, title: "✳ Done" }),
    ]);
    expect(last(rs).status).toBe("working");
    expect(last(rs).reason).toBe("pane facts ignored: pane is hook-driven");
    expect(rs.flatMap((r) => r.effects).some((e) => e.kind === "PublishPaneStatus" && e.status === "responded")).toBe(false);
  });

  it("process exit on a hook-driven pane → idle, and late hooks do not revive it", () => {
    const rs = run([
      hook(ev("UserPromptSubmit")),
      hook(ev("PreToolUse")),
      facts({ foreground: fg("zsh") }),
      hook(ev("PostToolUse")),
    ]);
    expect(rs.map((r) => r.status)).toEqual(["thinking", "working", "idle", "idle"]);
    expect(rs[2].reason).toBe("agent process exited");
    expect(persisted(rs[2].effects)).toEqual([respond()]);
  });
});

describe("reconcile — sequence: opencode pane driven only by facts", () => {
  it("process, hints, prompt, idle prompt and exit", () => {
    const oc = fg("opencode", "opencode");
    const rs = run([
      facts({ foreground: fg("zsh") }),
      facts({ foreground: oc }),
      facts({ foreground: oc, outputHint: { hint: "thinking", at: 1 } }),
      facts({ foreground: oc, outputHint: { hint: "requires_input", at: 2 } }),
      facts({ foreground: oc, outputHint: { hint: "working", at: 3 } }),
      facts({ foreground: oc, outputHint: { hint: "idle", at: 4 } }),
      facts({ foreground: oc, title: "✳ opencode", outputHint: { hint: "idle", at: 4 } }),
      tick(1_000_000),
      facts({ foreground: oc, outputHint: { hint: "thinking", at: 5 } }),
      facts({ foreground: fg("zsh"), outputHint: { hint: "thinking", at: 5 } }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([
      "idle",
      "idle",
      "thinking",
      "requires_input",
      "working",
      "idle",
      "idle",
      "idle",
      "thinking",
      "idle",
    ]);
    expect(rs[1].state.kind).toBe("opencode");
    expect(rs[9].reason).toBe("agent process exited");
    expect(rs[9].state.kind).toBeNull();
    // Facts-only agents are never hook-driven and never persisted.
    expect(rs.every((r) => !r.state.hookDriven)).toBe(true);
    expect(rs.flatMap((r) => persisted(r.effects))).toEqual([]);
  });
});
