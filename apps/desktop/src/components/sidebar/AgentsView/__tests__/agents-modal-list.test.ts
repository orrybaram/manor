import { describe, expect, it } from "vitest";
import type { AgentInfo, SessionSummary } from "../../../../electron.d";
import {
  filterModalRows,
  listedAgents,
  mergeModalRows,
  modalRowTitle,
  chipKey,
  projectChips,
  rowPaneId,
  sessionRows,
  type AgentTab,
  type ModalRow,
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

function project(
  id: string,
  path: string,
  over: { hostId?: string; color?: string | null; workspaces?: string[] } = {},
) {
  return {
    id,
    name: id,
    path,
    color: over.color ?? null,
    hostId: over.hostId ?? "local",
    workspaces: (over.workspaces ?? []).map((p) => ({ path: p })),
  };
}

type Projects = ReturnType<typeof project>[];

function merge(input: {
  agents?: AgentInfo[];
  knownAgents?: AgentInfo[];
  sessions?: SessionSummary[];
  projects?: Projects;
}): ModalRow[] {
  return mergeModalRows({
    sessions: sessionRows(input.sessions ?? [], input.projects ?? []),
    agents: input.agents ?? [],
    knownAgents: input.knownAgents ?? [],
  });
}

/** The whole pipeline the modal runs, before the project filter. */
function rowsFor(input: {
  storeAgents?: AgentInfo[];
  searchAgents?: AgentInfo[];
  sessions?: SessionSummary[];
  query?: string;
  tab?: AgentTab;
  openPaneIds?: Set<string>;
  liveTitles?: Record<string, string>;
}): readonly ModalRow[] {
  const query = input.query ?? "";
  const rows = merge({
    agents: [...listedAgents(input.storeAgents ?? [], input.searchAgents ?? [], query)],
    sessions: input.sessions,
  });
  return filterModalRows(rows, {
    query,
    tab: input.tab ?? "all",
    openPaneIds: input.openPaneIds ?? new Set(),
    liveTitles: input.liveTitles ?? {},
  });
}

const ids = (rows: readonly ModalRow[]) => rows.map((r) => r.id).sort();

describe("Agents modal rows", () => {
  it("Open lists only agents whose pane is in a workspace, whatever their lifecycle", () => {
    const storeAgents = [
      agent({ id: "stale", status: "active", paneId: "gone" }),
      agent({ id: "open", status: "completed", paneId: "p1" }),
      agent({ id: "none", status: "active" }),
    ];
    const openPaneIds = new Set(["p1"]);
    expect(ids(rowsFor({ storeAgents, openPaneIds, tab: "open" }))).toEqual(["open"]);
    expect(ids(rowsFor({ storeAgents, openPaneIds, tab: "closed" }))).toEqual(["none", "stale"]);
    expect(ids(rowsFor({ storeAgents, openPaneIds, tab: "all" }))).toEqual(["none", "open", "stale"]);
  });

  it("joins main's search page, keeps the store's copy, and filters both by the shown title", () => {
    const rows = rowsFor({
      storeAgents: [
        agent({ id: "a", name: "old name", paneId: "p1", createdAt: "2026-10-03T00:00:00Z" }),
        agent({ id: "b", name: "unrelated", createdAt: "2026-10-02T00:00:00Z" }),
      ],
      searchAgents: [
        agent({ id: "c", name: "toast deck", createdAt: "2026-09-01T00:00:00Z" }),
        agent({ id: "stale-page", name: "something else" }),
      ],
      query: "toast",
      liveTitles: { p1: "Toast stacking" },
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("Open is Agents in an open pane; Closed is the rest, outside-Manor Sessions included", () => {
    const input = {
      storeAgents: [
        agent({ id: "open", agentSessionId: "s1", paneId: "p1" }),
        agent({ id: "closed", agentSessionId: "s2", paneId: "gone" }),
      ],
      sessions: [session({ sessionId: "s1" }), session({ sessionId: "s2" }), session({ sessionId: "s3" })],
      openPaneIds: new Set(["p1"]),
    };
    expect(ids(rowsFor({ ...input, tab: "open" }))).toEqual(["open"]);
    expect(ids(rowsFor({ ...input, tab: "closed" }))).toEqual(["closed", "session:local:claude:s3"]);
  });

  it("searches a Session's title, first prompt and folder", () => {
    const sessions = [
      session({ sessionId: "s1" }),
      session({ sessionId: "s3", title: "Fix the relay", firstPrompt: "why does reconnect jitter", cwd: "/w/relay" }),
    ];
    for (const query of ["relay", "jitter", "w/relay"]) {
      expect(ids(rowsFor({ sessions, query }))).toEqual(["session:local:claude:s3"]);
    }
    expect(ids(rowsFor({ sessions, query: "nothing-like-it" }))).toEqual([]);
  });

  it("searches an untitled Session by the title it shows", () => {
    const sessions = [
      session({ sessionId: "s1", title: "", firstPrompt: "", cwd: "/code/scratchpad" }),
      session({ sessionId: "s2", title: "", firstPrompt: "", cwd: "" }),
    ];
    const [row] = rowsFor({ sessions, query: "scratchpad" });
    expect(row.id).toBe("session:local:claude:s1");
    expect(modalRowTitle(row, null)).toBe("scratchpad");
    expect(ids(rowsFor({ sessions, query: "session" }))).toEqual(["session:local:claude:s2"]);
  });
});

describe("mergeModalRows", () => {
  it("lists a Session that is an Agent's once, as that Agent, with the Session's activity", () => {
    const rows = merge({
      agents: [agent({ id: "a", agentSessionId: "s1", createdAt: "2026-09-01T00:00:00Z" })],
      sessions: [session({ sessionId: "s1", updatedAt: "2026-10-05T00:00:00Z" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a");
    expect(rows[0].session?.sessionId).toBe("s1");
    expect(rows[0].activityAt).toBe("2026-10-05T00:00:00Z");
  });

  it("matches on kind and session id alone, keeping the Session's host", () => {
    const rows = merge({
      agents: [agent({ id: "a", agentSessionId: "s1", hostId: "box-alias" })],
      sessions: [session({ sessionId: "s1", hostId: "box" }), session({ sessionId: "s1", kind: "codex" })],
    });
    expect(ids(rows)).toEqual(["a", "session:local:codex:s1"]);
    expect(rows.find((r) => r.id === "a")?.session?.hostId).toBe("box");
  });

  it("recognises a Session whose Agent is on a page not loaded yet, and lists that Agent", () => {
    const rows = merge({
      knownAgents: [agent({ id: "old", agentSessionId: "s9" })],
      sessions: [session({ sessionId: "s9" })],
    });
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

  it("interleaves Agent-only rows and Session rows by activity", () => {
    const rows = merge({
      agents: [agent({ id: "mid", createdAt: "2026-10-02T00:00:00Z" })],
      sessions: [
        session({ sessionId: "new", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "old", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["session:local:claude:new", "mid", "session:local:claude:old"]);
  });

  it("keeps a row's object when its Agent and Session are unchanged", () => {
    const a = agent({ id: "a", agentSessionId: "s1" });
    const b = agent({ id: "b" });
    const base = sessionRows([session({ sessionId: "s1" }), session({ sessionId: "s2" })], []);
    const first = mergeModalRows({ sessions: base, agents: [a, b], knownAgents: [] });
    const second = mergeModalRows(
      { sessions: base, agents: [a, { ...b, status: "active" }], knownAgents: [] },
      new Map(first.map((r) => [r.id, r])),
    );
    const byId = (rows: ModalRow[], id: string) => rows.find((r) => r.id === id);
    expect(byId(second, "a")).toBe(byId(first, "a"));
    expect(byId(second, "session:local:claude:s2")).toBe(byId(first, "session:local:claude:s2"));
    expect(byId(second, "b")).not.toBe(byId(first, "b"));
  });

  it("files a Session under the project with the longest path containing its cwd, on its host", () => {
    const rows = merge({
      projects: [
        project("outer", "/code"),
        project("inner", "/elsewhere", { color: "blue", workspaces: ["/code/manor-wt/"] }),
        project("remote", "/code/manor-wt/deep", { hostId: "box" }),
      ],
      sessions: [
        session({ sessionId: "a", cwd: "/code/manor-wt/deep/src", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "b", cwd: "/code/other", updatedAt: "2026-10-02T00:00:00Z" }),
        session({ sessionId: "c", cwd: "/codex", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(rows.map((r) => r.project.key)).toEqual(["inner", "outer", "folder:local:/codex"]);
    expect(rows[0].project.color).toBe("blue");
  });

  it("compares Windows paths whatever their case and slashes, and POSIX paths exactly", () => {
    const rows = merge({
      projects: [project("win", "C:\\Code\\Manor"), project("posix", "/Code/Manor")],
      sessions: [
        session({ sessionId: "a", cwd: "c:/code/manor/src", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "b", cwd: "/code/manor", updatedAt: "2026-10-02T00:00:00Z" }),
      ],
    });
    expect(rows.map((r) => r.project.key)).toEqual(["win", "folder:local:/code/manor"]);
  });

  it("groups Sessions no project contains by host and folder path, named for the folder", () => {
    const rows = merge({
      sessions: [
        session({ sessionId: "a", cwd: "/home/me/scratch/", updatedAt: "2026-10-04T00:00:00Z" }),
        session({ sessionId: "b", cwd: "/home/me/scratch", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "c", cwd: "/tmp/scratch", updatedAt: "2026-10-02T00:00:00Z" }),
        session({ sessionId: "d", cwd: "", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(rows.map((r) => r.project.key)).toEqual([
      "folder:local:/home/me/scratch",
      "folder:local:/home/me/scratch",
      "folder:local:/tmp/scratch",
      "folder:local:",
    ]);
    expect(rows[0].project).toBe(rows[1].project);
    expect(rows[2].project.name).toBe("scratch");
    expect(rows[3].project.name).toBe("No project");
  });

  it("keeps an Agent's own project", () => {
    const rows = merge({
      projects: [project("mine", "/a", { color: "red" }), project("deeper", "/b/c")],
      agents: [agent({ id: "x", projectId: "mine", cwd: "/b/c" })],
    });
    expect(rows[0].project.key).toBe("mine");
  });
});

describe("modalRowTitle", () => {
  const p = { key: "", name: "", color: null };
  it("takes the Agent's name, else the Session's title, prompt or folder", () => {
    const s = session({ sessionId: "s1", title: "From disk" });
    const row = (over: Partial<ModalRow>): ModalRow => ({ id: "a", project: p, activityAt: "", ...over });
    expect(modalRowTitle(row({ agent: agent({ id: "a", name: "Mine" }), session: s }), null)).toBe("Mine");
    expect(modalRowTitle(row({ agent: agent({ id: "a" }), session: s }), null)).toBe("From disk");
    expect(modalRowTitle(row({ agent: agent({ id: "a" }) }), null)).toBe("Agent");
    expect(
      modalRowTitle(row({ session: session({ sessionId: "s", title: "", firstPrompt: "hello there" }) }), null),
    ).toBe("hello there");
  });
});

describe("projectChips", () => {
  it("lists each project once, latest activity first, folders last, and keeps the selected one", () => {
    const rows = merge({
      projects: [project("manor", "/m", { color: "green" })],
      sessions: [
        session({ sessionId: "b", cwd: "/tmp/scratch", updatedAt: "2026-10-04T00:00:00Z" }),
        session({ sessionId: "a", cwd: "/m/x", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "d", cwd: "/tmp/spike-1", updatedAt: "2026-10-02T00:00:00Z" }),
        session({ sessionId: "c", cwd: "/m", updatedAt: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(projectChips(rows, null)).toEqual([
      { key: "project:manor", label: "manor", color: "green" },
      { key: "folders", label: "Other folders", color: null },
    ]);
    const gone = { key: "project:old", label: "old", color: null };
    expect(projectChips(rows, gone).map((c) => c.key)).toEqual(["project:manor", "folders", "project:old"]);
  });

  it("gives same-named projects on different hosts one chip", () => {
    const rows = merge({
      projects: [
        { ...project("mac", "/Users/me/manor"), name: "manor" },
        { ...project("wsl", "/home/me/manor", { hostId: "wsl" }), name: "manor" },
      ],
      sessions: [
        session({ sessionId: "a", cwd: "/Users/me/manor", updatedAt: "2026-10-03T00:00:00Z" }),
        session({ sessionId: "b", hostId: "wsl", cwd: "/home/me/manor", updatedAt: "2026-10-02T00:00:00Z" }),
      ],
    });
    expect(projectChips(rows, null).map((c) => c.key)).toEqual(["project:manor"]);
    expect(rows.filter((r) => chipKey(r.project) === "project:manor")).toHaveLength(2);
  });
});

describe("rowPaneId", () => {
  const open = new Set(["pane-a", "pane-l"]);
  it("is the Agent's open pane, else the pane Manor launched the session into", () => {
    const s = session({ sessionId: "s1", kind: "opencode" });
    const base = { id: "r", project: { key: "", name: "", color: null }, activityAt: "" };
    expect(rowPaneId({ ...base, agent: agent({ id: "a", paneId: "pane-a" }) }, open)).toBe("pane-a");
    expect(rowPaneId({ ...base, session: s }, open, { "opencode:s1": "pane-l" })).toBe("pane-l");
    expect(rowPaneId({ ...base, session: s }, open, { "opencode:s1": "pane-gone" })).toBeNull();
    expect(rowPaneId({ ...base, session: s }, open)).toBeNull();
  });
});
