/**
 * The relay's `onHookEvent` observer seam (ADR-168 §2).
 *
 * The stats tap hangs off this callback, so the contract that matters is:
 * it sees every relayed event with exactly the effects the applier ran, it
 * runs *after* those effects, and a broken observer never reaches the relay.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createHookRelay, type HookRelayDeps } from "../hook-relay";
import type { AgentInfo } from "../agent-persistence";
import type { AgentKind } from "../terminal-host/types";
import type { AgentHookEvent } from "../agent-hook-events";
import type { Effect } from "../hook-relay-transition";

// Wrap the real applier so we can compare what it received against what the
// observer was handed, without changing any relay behaviour.
const appliedEffects: Effect[][] = [];
vi.mock("../hook-relay-effects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hook-relay-effects")>();
  return {
    ...actual,
    applyEffects: (effects: Effect[], deps: Parameters<typeof actual.applyEffects>[1]) => {
      appliedEffects.push(effects);
      return actual.applyEffects(effects, deps);
    },
  };
});

type CreateData = Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">;

function makeFakeAgentManager() {
  const agents = new Map<string, AgentInfo>();
  let counter = 0;

  return {
    agents,
    createAgent(data: CreateData): AgentInfo {
      counter += 1;
      const agent = {
        ...data,
        id: `agent-${counter}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        activatedAt: null,
      } as AgentInfo;
      agents.set(agent.agentSessionId, agent);
      return agent;
    },
    updateAgent(id: string, updates: Partial<AgentInfo>): AgentInfo | null {
      for (const [key, agent] of agents) {
        if (agent.id === id) {
          const updated = { ...agent, ...updates, id: agent.id } as AgentInfo;
          agents.set(key, updated);
          return updated;
        }
      }
      return null;
    },
    getAgentBySessionId: (sessionId: string): AgentInfo | null => agents.get(sessionId) ?? null,
    getAgentByPaneId: (paneId: string): AgentInfo | null => {
      for (const agent of agents.values()) if (agent.paneId === paneId) return agent;
      return null;
    },
    getActiveAgents: (): AgentInfo[] =>
      Array.from(agents.values()).filter((a) => a.status === "active"),
  };
}

function buildRelay(onHookEvent?: HookRelayDeps["onHookEvent"]) {
  const agentManager = makeFakeAgentManager();
  const broadcastAgent = vi.fn();
  const relayAgentHook = vi.fn();

  const deps: HookRelayDeps = {
    relayAgentHook,
    agentManager,
    getPaneContext: () => ({
      projectId: "p1",
      projectName: "proj",
      workspacePath: "/tmp/proj",
      agentCommand: "claude",
    }),
    unseenRespondedAgents: new Set<string>(),
    unseenInputAgents: new Set<string>(),
    broadcastAgent,
    maybeSendNotification: vi.fn(),
    onHookEvent,
    monoClock: () => Date.now(),
    wallClock: () => Date.now(),
  };

  return { ...createHookRelay(deps), agentManager, broadcastAgent, relayAgentHook };
}

const base = (sessionId: string | null) => ({
  paneId: "pane-1",
  sessionId,
  agentKind: "claude" as AgentKind,
});

const sessionStart = (sessionId: string): AgentHookEvent => ({
  ...base(sessionId),
  type: "SessionStart",
  status: "thinking",
});
const preToolUse = (sessionId: string): AgentHookEvent => ({
  ...base(sessionId),
  type: "PreToolUse",
  status: "working",
});
const userPromptSubmit = (sessionId: string): AgentHookEvent => ({
  ...base(sessionId),
  type: "UserPromptSubmit",
  status: "thinking",
});
const stop = (sessionId: string): AgentHookEvent => ({
  ...base(sessionId),
  type: "Stop",
  status: "responded",
});

describe("createHookRelay onHookEvent", () => {
  beforeEach(() => {
    appliedEffects.length = 0;
  });

  it("is called once per event with the event and the applied effects", () => {
    const onHookEvent = vi.fn();
    const { relay } = buildRelay(onHookEvent);

    relay(sessionStart("sess-1"));
    relay(preToolUse("sess-1"));

    expect(onHookEvent).toHaveBeenCalledTimes(2);
    expect(onHookEvent.mock.calls[0][0]).toEqual(sessionStart("sess-1"));
    expect(onHookEvent.mock.calls[0][1]).toBe(appliedEffects[0]);
    expect(onHookEvent.mock.calls[1][0]).toEqual(preToolUse("sess-1"));
    expect(onHookEvent.mock.calls[1][1]).toBe(appliedEffects[1]);
  });

  it("sees the CreateAgent effect the first active event produces", () => {
    const onHookEvent = vi.fn();
    const { relay } = buildRelay(onHookEvent);

    relay(sessionStart("sess-1"));
    relay(userPromptSubmit("sess-1"));

    const effects = onHookEvent.mock.calls[1][1] as Effect[];
    expect(effects.map((e) => e.kind)).toContain("CreateAgent");
  });

  it("runs after the effects have been applied", () => {
    const order: string[] = [];
    const { relay, broadcastAgent } = buildRelay(() => order.push("observer"));
    broadcastAgent.mockImplementation(() => order.push("broadcast"));

    relay(userPromptSubmit("sess-1"));

    expect(order.indexOf("broadcast")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("observer")).toBe(order.length - 1);
  });

  it("swallows an observer throw and keeps relaying later events", () => {
    const seen: string[] = [];
    const onHookEvent = vi.fn((event: AgentHookEvent) => {
      seen.push(event.type);
      throw new Error("stats blew up");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { relay, agentManager, relayAgentHook } = buildRelay(onHookEvent);

    expect(() => relay(sessionStart("sess-1"))).not.toThrow();
    expect(() => relay(userPromptSubmit("sess-1"))).not.toThrow();
    expect(() => relay(preToolUse("sess-1"))).not.toThrow();
    expect(() => relay(stop("sess-1"))).not.toThrow();

    expect(seen).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]);
    // The relay's own work still happened for every event.
    expect(relayAgentHook).toHaveBeenCalledTimes(3);
    expect(agentManager.getAgentBySessionId("sess-1")?.lastAgentStatus).toBe("responded");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("flags events from the pane's root session as root", () => {
    const onHookEvent = vi.fn();
    const { relay } = buildRelay(onHookEvent);

    relay(sessionStart("sess-1"));
    relay(userPromptSubmit("sess-1"));

    expect(onHookEvent.mock.calls[1][2]).toEqual({ isRootSession: true });
  });

  it("flags events from a second session in the same pane as non-root", () => {
    const onHookEvent = vi.fn();
    const { relay } = buildRelay(onHookEvent);

    relay(sessionStart("sess-1"));
    relay(userPromptSubmit("sess-1"));
    // A nested agent process inherits MANOR_PANE_ID and fires its own hooks.
    relay(userPromptSubmit("nested-1"));

    expect(onHookEvent.mock.calls[2][0]).toEqual(userPromptSubmit("nested-1"));
    expect(onHookEvent.mock.calls[2][2]).toEqual({ isRootSession: false });
  });

  it("treats the replacement session as root right from its SessionStart", () => {
    const onHookEvent = vi.fn();
    const { relay } = buildRelay(onHookEvent);

    relay(sessionStart("sess-1"));
    relay(userPromptSubmit("sess-1"));
    relay(sessionStart("sess-2"));
    relay(userPromptSubmit("sess-2"));

    expect(onHookEvent.mock.calls[2][2]).toEqual({ isRootSession: true });
    expect(onHookEvent.mock.calls[3][2]).toEqual({ isRootSession: true });
  });

  it("is optional — a relay built without it works unchanged", () => {
    const { relay, agentManager } = buildRelay();

    expect(() => relay(sessionStart("sess-1"))).not.toThrow();
    expect(() => relay(userPromptSubmit("sess-1"))).not.toThrow();
    expect(agentManager.getAgentBySessionId("sess-1")).not.toBeNull();
  });
});
