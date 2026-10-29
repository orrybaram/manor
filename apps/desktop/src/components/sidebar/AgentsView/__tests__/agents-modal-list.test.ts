import { describe, expect, it } from "vitest";
import type { AgentInfo, SessionSummary } from "../../../../electron.d";
import {
  agentsModalRows,
  mergeModalRows,
  modalRowTitle,
  projectChips,
} from "../agents-modal-list";

function agent(over: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    name: null,
    projectName: null,
    workspacePath: null,
    paneId: null,
    status: "completed",
    createdAt: "2026-10-01T00:00:00Z",
    namePinned: false,
    hostId: "local",
    agentKind: "claude",
    agentSessionId: `sid-${over.id}`,
    cwd: "",
    projectId: null,
    ...over,
  } as AgentInfo;
}

function session(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  const kind = over.kind ?? "claude";
  return {
    id: `${kind}:${over.sessionId}`,
    hostId: "local",
    kind,
    title: `session ${over.sessionId}`,
    firstPrompt: "",
    cwd: "",
    gitBranch: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    messageCount: null,
    model: null,
    path: "",
    parentSessionId: null,
    ...over,
  };
}

function project(id: string, path: string, over: { hostId?: string; color?: string | null; workspaces?: string[] } = {}) {
  return {
    id,
    name: id,
    path,
    color: over.color ?? null,
    hostId: over.hostId ?? "local",
    workspaces: (over.workspaces ?? []).map((p) => ({ path: p })),
  };
}

const base = { searchAgents: [], query: "", tab: "all" as const, openPaneIds: new Set<string>(), liveTitles: {} };

describe("agentsModalRows", () => {
  it("Open lists only agents whose pane is in a workspace, whatever their lifecycle", () => {
    const storeAgents = [
      agent({ id: "stale", status: "active", paneId: "gone" }),
      agent({ id: "open", status: "completed", paneId: "p1" }),
      agent({ id: "none", status: "active" }),
    ];
    const openPaneIds = new Set(["p1"]);
    const ids = (tab: "all" | "open" | "closed") =>
      agentsModalRows({ ...base, storeAgents, openPaneIds, tab }).map((a) => a.id).sort();
    expect(ids("open")).toEqual(["open"]);
    expect(ids("closed")).toEqual(["none", "stale"]);
    expect(ids("all")).toEqual(["none", "open", "stale"]);
  });

  it("joins main's search page, keeps the store's copy, and filters both by the shown title", () => {
    const storeAgents = [
      agent({ id: "a", name: "old name", paneId: "p1", createdAt: "2026-10-03T00:00:00Z" }),
      agent({ id: "b", name: "unrelated", createdAt: "2026-10-02T00:00:00Z" }),
    ];
    const searchAgents = [
      agent({ id: "c", name: "toast deck", createdAt: "2026-09-01T00:00:00Z" }),
      agent({ id: "stale-page", name: "something else" }),
    ];
    const rows = agentsModalRows({
      ...base,
      storeAgents,
      searchAgents,
      query: "toast",
      liveTitles: { p1: "Toast stacking" },
    });
    expect(rows.map((a) => a.id)).toEqual(["a", "c"]);
  });
});

describe("mergeModalRows", () => {
  const merge = (input: Partial<Parameters<typeof mergeModalRows>[0]>) =>
    mergeModalRows({ agents: [], knownAgents: [], sessions: [], projects: [], ...input });

  it("lists a Session that is an Agent's once, as that Agent, with the Session's activity", () => {
    const rows = merge({
      agents: [agent({ id: "a", agentSessionId: "s1", createdAt: "2026-09-01T00:00:00Z" })],
      sessions: [session({ sessionId: "s1", updatedAt: "2026-10-05T00:00:00Z" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a");
    expect(rows[0].agent?.id).toBe("a");
    expect(rows[0].session?.sessionId).toBe("s1");
    expect(rows[0].activityAt).toBe("2026-10-05T00:00:00Z");
  });

  it("needs host, kind and session id to match; anything else is outside Manor", () => {
    const rows = merge({
      agents: [agent({ id: "a", agentSessionId: "s1" })],
      sessions: [
        session({ sessionId: "s1", hostId: "box" }),
        session({ sessionId: "s1", kind: "codex" }),
      ],
    });
    expect(rows).toHaveLength(3);
    const outside = rows.filter((r) => !r.agent);
    expect(outside.map((r) => r.id).sort()).toEqual(["session:box:claude:s1", "session:local:codex:s1"]);
    expect(rows.find((r) => r.id === "a")?.session).toBeUndefined();
  });

  it("recognises a Session whose Agent is on a page not loaded yet, and lists that Agent", () => {
    const old = agent({ id: "old", agentSessionId: "s9" });
    const rows = merge({ knownAgents: [old], sessions: [session({ sessionId: "s9" })] });
    expect(rows.map((r) => r.agent?.id)).toEqual(["old"]);
  });

  it("prefers the listed copy of an Agent over the known one", () => {
    const rows = merge({
      agents: [agent({ id: "a", agentSessionId: "s1", name: "live" })],
      knownAgents: [agent({ id: "a", agentSessionId: "s1", name: "stale" })],
      sessions: [session({ sessionId: "s1" })],
    });
    expect(rows[0].agent?.name).toBe("live");
  });

  it("files a Session under the project with the longest path containing its cwd, on its host", () => {
    const projects = [
      project("outer", "/code"),
      project("inner", "/elsewhere", { color: "blue", workspaces: ["/code/manor-wt/"] }),
      project("remote", "/code/manor-wt/deep", { hostId: "box" }),
    ];
    const rows = merge({
      projects,
      sessions: [
        session({ sessionId: "a", cwd: "/code/manor-wt/deep/src", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "b", cwd: "/code/other", updatedAt: "2026-10-02T00:00:00Z" }),
        session({ sessionId: "c", cwd: "/codex", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(rows.map((r) => r.project)).toEqual([
      { key: "inner", name: "inner", color: "blue" },
      { key: "outer", name: "outer", color: null },
      { key: "folder:codex", name: "codex", color: null },
    ]);
  });

  it("groups Sessions no project contains under their folder name, and an empty cwd under No project", () => {
    const rows = merge({
      sessions: [
        session({ sessionId: "a", cwd: "/home/me/scratch/", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "b", cwd: "/tmp/scratch", updatedAt: "2026-10-02T00:00:00Z" }),
        session({ sessionId: "c", cwd: "", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(rows.map((r) => r.project.key)).toEqual(["folder:scratch", "folder:scratch", "folder:"]);
    expect(rows[2].project.name).toBe("No project");
  });

  it("keeps an Agent's own project", () => {
    const rows = merge({
      projects: [project("mine", "/a", { color: "red" }), project("deeper", "/b/c")],
      agents: [agent({ id: "x", projectId: "mine", cwd: "/b/c" })],
    });
    expect(rows[0].project.key).toBe("mine");
  });
});

describe("agentsModalRows with Sessions", () => {
  const openPaneIds = new Set(["p1"]);
  const agents = [
    agent({ id: "open", agentSessionId: "s1", paneId: "p1" }),
    agent({ id: "closed", agentSessionId: "s2", paneId: "gone" }),
  ];
  const sessions = [
    session({ sessionId: "s1" }),
    session({ sessionId: "s2" }),
    session({ sessionId: "s3", title: "Fix the relay", firstPrompt: "why does reconnect jitter", cwd: "/w/relay" }),
  ];
  const rowsFor = (over: Partial<Parameters<typeof agentsModalRows>[0]>) =>
    agentsModalRows({ ...base, storeAgents: agents, sessions, openPaneIds, ...over }).map((r) => r.id).sort();

  it("Open is Agents in an open pane; Closed is the rest, outside-Manor Sessions included", () => {
    expect(rowsFor({ tab: "open" })).toEqual(["open"]);
    expect(rowsFor({ tab: "closed" })).toEqual(["closed", "session:local:claude:s3"]);
  });

  it("searches a Session's title, first prompt and folder", () => {
    expect(rowsFor({ query: "relay" })).toEqual(["session:local:claude:s3"]);
    expect(rowsFor({ query: "jitter" })).toEqual(["session:local:claude:s3"]);
    expect(rowsFor({ query: "w/relay" })).toEqual(["session:local:claude:s3"]);
    expect(rowsFor({ query: "nothing-like-it" })).toEqual([]);
  });
});

describe("modalRowTitle", () => {
  it("takes the Agent's name, else the Session's title", () => {
    const s = session({ sessionId: "s1", title: "From disk" });
    expect(modalRowTitle({ id: "a", agent: agent({ id: "a", name: "Mine" }), session: s, project: { key: "", name: "", color: null }, activityAt: "" }, null)).toBe("Mine");
    expect(modalRowTitle({ id: "a", agent: agent({ id: "a" }), session: s, project: { key: "", name: "", color: null }, activityAt: "" }, null)).toBe("From disk");
    expect(modalRowTitle({ id: "a", agent: agent({ id: "a" }), project: { key: "", name: "", color: null }, activityAt: "" }, null)).toBe("Agent");
  });
});

describe("projectChips", () => {
  it("lists each project once, latest activity first, and keeps the selected one", () => {
    const rows = mergeModalRows({
      agents: [],
      knownAgents: [],
      projects: [project("manor", "/m", { color: "green" })],
      sessions: [
        session({ sessionId: "a", cwd: "/m/x", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "b", cwd: "/tmp/scratch", updatedAt: "2026-10-02T00:00:00Z" }),
        session({ sessionId: "c", cwd: "/m", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(projectChips(rows, null).map((p) => p.key)).toEqual(["manor", "folder:scratch"]);
    const gone = { key: "folder:old", name: "old", color: null };
    expect(projectChips(rows, gone).map((p) => p.key)).toEqual(["manor", "folder:scratch", "folder:old"]);
  });
});
