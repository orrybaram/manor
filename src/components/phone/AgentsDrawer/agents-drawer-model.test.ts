import { describe, expect, it } from "vitest";
import type { AgentInfo, AgentStatus, PaneAgentStatus } from "../../../electron.d";
import type { ProjectInfo } from "../../../store/project-store";
import { buildAgentsDrawerModel, rowState } from "./agents-drawer-model";

type A = AgentInfo & { projectName: string };

function agent(id: string, over: Partial<A> = {}): A {
  return {
    id,
    paneId: `pane-${id}`,
    projectId: "p1",
    projectName: "One",
    hostId: "local",
    workspacePath: "/one/main",
    cwd: "/one/main",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as A;
}

function project(over: Partial<ProjectInfo>): ProjectInfo {
  return { hostId: "local", workspaces: [], color: null, ...over } as ProjectInfo;
}

const projects = [
  project({
    id: "p1",
    name: "One",
    color: "#111",
    path: "/one",
    workspaces: [
      { path: "/one/main", branch: "main", isMain: true, name: null },
      { path: "/one/feat", branch: "feat", isMain: false, name: "Feature" },
    ],
  }),
  project({ id: "p2", name: "Two", path: "/two" }),
];

function build(agents: A[], statuses: Record<string, AgentStatus> = {}) {
  const paneAgentStatus: Record<string, PaneAgentStatus> = {};
  for (const [id, status] of Object.entries(statuses)) {
    paneAgentStatus[`pane-${id}`] = { status, reason: "", kind: null };
  }
  return buildAgentsDrawerModel({ agents, paneAgentStatus, projects });
}

const ids = (xs: { agent: AgentInfo }[]) => xs.map((x) => x.agent.id);

describe("rowState", () => {
  it("ranks live work, then errors, then the rest", () => {
    expect(rowState("working")).toEqual({ rank: 0, label: "working" });
    expect(rowState("thinking")).toEqual({ rank: 0, label: "thinking" });
    expect(rowState("error")).toEqual({ rank: 1, label: "error" });
    expect(rowState("idle")).toEqual({ rank: 2, label: null });
    expect(rowState(undefined)).toEqual({ rank: 2, label: null });
  });
});

describe("buildAgentsDrawerModel", () => {
  it("splits requires_input into needsYou, newest first", () => {
    const m = build(
      [
        agent("a", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        agent("b", { updatedAt: "2026-01-03T00:00:00.000Z" }),
        agent("c"),
      ],
      { a: "requires_input", b: "requires_input", c: "idle" },
    );
    expect(ids(m.needsYou)).toEqual(["b", "a"]);
    expect(ids(m.groups[0].rows)).toEqual(["c"]);
  });

  it("resolves a needsYou card's project and workspace", () => {
    const m = build(
      [
        agent("a", { workspacePath: "/one/feat" }),
        agent("b"),
        agent("c", { workspacePath: "/one/gone" }),
      ],
      { a: "requires_input", b: "requires_input", c: "requires_input" },
    );
    const byId = new Map(m.needsYou.map((n) => [n.agent.id, n]));
    expect(byId.get("a")).toMatchObject({
      projectName: "One",
      color: "#111",
      workspaceLabel: "Feature",
    });
    expect(byId.get("b")?.workspaceLabel).toBe("main");
    expect(byId.get("c")?.workspaceLabel).toBe("gone");
  });

  it("leaves a requires_input agent with no project in its group", () => {
    const m = build([agent("a", { projectId: null, projectName: "Loose" })], {
      a: "requires_input",
    });
    expect(m.needsYou).toEqual([]);
    expect(m.groups.map((g) => g.key)).toEqual(["Loose"]);
  });

  it("orders groups like projects, unknown last alphabetically", () => {
    const m = build([
      agent("a", { projectId: "p2", projectName: "Two" }),
      agent("b", { projectId: "zz", projectName: "Zed" }),
      agent("c", { projectId: null, projectName: "Alpha" }),
      agent("d", { projectId: "p1" }),
    ]);
    expect(m.groups.map((g) => g.projectName)).toEqual(["One", "Two", "Alpha", "Zed"]);
    expect(m.groups.map((g) => g.key)).toEqual(["p1", "p2", "Alpha", "zz"]);
    expect(m.groups[0].color).toBe("#111");
    expect(m.groups[1].color).toBeNull();
    expect(m.groups[2].color).toBeNull();
  });

  it("ranks working/thinking, then error, then the rest, then by recency", () => {
    const m = build(
      [
        agent("idleNew", { updatedAt: "2026-01-09T00:00:00.000Z" }),
        agent("err", { updatedAt: "2026-01-02T00:00:00.000Z" }),
        agent("workOld", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        agent("thinkNew", { updatedAt: "2026-01-05T00:00:00.000Z" }),
        agent("resp", { updatedAt: "2026-01-08T00:00:00.000Z" }),
      ],
      {
        idleNew: "idle",
        err: "error",
        workOld: "working",
        thinkNew: "thinking",
        resp: "responded",
      },
    );
    const rows = m.groups[0].rows;
    expect(ids(rows)).toEqual(["thinkNew", "workOld", "err", "idleNew", "resp"]);
    expect(rows.map((r) => r.trailing).slice(0, 3)).toEqual(["thinking", "working", "error"]);
    expect(rows[2].error).toBe(true);
    expect(rows[3].trailing).toMatch(/ago$/);
    expect(rows[3].error).toBe(false);
  });

  it("drops groups with no remaining agents", () => {
    const m = build([agent("a", { projectId: "p2", projectName: "Two", workspacePath: "/two" })], {
      a: "requires_input",
    });
    expect(m.groups).toEqual([]);
    expect(ids(m.needsYou)).toEqual(["a"]);
  });

  it("treats an agent without a paneId as having no status", () => {
    const m = buildAgentsDrawerModel({
      agents: [agent("a", { paneId: null })],
      paneAgentStatus: { "pane-a": { status: "requires_input", reason: "", kind: null } },
      projects,
    });
    expect(m.needsYou).toEqual([]);
    expect(ids(m.groups[0].rows)).toEqual(["a"]);
  });
});
