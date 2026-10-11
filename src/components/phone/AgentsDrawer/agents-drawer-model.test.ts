import { describe, expect, it } from "vitest";
import type { AgentInfo, AgentStatus } from "../../../electron.d";
import { buildAgentsDrawerModel } from "./agents-drawer-model";

type A = AgentInfo & { projectName: string };

function agent(id: string, over: Partial<A> = {}): A {
  return {
    id,
    paneId: `pane-${id}`,
    projectId: "p1",
    projectName: "One",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as A;
}

const projects = [
  { id: "p1", name: "One", color: "#111" },
  { id: "p2", name: "Two", color: null },
];

function build(agents: A[], statuses: Record<string, AgentStatus> = {}) {
  const statusByPane: Record<string, AgentStatus | undefined> = {};
  for (const [id, s] of Object.entries(statuses))
    statusByPane[`pane-${id}`] = s;
  return buildAgentsDrawerModel({ agents, statusByPane, projects });
}

const ids = (xs: AgentInfo[]) => xs.map((x) => x.id);

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
    expect(ids(m.groups[0].agents)).toEqual(["c"]);
  });

  it("orders groups like projects, unknown last alphabetically", () => {
    const m = build([
      agent("a", { projectId: "p2", projectName: "Two" }),
      agent("b", { projectId: "zz", projectName: "Zed" }),
      agent("c", { projectId: null, projectName: "Alpha" }),
      agent("d", { projectId: "p1" }),
    ]);
    expect(m.groups.map((g) => g.projectName)).toEqual([
      "One",
      "Two",
      "Alpha",
      "Zed",
    ]);
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
    expect(ids(m.groups[0].agents)).toEqual([
      "thinkNew",
      "workOld",
      "err",
      "idleNew",
      "resp",
    ]);
  });

  it("drops groups with no remaining agents", () => {
    const m = build([agent("a", { projectId: "p2", projectName: "Two" })], {
      a: "requires_input",
    });
    expect(m.groups).toEqual([]);
    expect(ids(m.needsYou)).toEqual(["a"]);
  });

  it("treats an agent without a paneId as having no status", () => {
    const m = buildAgentsDrawerModel({
      agents: [agent("a", { paneId: null })],
      statusByPane: { "pane-a": "requires_input" },
      projects,
    });
    expect(m.needsYou).toEqual([]);
    expect(ids(m.groups[0].agents)).toEqual(["a"]);
  });
});
