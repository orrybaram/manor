/**
 * Integration tests for the Status reconciler's driver (ADR-184 ticket 3).
 *
 * The first half ports the old hook relay's integration tests
 * (`relay-subagent-tracking.test.ts`, `hook-relay-on-event.test.ts`) to run
 * through the driver — the parity guard for persistence, unseen flags,
 * notifications, broadcasts and their ordering. Sweeps become ticks, and the
 * "AgentDetector gone" bridge becomes Pane facts. The rest covers what is new:
 * published status + reason, user signals, and the reconnect resync.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentInfo } from "../../agent-persistence";
import type { AgentHookEvent } from "../../agent-hook-events";
import type { AgentKind, PaneFacts } from "../../terminal-host/types";
import { createAgentStatusDriver, type AgentStatusDriverDeps } from "../driver";
import type { PaneStatusUpdate } from "../effects";
import { STALE_ACTIVE_MS, STALE_STOP_MS } from "../reconciler";

// ── Fake AgentManager ──

type CreateData = Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">;

function makeFakeAgentManager(calls: string[]) {
  const agents = new Map<string, AgentInfo>();
  let counter = 0;

  function createAgent(data: CreateData): AgentInfo {
    counter += 1;
    calls.push(`create:${data.agentSessionId}`);
    const agent: AgentInfo = {
      ...data,
      id: `agent-${counter}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activatedAt: null,
    };
    agents.set(agent.agentSessionId, agent);
    return agent;
  }

  function updateAgent(id: string, updates: Partial<AgentInfo>): AgentInfo | null {
    for (const [key, agent] of agents) {
      if (agent.id === id) {
        const updated = { ...agent, ...updates, id: agent.id } as AgentInfo;
        agents.set(key, updated);
        if (updates.status !== undefined || updates.lastAgentStatus !== undefined) {
          calls.push(`update:${id}:${updates.status ?? "-"}/${updates.lastAgentStatus ?? "-"}`);
        }
        return updated;
      }
    }
    return null;
  }

  return {
    agents,
    createAgent,
    updateAgent,
    getAgentBySessionId: (sessionId: string) => agents.get(sessionId) ?? null,
    getAgentByPaneId(paneId: string): AgentInfo | null {
      for (const agent of agents.values()) if (agent.paneId === paneId) return agent;
      return null;
    },
    getAgentById(agentId: string): AgentInfo | null {
      for (const agent of agents.values()) if (agent.id === agentId) return agent;
      return null;
    },
    getActiveAgents: () => Array.from(agents.values()).filter((a) => a.status === "active"),
    /** Seed an Agent directly (e.g. one rehydrated from disk). */
    seed(agent: Partial<AgentInfo> & { agentSessionId: string }): AgentInfo {
      counter += 1;
      const full: AgentInfo = {
        id: `agent-${counter}`,
        name: null,
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
        paneId: null,
        lastAgentStatus: null,
        resumedAt: null,
        ...agent,
      };
      agents.set(full.agentSessionId, full);
      return full;
    },
  };
}

// ── Driver builder ──

function build() {
  const clock = { mono: 1_000_000, wall: Date.parse("2026-09-26T12:00:00Z") };
  const calls: string[] = [];
  const agentManager = makeFakeAgentManager(calls);
  const unseenRespondedAgents = new Set<string>();
  const unseenInputAgents = new Set<string>();
  const published: PaneStatusUpdate[] = [];
  const broadcastAgent = vi.fn((agent: AgentInfo) => {
    calls.push(`broadcast:${agent.id}:${agent.status}/${agent.lastAgentStatus}`);
  });
  const maybeSendNotification = vi.fn(
    (agent: AgentInfo, prev: string | null | undefined, next: string) => {
      calls.push(`notify:${agent.id}:${prev ?? "null"}->${next}`);
    },
  );
  const publishPaneStatus = vi.fn((update: PaneStatusUpdate) => {
    published.push(update);
    calls.push(`publish:${update.paneId}:${update.status}`);
  });
  const onHookEvent = vi.fn();

  const deps: AgentStatusDriverDeps = {
    agentManager,
    getPaneContext: () => undefined,
    unseenRespondedAgents,
    unseenInputAgents,
    broadcastAgent,
    maybeSendNotification,
    publishPaneStatus,
    onHookEvent,
    log: () => {},
    monoClock: () => clock.mono,
    wallClock: () => clock.wall,
  };
  const driver = createAgentStatusDriver(deps);

  /** Advance both clocks (real elapsed time). */
  function advance(ms: number): void {
    clock.mono += ms;
    clock.wall += ms;
  }

  return {
    driver,
    clock,
    advance,
    calls,
    agentManager,
    unseenRespondedAgents,
    unseenInputAgents,
    published,
    broadcastAgent,
    maybeSendNotification,
    publishPaneStatus,
    onHookEvent,
  };
}

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

// ── Event builders ──

interface BaseInput {
  paneId?: string;
  sessionId: string | null;
  agentKind?: AgentKind;
}

const base = (i: BaseInput) => ({
  paneId: i.paneId ?? "pane-1",
  sessionId: i.sessionId,
  agentKind: i.agentKind ?? ("claude" as AgentKind),
});

const sessionStart = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "SessionStart", status: "thinking" });
const sessionEnd = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "SessionEnd", status: "idle" });
const userPromptSubmit = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "UserPromptSubmit", status: "thinking" });
const preToolUse = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "PreToolUse", status: "working" });
const postToolUse = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "PostToolUse", status: "thinking" });
const stop = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "Stop", status: "responded" });
const stopFailure = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "StopFailure", status: "error" });
const permissionRequest = (i: BaseInput): AgentHookEvent => ({ ...base(i), type: "PermissionRequest", status: "requires_input" });
const subagentStart = (i: BaseInput & { toolUseId: string | null }): AgentHookEvent => ({
  ...base(i),
  type: "SubagentStart",
  status: "working",
  toolUseId: i.toolUseId,
});
const subagentStop = (i: BaseInput & { toolUseId: string | null }): AgentHookEvent => ({
  ...base(i),
  type: "SubagentStop",
  status: "thinking",
  toolUseId: i.toolUseId,
});

const facts = (fg: PaneFacts["foreground"]): PaneFacts => ({ foreground: fg, title: null, outputHint: null });

// ── Ported: subagent tracking and held Stops ──

describe("driver — subagent tracking (ported from the relay)", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });

  it("holds a Stop while a subagent runs, then applies it once the subagent stops", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: "tool-a" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: "tool-a" }));
    expect(t.driver.getPaneState("pane-1")!.activeSubagents.size).toBe(1);

    t.driver.hook(stop({ sessionId: "s1" }));
    expect(t.driver.getPaneState("pane-1")!.pendingStopAt).not.toBeNull();
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).not.toBe("responded");
    // A held Stop does not show responded (ADR-184 divergence fixed).
    expect(t.driver.getPaneState("pane-1")!.status).toBe("working");

    t.driver.hook(subagentStop({ sessionId: "s1", toolUseId: "tool-a" }));
    expect(t.driver.getPaneState("pane-1")!.activeSubagents.size).toBe(0);

    t.driver.hook(stop({ sessionId: "s1" }));
    expect(t.driver.getPaneState("pane-1")!.pendingStopAt).toBeNull();
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("responded");
  });

  it("SubagentStop with an unknown toolUseId is a no-op", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: "tool-a" }));
    t.driver.hook(subagentStop({ sessionId: "s1", toolUseId: "tool-zzz" }));
    expect(t.driver.getPaneState("pane-1")!.activeSubagents.has("tool-a")).toBe(true);
  });

  it("a null toolUseId on SubagentStart stores a synthesized fallback id", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: null }));
    const subs = [...t.driver.getPaneState("pane-1")!.activeSubagents];
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatch(/^__fallback_/);
  });
});

// ── Ported: sweeps are ticks ──

describe("driver — ticks replace the sweeps (ported)", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });

  it("drains a held Stop once the root has been quiet longer than STALE_STOP_MS", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: "tool-a" }));
    t.driver.hook(stop({ sessionId: "s1" }));

    t.advance(STALE_STOP_MS + 1_000);
    t.driver.tick();

    const agent = t.agentManager.getAgentBySessionId("s1")!;
    expect(agent.lastAgentStatus).toBe("responded");
    expect(t.unseenRespondedAgents.has(agent.id)).toBe(true);
    expect(t.maybeSendNotification).toHaveBeenLastCalledWith(agent, "working", "responded");
    // Forced stops reach the dot too (was `syncDetector`).
    expect(last(t.published)).toMatchObject({ paneId: "pane-1", status: "responded" });
    expect(last(t.published)!.reason).toMatch(/held Stop applied/);
  });

  it("a later hook defers the held-Stop drain", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: "tool-a" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    t.advance(10_000);
    t.driver.hook(postToolUse({ sessionId: "s1" }));
    t.advance(10_000);
    t.driver.tick();
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).not.toBe("responded");
  });

  it("stuck-working: forces responded after STALE_ACTIVE_MS without a hook", () => {
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.advance(STALE_ACTIVE_MS + 1_000);
    t.driver.tick();

    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("responded");
    expect(last(t.published)).toMatchObject({ status: "responded" });
    expect(last(t.published)!.reason).toMatch(/stuck-working recovery/);
  });

  it("stuck-working does not fire for an agent already terminal, or with fresh activity", () => {
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    t.advance(STALE_ACTIVE_MS + 1_000);
    t.driver.hook(userPromptSubmit({ sessionId: "s2", paneId: "pane-2" }));
    const before = t.maybeSendNotification.mock.calls.length;
    t.driver.tick();
    expect(t.maybeSendNotification.mock.calls.length).toBe(before);
    expect(t.agentManager.getAgentBySessionId("s2")!.lastAgentStatus).toBe("thinking");
  });

  it("orphan: recovers a stale working Agent with no pane state", () => {
    t.advance(STALE_ACTIVE_MS + 5_000); // real run time
    const agent = t.agentManager.seed({
      agentSessionId: "s-orphan",
      paneId: "pane-9",
      lastAgentStatus: "working",
      activatedAt: new Date(t.clock.wall - (STALE_ACTIVE_MS + 5_000)).toISOString(),
    });
    t.driver.tick();

    expect(t.agentManager.getAgentById(agent.id)!.lastAgentStatus).toBe("responded");
    expect(last(t.published)).toMatchObject({ paneId: "pane-9", status: "responded" });
  });

  it("orphan: an Agent with no pane at all is recovered without publishing", () => {
    t.advance(STALE_ACTIVE_MS + 5_000);
    const agent = t.agentManager.seed({
      agentSessionId: "s-nopane",
      paneId: null,
      lastAgentStatus: "requires_input",
      activatedAt: new Date(t.clock.wall - (STALE_ACTIVE_MS + 5_000)).toISOString(),
    });
    t.driver.tick();

    expect(t.agentManager.getAgentById(agent.id)!.lastAgentStatus).toBe("responded");
    expect(t.published).toHaveLength(0);
  });

  it("orphan: a wall-clock jump with no monotonic time (suspend) does not trip it", () => {
    t.advance(5_000);
    t.clock.wall += 60 * 60_000; // suspend/resume
    const agent = t.agentManager.seed({
      agentSessionId: "s-orphan",
      paneId: "pane-9",
      lastAgentStatus: "working",
      activatedAt: new Date(t.clock.wall - 60 * 60_000).toISOString(),
    });
    t.driver.tick();
    expect(t.agentManager.getAgentById(agent.id)!.lastAgentStatus).toBe("working");
  });

  it("orphan: leaves a recent Agent, or one not mid-turn, alone", () => {
    t.advance(STALE_ACTIVE_MS + 5_000);
    const recent = t.agentManager.seed({
      agentSessionId: "s-recent",
      paneId: "pane-8",
      lastAgentStatus: "working",
      activatedAt: new Date(t.clock.wall - 5_000).toISOString(),
    });
    const done = t.agentManager.seed({
      agentSessionId: "s-done",
      paneId: "pane-7",
      lastAgentStatus: "responded",
      activatedAt: new Date(t.clock.wall - (STALE_ACTIVE_MS + 5_000)).toISOString(),
    });
    t.driver.tick();
    expect(t.agentManager.getAgentById(recent.id)!.lastAgentStatus).toBe("working");
    expect(t.agentManager.getAgentById(done.id)!.lastAgentStatus).toBe("responded");
    expect(t.driver.getPaneState("pane-8")).toBeUndefined();
  });
});

// ── Ported: late-active guard, root replacement, lifecycle ──

describe("driver — lifecycle (ported)", () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });

  it("a late PostToolUse / PreToolUse after Stop does not flip the Agent back", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    t.driver.hook(postToolUse({ sessionId: "s1" }));
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("responded");
    expect(t.driver.getPaneState("pane-1")!.status).toBe("responded");
  });

  it("UserPromptSubmit after Stop starts the next turn", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("thinking");
  });

  it("SessionStart replacement forces the old active root to responded", () => {
    t.driver.hook(preToolUse({ sessionId: "old" }));
    const oldId = t.agentManager.getAgentBySessionId("old")!.id;
    t.driver.hook(sessionStart({ sessionId: "new" }));

    const old = t.agentManager.getAgentBySessionId("old")!;
    expect(old.lastAgentStatus).toBe("responded");
    expect(t.unseenRespondedAgents.has(oldId)).toBe(true);
    expect(t.maybeSendNotification).toHaveBeenLastCalledWith(old, "working", "responded");
    expect(t.driver.getPaneState("pane-1")!.rootSessionId).toBe("new");
  });

  it("SessionStart replacement leaves an old root that already responded alone", () => {
    t.driver.hook(preToolUse({ sessionId: "old" }));
    t.driver.hook(stop({ sessionId: "old" }));
    const notifies = t.maybeSendNotification.mock.calls.length;
    t.driver.hook(sessionStart({ sessionId: "new" }));
    expect(t.maybeSendNotification.mock.calls.length).toBe(notifies);
  });

  it("SessionStart alone does not change the pane's status (only its kind)", () => {
    t.driver.hook(sessionStart({ sessionId: "s1" }));
    expect(t.published).toEqual([
      expect.objectContaining({ paneId: "pane-1", status: "idle", kind: "claude" }),
    ]);
    expect(t.agentManager.agents.size).toBe(0);
  });

  it("held Stop + SessionEnd: notifies responded, then completes with last status idle", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(subagentStart({ sessionId: "s1", toolUseId: "tool-a" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    t.driver.hook(sessionEnd({ sessionId: "s1" }));

    const agent = t.agentManager.getAgentBySessionId("s1")!;
    expect(t.maybeSendNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: agent.id }),
      "working",
      "responded",
    );
    expect(agent.status).toBe("completed");
    // ADR-184: "idle", not the old relay's "complete".
    expect(agent.lastAgentStatus).toBe("idle");
    expect(agent.completedAt).not.toBeNull();
    expect(t.unseenRespondedAgents.has(agent.id)).toBe(false);
    expect(last(t.published)).toMatchObject({ status: "idle", kind: null });
  });

  it("StopFailure marks the Agent errored and clears its unseen flags", () => {
    t.driver.hook(permissionRequest({ sessionId: "s1" }));
    const id = t.agentManager.getAgentBySessionId("s1")!.id;
    expect(t.unseenInputAgents.has(id)).toBe(true);
    t.driver.hook(stopFailure({ sessionId: "s1" }));
    const agent = t.agentManager.getAgentBySessionId("s1")!;
    expect(agent.status).toBe("error");
    expect(agent.lastAgentStatus).toBe("error");
    expect(t.unseenInputAgents.has(id)).toBe(false);
  });

  it("ADR-162: a session that opens needing input notifies", () => {
    t.driver.hook(permissionRequest({ sessionId: "s1" }));
    const agent = t.agentManager.getAgentBySessionId("s1")!;
    expect(t.maybeSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: agent.id }),
      null,
      "requires_input",
    );
    expect(t.unseenInputAgents.has(agent.id)).toBe(true);
  });

  it("ADR-142: a session handoff retires the previous pane Agent before creating the new one", () => {
    t.driver.hook(userPromptSubmit({ sessionId: "old" }));
    const oldId = t.agentManager.getAgentBySessionId("old")!.id;
    t.unseenRespondedAgents.add(oldId);
    t.driver.hook(sessionStart({ sessionId: "new" }));
    t.calls.length = 0;
    t.driver.hook(userPromptSubmit({ sessionId: "new" }));

    const old = t.agentManager.getAgentBySessionId("old")!;
    expect(old.status).toBe("completed");
    expect(old.paneId).toBeNull();
    expect(t.unseenRespondedAgents.has(oldId)).toBe(false);
    const active = t.agentManager.getActiveAgents().filter((a) => a.paneId === "pane-1");
    expect(active).toHaveLength(1);
    expect(t.calls).toEqual([
      "publish:pane-1:thinking",
      `update:${oldId}:completed/-`,
      `broadcast:${oldId}:completed/responded`,
      "create:new",
      `notify:${active[0].id}:null->thinking`,
      `broadcast:${active[0].id}:active/thinking`,
    ]);
  });
});

// ── Effect ordering (ADR-139 parity) ──

describe("driver — effect ordering", () => {
  it("Stop: publish, persist, notify, broadcast — with unseen set before notify", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    const id = t.agentManager.getAgentBySessionId("s1")!.id;
    let unseenAtNotify: boolean | null = null;
    t.maybeSendNotification.mockImplementation((agent, prev, next) => {
      unseenAtNotify = t.unseenRespondedAgents.has(agent.id);
      t.calls.push(`notify:${agent.id}:${prev ?? "null"}->${next}`);
    });
    t.calls.length = 0;
    t.driver.hook(stop({ sessionId: "s1" }));

    expect(t.calls).toEqual([
      "publish:pane-1:responded",
      `update:${id}:active/responded`,
      `notify:${id}:working->responded`,
      `broadcast:${id}:active/responded`,
    ]);
    expect(unseenAtNotify).toBe(true);
  });

  it("active update: persist, notify, broadcast; requires_input adds to unseen first", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    const id = t.agentManager.getAgentBySessionId("s1")!.id;
    t.calls.length = 0;
    t.driver.hook(permissionRequest({ sessionId: "s1" }));
    expect(t.calls).toEqual([
      "publish:pane-1:requires_input",
      `update:${id}:active/requires_input`,
      `notify:${id}:working->requires_input`,
      `broadcast:${id}:active/requires_input`,
    ]);
    expect(t.unseenInputAgents.has(id)).toBe(true);
  });

  it("a child session's requires_input shows on the pane but never notifies or marks unseen", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "root" }));
    t.calls.length = 0;
    t.driver.hook(permissionRequest({ sessionId: "child" }));
    expect(t.calls).toEqual(["publish:pane-1:requires_input"]);
    expect(t.unseenInputAgents.size).toBe(0);
    expect(t.agentManager.getAgentBySessionId("child")).toBeNull();
  });
});

// ── Pane facts: the old "AgentDetector gone" bridge ──

describe("driver — liveness from Pane facts (was the gone bridge)", () => {
  it("an agent process that exits mid-turn: Stop applied, pane idle", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.driver.signal("pane-1", { type: "paneFacts", facts: facts({ name: "claude", kind: "claude" }) });
    t.driver.signal("pane-1", { type: "paneFacts", facts: facts({ name: "zsh", kind: null }) });

    const agent = t.agentManager.getAgentBySessionId("s1")!;
    expect(agent.lastAgentStatus).toBe("responded");
    expect(last(t.published)).toEqual({
      paneId: "pane-1",
      status: "idle",
      reason: "agent process exited",
      kind: null,
    });
  });

  it("is a no-op for an Agent that already responded", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    const notifies = t.maybeSendNotification.mock.calls.length;
    t.driver.signal("pane-1", { type: "paneFacts", facts: facts(null) });
    expect(t.maybeSendNotification.mock.calls.length).toBe(notifies);
    expect(last(t.published)).toMatchObject({ status: "idle" });
  });
});

// ── Hook observer (ported from hook-relay-on-event) ──

describe("driver — onHookEvent observer (ported)", () => {
  it("is called once per hook, after its effects, with the CreateAgent effect", () => {
    const t = build();
    t.onHookEvent.mockImplementation(() => {
      // Effects already applied when the observer runs.
      expect(t.agentManager.getAgentBySessionId("s1")).not.toBeNull();
    });
    const event = userPromptSubmit({ sessionId: "s1" });
    t.driver.hook(event);
    expect(t.onHookEvent).toHaveBeenCalledTimes(1);
    const [seen, effects, obs] = t.onHookEvent.mock.calls[0];
    expect(seen).toBe(event);
    expect(effects.map((e: { kind: string }) => e.kind)).toContain("CreateAgent");
    expect(obs).toEqual({ isRootSession: true, replacedRootSessionId: null });
  });

  it("flags a second session in the pane as non-root, and a replacement as root", () => {
    const t = build();
    t.driver.hook(userPromptSubmit({ sessionId: "root" }));
    t.driver.hook(preToolUse({ sessionId: "child" }));
    expect(t.onHookEvent.mock.calls[1][2].isRootSession).toBe(false);

    t.driver.hook(sessionStart({ sessionId: "next" }));
    expect(t.onHookEvent.mock.calls[2][2]).toEqual({
      isRootSession: true,
      replacedRootSessionId: "root",
    });
  });

  it("swallows an observer throw and keeps going", () => {
    const t = build();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    t.onHookEvent.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    t.driver.hook(userPromptSubmit({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("responded");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ── User signals ──

describe("driver — user signals", () => {
  it("abandon: an active Agent becomes abandoned; the pane goes idle and forgets its root", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    const id = t.agentManager.getAgentBySessionId("s1")!.id;
    t.calls.length = 0;

    const result = t.driver.signal("pane-1", { type: "user", action: "abandon" });

    const agent = t.agentManager.getAgentBySessionId("s1")!;
    expect(agent.status).toBe("abandoned");
    expect(agent.completedAt).not.toBeNull();
    expect(t.calls).toEqual([
      "publish:pane-1:idle",
      `update:${id}:abandoned/-`,
      `broadcast:${id}:abandoned/working`,
    ]);
    expect(result.reason).toBe("pane closed by the user");
    expect(t.driver.getPaneState("pane-1")!.rootSessionId).toBeNull();
  });

  it("end: same, for a session ended from outside", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.driver.signal("pane-1", { type: "user", action: "end" });
    expect(t.agentManager.getAgentBySessionId("s1")!.status).toBe("abandoned");
    expect(last(t.published)!.reason).toBe("session ended by the user");
  });

  it("abandon on a pane with no signals yet uses the pane's Agent", () => {
    const t = build();
    t.agentManager.seed({ agentSessionId: "s1", paneId: "pane-3", lastAgentStatus: "responded" });
    t.driver.signal("pane-3", { type: "user", action: "abandon" });
    expect(t.agentManager.getAgentBySessionId("s1")!.status).toBe("abandoned");
  });

  it("an Agent that completed keeps its outcome", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    t.driver.hook(sessionEnd({ sessionId: "s1" }));
    t.driver.signal("pane-1", { type: "user", action: "abandon" });
    expect(t.agentManager.getAgentBySessionId("s1")!.status).toBe("completed");
  });

  it("markSeen clears the Agent's unseen flags and rebroadcasts it", () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1" }));
    t.driver.hook(stop({ sessionId: "s1" }));
    const id = t.agentManager.getAgentBySessionId("s1")!.id;
    expect(t.unseenRespondedAgents.has(id)).toBe(true);
    t.broadcastAgent.mockClear();
    t.driver.signal("pane-1", { type: "user", action: "markSeen" });
    expect(t.unseenRespondedAgents.has(id)).toBe(false);
    expect(t.broadcastAgent).toHaveBeenCalledTimes(1);
  });
});

// ── Reconnect resync ──

describe("driver — resync after a host (re)connects", () => {
  it("feeds each live session's facts; skips unknown sessions and failed fetches", async () => {
    const t = build();
    t.driver.hook(preToolUse({ sessionId: "s1", paneId: "pane-a" }));
    const getPaneFacts = vi.fn(async (id: string): Promise<PaneFacts | null> => {
      if (id === "pane-a") return facts(null); // agent gone while disconnected
      if (id === "pane-b") return facts({ name: "opencode", kind: "opencode" });
      if (id === "pane-err") throw new Error("host gone again");
      return null;
    });

    await t.driver.resync(["pane-a", "pane-b", "pane-missing", "pane-err"], getPaneFacts);

    expect(getPaneFacts).toHaveBeenCalledTimes(4);
    expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("responded");
    expect(t.driver.getPaneState("pane-a")!.status).toBe("idle");
    // A non-hook agent's pane picks up its kind from the facts.
    expect(t.driver.getPaneState("pane-b")!.kind).toBe("opencode");
    expect(t.driver.getPaneState("pane-missing")).toBeUndefined();
    expect(t.driver.getPaneState("pane-err")).toBeUndefined();
  });

  it("identical facts resynced twice change nothing the second time", async () => {
    const t = build();
    const f = facts({ name: "opencode", kind: "opencode" });
    await t.driver.resync(["pane-b"], async () => f);
    const published = t.published.length;
    await t.driver.resync(["pane-b"], async () => f);
    expect(t.published.length).toBe(published);
  });
});

// ── Tick interval ──

describe("driver — tick interval", () => {
  it("start() runs the tick on the sweep cadence; stop() ends it", () => {
    vi.useFakeTimers();
    try {
      const t = build();
      t.driver.start();
      t.driver.start(); // idempotent
      t.driver.hook(preToolUse({ sessionId: "s1" }));
      t.advance(STALE_ACTIVE_MS + 1_000);
      vi.advanceTimersByTime(10_000);
      expect(t.agentManager.getAgentBySessionId("s1")!.lastAgentStatus).toBe("responded");
      t.driver.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
