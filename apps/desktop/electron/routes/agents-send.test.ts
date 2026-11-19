/**
 * `POST /sessions/send`: a prompt is typed as the chat view types one (a
 * bracketed paste, then Enter as its own write), and the agent's turn is
 * stopped first only when it is in one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { agentRoutes } from "./agents";
import { claudeAdapter } from "../chat-mirror/adapters/claude";
import type { HostDeps, Route } from "./types";

const sendRoute = agentRoutes.find(
  (r: Route) => r.path === "/sessions/send" && r.method === "POST",
)!;

function agent(lastAgentStatus: string | null, agentKind = "claude") {
  return { id: "a1", paneId: "pane-1", status: "active", agentKind, lastAgentStatus };
}

async function send(body: Record<string, unknown>, target = agent("responded")) {
  const writes: string[] = [];
  const deps = {
    agentManager: {
      getAgentById: (id: string) => (id === target.id ? target : null),
      getAgentByPaneId: (pane: string) => (pane === target.paneId ? target : null),
      getActiveAgents: () => [target],
    },
    backend: { pty: { write: (_pane: string, data: string) => writes.push(data) } },
    chatMirror: {
      input: () => ({
        promptWrites: (text: string) => claudeAdapter.promptWrites(text),
        interruptKeys: ["\x1b"],
      }),
    },
  } as unknown as HostDeps;
  const calls: Array<{ status: number; body: any }> = [];
  const done = sendRoute.handler({
    method: sendRoute.method,
    deps,
    params: {},
    url: new URL("http://localhost/sessions/send"),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => ({ target: "a1", ...body }),
  });
  await vi.runAllTimersAsync();
  await done;
  return { res: calls[0], writes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("POST /sessions/send", () => {
  it("types into an idle agent without a stop key: a paste, then Enter on its own", async () => {
    const { res, writes } = await send({ text: "Push the fix" });

    expect(res.status).toBe(200);
    expect(res.body.interrupted).toBe(false);
    expect(writes).toEqual(["\x1b[200~Push the fix\x1b[201~", "\r"]);
  });

  it("stops a working agent's turn first, then types the prompt", async () => {
    const { res, writes } = await send({ text: "Stop and rebase" }, agent("working"));

    expect(res.body.interrupted).toBe(true);
    expect(res.body.target.lastAgentStatus).toBe("working");
    expect(writes).toEqual(["\x1b", "\x1b[200~Stop and rebase\x1b[201~", "\r"]);
  });

  it("leaves a working agent's turn alone with queue", async () => {
    const { res, writes } = await send({ text: "Then rebase", queue: true }, agent("working"));

    expect(res.body.interrupted).toBe(false);
    expect(writes).toEqual(["\x1b[200~Then rebase\x1b[201~", "\r"]);
  });

  it("does not interrupt an agent whose status is unknown", async () => {
    const { res, writes } = await send({ text: "hi" }, agent(null, "custom"));

    expect(res.body.interrupted).toBe(false);
    expect(writes).not.toContain("\x03");
  });

  it("uses interruptKeys, or the old interrupt field, for a custom harness", async () => {
    const custom = await send({ text: "go", interruptKeys: "\x07" }, agent("thinking", "custom"));
    expect(custom.writes[0]).toBe("\x07");

    const legacy = await send({ text: "go", interrupt: "\x07" }, agent("thinking", "custom"));
    expect(legacy.writes[0]).toBe("\x07");
  });

  it("waits between the stop key and the prompt", async () => {
    const target = agent("working");
    const writes: string[] = [];
    const deps = {
      agentManager: {
        getAgentById: () => target,
        getAgentByPaneId: () => null,
        getActiveAgents: () => [target],
      },
      backend: { pty: { write: (_p: string, d: string) => writes.push(d) } },
      chatMirror: { input: () => ({ promptWrites: claudeAdapter.promptWrites, interruptKeys: ["\x1b"] }) },
    } as unknown as HostDeps;
    const done = sendRoute.handler({
      method: sendRoute.method,
      deps,
      params: {},
      url: new URL("http://localhost/sessions/send"),
      json: () => {},
      readBody: async () => ({ target: "a1", text: "go" }),
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toEqual(["\x1b"]);
    await vi.runAllTimersAsync();
    await done;
    expect(writes).toHaveLength(3);
  });

  it("400s without text", async () => {
    const { res, writes } = await send({});
    expect(res.status).toBe(400);
    expect(writes).toEqual([]);
  });
});
