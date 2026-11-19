import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsModule } from "./tools-agents";
import { sessionsModule } from "./tools-sessions";
import type { Http } from "./types";

function row(id: string, paneId: string | null, workspacePath: string | null) {
  return {
    id,
    name: null,
    status: "active",
    lastAgentStatus: "responded",
    projectId: "p1",
    projectName: "App",
    workspacePath,
    agentKind: "claude",
    paneId,
  };
}

const ROWS = [
  row("a1", "pane-1", "/wt/feat-x"),
  row("a2", null, "/wt/feat-x"),
  row("a3", "pane-3", "/wt/other"),
];

function http(get: Http["get"], post: Http["post"] = async () => ({})): Http {
  return { get, post, del: async () => ({}) };
}

const listText = async (args: Record<string, unknown>) =>
  (await sessionsModule.handlers.list_agents(args, http(async () => ROWS))).content[0].text;

describe("list_agents", () => {
  it("hides agents with no pane, says so, and shows each row's workspace", async () => {
    const out = await listText({});
    expect(out).toContain("a1");
    expect(out).toContain("ws:feat-x");
    expect(out).not.toContain("a2");
    expect(out).toContain("1 without a pane hidden");
  });

  it("shows paneless agents with all", async () => {
    expect(await listText({ all: true })).toContain("a2");
  });

  it("applies limit after its own filters, not before", async () => {
    const paths: string[] = [];
    const out = (
      await sessionsModule.handlers.list_agents(
        { limit: 1, workspace: "other" },
        http(async (p) => {
          paths.push(p);
          return ROWS;
        }),
      )
    ).content[0].text;
    expect(out).toContain("a3");
    expect(paths[0]).not.toContain("limit");
  });

  it("filters by workspace path or last segment, and by pane", async () => {
    for (const workspace of ["feat-x", "/wt/feat-x", "/wt/feat-x/"]) {
      const out = await listText({ workspace });
      expect(out).toContain("a1");
      expect(out).not.toContain("a3");
    }
    const byPane = await listText({ pane: "pane-3" });
    expect(byPane).toContain("a3");
    expect(byPane).not.toContain("a1");
  });
});

describe("start_agent", () => {
  afterEach(() => vi.useRealTimers());

  const launch = (get: Http["get"]) =>
    agentsModule.handlers.start_agent(
      { projectId: "p1", workspacePath: "/wt/feat-x" },
      http(get, async () => ({ paneId: "pane-9", tabId: "t" })),
    );

  it("waits for the new agent to register and names it", async () => {
    vi.useFakeTimers();
    let looks = 0;
    const result = launch(async () => (++looks < 3 ? [] : [row("a9", "pane-9", "/wt/feat-x")]));
    await vi.advanceTimersByTimeAsync(3_000);
    const out = (await result).content[0].text;
    expect(out).toContain("pane pane-9");
    expect(out).toContain("Agent a9 is running");
  });

  it("says not to relaunch when the agent hasn't registered in time", async () => {
    vi.useFakeTimers();
    const result = launch(async () => []);
    await vi.advanceTimersByTimeAsync(25_000);
    const out = (await result).content[0].text;
    expect(out).toContain("Don't relaunch");
    expect(out).toContain("read-session --target pane-9");
  });
});
