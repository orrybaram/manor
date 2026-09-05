/**
 * `/sessions/read` targeting (ADR-154, widened): an agent handle is the preferred
 * target, but plain terminal panes — which never get a `AgentInfo` — must be
 * readable by their raw paneId too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../terminal-host/scrollback", () => ({
  ScrollbackWriter: {
    readScrollback: vi.fn(() => ""),
    readMeta: vi.fn(() => null),
  },
}));

import { ScrollbackWriter } from "../terminal-host/scrollback";
import { agentRoutes } from "./agents";
import type { ControlDeps, Route } from "./types";

const readRoute = agentRoutes.find(
  (r: Route) => r.path === "/sessions/read" && r.method === "POST",
)!;

const readScrollback = vi.mocked(ScrollbackWriter.readScrollback);
const readMeta = vi.mocked(ScrollbackWriter.readMeta);

/** An AgentManager stub that knows about exactly one agent session. */
function agentManager(agent: Record<string, unknown> | null) {
  return {
    getAgentById: (id: string) => (agent && agent.id === id ? agent : null),
    getAgentByPaneId: (pane: string) =>
      agent && agent.paneId === pane ? agent : null,
    getActiveAgents: () => (agent ? [agent] : []),
  };
}

async function read(
  body: Record<string, unknown>,
  {
    agent = null,
    snapshots = {} as Record<string, string>,
  }: {
    agent?: Record<string, unknown> | null;
    snapshots?: Record<string, string>;
  } = {},
) {
  const calls: Array<{ status: number; body: any }> = [];
  const deps = {
    agentManager: agentManager(agent),
    backend: {
      pty: {
        getSnapshot: async (id: string) =>
          id in snapshots ? { screenAnsi: snapshots[id] } : null,
      },
    },
  } as unknown as ControlDeps;

  await readRoute.handler({
    deps,
    params: {},
    url: new URL("http://localhost/sessions/read"),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  return calls[0];
}

beforeEach(() => {
  readScrollback.mockReturnValue("");
  readMeta.mockReturnValue(null);
});

describe("POST /sessions/read", () => {
  it("reads a live pane that has no agent row at all", async () => {
    const res = await read(
      { target: "pane-7" },
      { snapshots: { "pane-7": "$ ls\nREADME.md\n" } },
    );

    expect(res.status).toBe(200);
    expect(res.body.text).toContain("README.md");
    expect(res.body.source).toBe("live");
    expect(res.body.target).toMatchObject({
      id: "pane-7",
      paneId: "pane-7",
      kind: "pane",
      lastAgentStatus: null,
    });
  });

  it("falls back to persisted scrollback for a dead plain pane", async () => {
    readScrollback.mockReturnValue("$ make build\ndone\n");

    const res = await read({ target: "pane-9" });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("scrollback");
    expect(res.body.text).toContain("make build");
    expect(res.body.target.kind).toBe("pane");
  });

  it("404s on a target that is neither an agent nor a known pane", async () => {
    const res = await read({ target: "nonsense" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonsense");
  });

  it("returns an empty transcript for a pane whose scrollback file exists but is empty", async () => {
    // A pane that exists on disk with nothing written yet is a real target:
    // an empty transcript is the honest answer, not "no such pane".
    readMeta.mockReturnValue({ sessionId: "pane-3" } as any);

    const res = await read({ target: "pane-3" });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe("");
  });

  it("prefers the agent's pane when the target resolves to a session", async () => {
    const res = await read(
      { target: "agent-1" },
      {
        agent: { id: "agent-1", paneId: "pane-1", lastAgentStatus: "working" },
        snapshots: { "pane-1": "thinking...\n" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({
      id: "agent-1",
      paneId: "pane-1",
      kind: "session",
      lastAgentStatus: "working",
    });
  });

  it("409s on a resolved session with no pane instead of reading the raw target", async () => {
    const res = await read(
      { target: "agent-2" },
      { agent: { id: "agent-2", paneId: null, lastAgentStatus: null } },
    );

    expect(res.status).toBe(409);
  });
});
