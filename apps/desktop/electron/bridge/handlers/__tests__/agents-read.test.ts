import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../../agent-persistence";
import { agentsGetAll, type AgentReadDeps } from "../agents-read";
import type { HandlerCtx } from "../../method";

function agent(id: string, name: string, createdAt: string): AgentInfo {
  return { id, name, projectName: null, workspacePath: null, status: "completed", createdAt } as AgentInfo;
}

function ctx(local: AgentInfo[], remote: AgentInfo[]): HandlerCtx<AgentReadDeps> {
  return {
    deps: {
      agentManager: { getAllAgents: () => local },
      hostRouting: { agents: () => remote },
    },
  } as unknown as HandlerCtx<AgentReadDeps>;
}

describe("agentsGetAll query", () => {
  it("filters this server's and remote hosts' agents before paging", () => {
    const c = ctx(
      [agent("l1", "toast fix", "2026-10-01"), agent("l2", "other", "2026-10-03")],
      [agent("r1", "Toast deck", "2026-10-02")],
    );
    expect(agentsGetAll(c, { query: "toast" }).map((a) => a.id)).toEqual(["r1", "l1"]);
    expect(agentsGetAll(c, { query: "toast", offset: 1, limit: 1 }).map((a) => a.id)).toEqual(["l1"]);
  });
});
