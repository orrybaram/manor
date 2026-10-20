/**
 * `/agents/:agentId/*` management routes — rename, delete, mark-seen, and
 * resume-command. `POST /agents`, the launch route, has its own file
 * (`agents-launch.test.ts`) now that it opens the tab itself. Rename, delete
 * and mark-seen call `agents.update`/`agents.delete`/`agents.markSeen` in
 * `../bridge/handlers/agents.ts`; modeled on `agents-read.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { UnseenAgents } from "../agent-status/unseen-agents";
import { agentRoutes } from "./agents";
import type { HostDeps, Route } from "./types";

function findRoute(method: Route["method"], path: string): Route {
  const route = agentRoutes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`No route ${method} ${path}`);
  return route;
}

const renameRoute = findRoute("POST", "/agents/:agentId/rename");
const deleteRoute = findRoute("DELETE", "/agents/:agentId");
const seenRoute = findRoute("POST", "/agents/:agentId/seen");
const resumeRoute = findRoute("GET", "/agents/:agentId/resume-command");

/** An AgentManager stub over a single mutable agent record, keyed by id/paneId. */
function agentManager(initial: Record<string, unknown> | null) {
  let agent = initial;
  return {
    getAgentById: (id: string) => (agent && agent.id === id ? agent : null),
    getAgentByPaneId: (pane: string) =>
      agent && agent.paneId === pane ? agent : null,
    getActiveAgents: () => (agent ? [agent] : []),
    updateAgent: vi.fn((id: string, updates: Record<string, unknown>) => {
      if (!agent || agent.id !== id) return null;
      agent = { ...agent, ...updates };
      return agent;
    }),
    deleteAgent: vi.fn((id: string) => {
      if (!agent || agent.id !== id) return false;
      agent = null;
      return true;
    }),
  };
}

const unseen = new UnseenAgents();
const unseenRespondedAgents = unseen.responded;
const unseenInputAgents = unseen.requiresInput;
const preferencesManager = { get: vi.fn(() => false) };
const markAgentNotificationsRead = vi.fn();
const sendAgentUpdate = vi.fn();
const updateDockBadge = vi.fn();
const notifier = {
  markAgentNotificationsRead,
  sendAgentUpdate,
  updateDockBadge,
  sendNotificationsUpdate: vi.fn(),
};

async function call(
  route: Route,
  {
    agentId = "agent-1",
    deps,
    body = {},
  }: {
    agentId?: string;
    deps: Partial<HostDeps>;
    body?: Record<string, unknown>;
  },
) {
  const calls: Array<{ status: number; body: any }> = [];
  await route.handler({
    method: route.method,
    deps: {
      unseen,
      notifier,
      preferencesManager,
      ...deps,
    } as unknown as HostDeps,
    params: { agentId },
    url: new URL("http://localhost" + route.path.replace(":agentId", agentId)),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  return calls[0];
}

beforeEach(() => {
  unseenRespondedAgents.clear();
  unseenInputAgents.clear();
  markAgentNotificationsRead.mockClear();
  sendAgentUpdate.mockClear();
  updateDockBadge.mockClear();
});

describe("POST /agents/:agentId/rename", () => {
  it("404s when the agent id does not resolve", async () => {
    const deps = { agentManager: agentManager(null) as any };
    const res = await call(renameRoute, {
      deps,
      body: { name: "new name" },
    });
    expect(res.status).toBe(404);
  });

  it("400s when 'name' is missing", async () => {
    const deps = {
      agentManager: agentManager({ id: "agent-1", name: null }) as any,
    };
    const res = await call(renameRoute, { deps });
    expect(res.status).toBe(400);
  });

  it("pins a trimmed non-empty name", async () => {
    const deps = {
      agentManager: agentManager({ id: "agent-1", name: null }) as any,
    };
    const res = await call(renameRoute, {
      deps,
      body: { name: "  My Agent  " },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("My Agent");
    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", {
      name: "My Agent",
      namePinned: true,
    });
    expect(sendAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", name: "My Agent" }),
    );
  });

  it("clears and un-pins on an empty name", async () => {
    const deps = {
      agentManager: agentManager({
        id: "agent-1",
        name: "Old Name",
        namePinned: true,
      }) as any,
    };
    const res = await call(renameRoute, { deps, body: { name: "   " } });

    expect(res.status).toBe(200);
    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", {
      name: null,
      namePinned: false,
    });
  });

  it("resolves the agent by paneId as well as id", async () => {
    const deps = {
      agentManager: agentManager({
        id: "agent-1",
        paneId: "pane-9",
        name: null,
      }) as any,
    };
    const res = await call(renameRoute, {
      deps,
      agentId: "pane-9",
      body: { name: "Via Pane" },
    });

    expect(res.status).toBe(200);
    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", {
      name: "Via Pane",
      namePinned: true,
    });
  });
});

describe("DELETE /agents/:agentId", () => {
  it("404s when the agent id does not resolve", async () => {
    const deps = { agentManager: agentManager(null) as any };
    const res = await call(deleteRoute, { deps });
    expect(res.status).toBe(404);
  });

  it("deletes the agent, clears both unseen sets and refreshes the dock badge", async () => {
    unseenRespondedAgents.add("agent-1");
    unseenInputAgents.add("agent-1");
    const deps = { agentManager: agentManager({ id: "agent-1" }) as any };

    const res = await call(deleteRoute, { deps });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.agentManager.deleteAgent).toHaveBeenCalledWith("agent-1");
    expect(unseenRespondedAgents.has("agent-1")).toBe(false);
    expect(unseenInputAgents.has("agent-1")).toBe(false);
    expect(updateDockBadge).toHaveBeenCalled();
  });
});

describe("POST /agents/:agentId/seen", () => {
  it("404s when the agent id does not resolve", async () => {
    const deps = { agentManager: agentManager(null) as any };
    const res = await call(seenRoute, { deps });
    expect(res.status).toBe(404);
  });

  it("clears the unseen sets and marks notifications read", async () => {
    unseenRespondedAgents.add("agent-1");
    unseenInputAgents.add("agent-1");
    const deps = { agentManager: agentManager({ id: "agent-1" }) as any };

    const res = await call(seenRoute, { deps });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(unseenRespondedAgents.has("agent-1")).toBe(false);
    expect(unseenInputAgents.has("agent-1")).toBe(false);
    expect(markAgentNotificationsRead).toHaveBeenCalledWith("agent-1");
    expect(sendAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
    );
  });
});

describe("GET /agents/:agentId/resume-command", () => {
  it("404s when the agent id does not resolve", async () => {
    const deps = { agentManager: agentManager(null) as any };
    const res = await call(resumeRoute, { deps });
    expect(res.status).toBe(404);
  });

  it("409s when the agent has no agentCommand", async () => {
    const deps = {
      agentManager: agentManager({
        id: "agent-1",
        agentCommand: null,
        agentKind: "claude",
        agentSessionId: "sess-1",
      }) as any,
    };
    const res = await call(resumeRoute, { deps });
    expect(res.status).toBe(409);
  });

  it("returns the connector's resume command", async () => {
    const deps = {
      agentManager: agentManager({
        id: "agent-1",
        agentCommand: "claude --dangerously-skip-permissions",
        agentKind: "claude",
        agentSessionId: "sess-1",
      }) as any,
    };
    const res = await call(resumeRoute, { deps });

    expect(res.status).toBe(200);
    expect(res.body.command).toBe(
      "claude --dangerously-skip-permissions --resume sess-1",
    );
  });
});

describe("POST /sessions/end", () => {
  const endRoute = findRoute("POST", "/sessions/end");

  it("kills the pty, then sends the reconciler an `end` user signal instead of writing status", async () => {
    const manager = agentManager({ id: "agent-1", paneId: "pane-1", status: "active" });
    const order: string[] = [];
    const kill = vi.fn(async () => {
      order.push("kill");
    });
    const signal = vi.fn(() => {
      order.push("signal");
      return { effects: [] };
    });
    const res = await call(endRoute, {
      deps: {
        agentManager: manager as any,
        backend: { pty: { kill } } as any,
        agentStatus: { signal } as any,
      },
      body: { target: "agent-1" },
    });

    expect(res).toEqual({ status: 200, body: { ok: true, target: { id: "agent-1", paneId: "pane-1" } } });
    expect(signal).toHaveBeenCalledWith("pane-1", { type: "user", action: "end" });
    expect(order).toEqual(["kill", "signal"]);
    expect(manager.updateAgent).not.toHaveBeenCalled();
  });
});
