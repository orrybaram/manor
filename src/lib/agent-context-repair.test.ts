import { describe, it, expect } from "vitest";
import { orphanedAgentContexts, type LayoutPanes } from "./agent-context-repair";
import { HOME_PATH } from "./home";
import type { AgentInfo } from "../electron.d";
import type { ProjectInfo } from "../store/project-store";

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    id: "a1", name: null, status: "active", createdAt: "", updatedAt: "", completedAt: null,
    activatedAt: null, projectId: null, projectName: null, hostId: "local", workspacePath: null,
    cwd: "", agentKind: "claude", agentCommand: null, paneId: "pane-1", lastAgentStatus: null,
    resumedAt: null, ...over,
  } as AgentInfo;
}

function layout(...paneIds: string[]): LayoutPanes {
  return {
    panels: {
      p: {
        tabs: paneIds.map((paneId) => ({ rootNode: { type: "leaf" as const, paneId } })),
      },
    },
  };
}

const tango = {
  id: "proj-tango",
  name: "tango",
  hostId: "local",
  agentCommand: "claude",
  workspaces: [{ path: "/w/tango" }, { path: "/w/tango-feature" }],
} as unknown as ProjectInfo;

describe("orphanedAgentContexts", () => {
  it("derives a context-less Agent's project from the layout holding its pane", () => {
    const contexts = orphanedAgentContexts(
      [agent({})],
      { "/w/tango": layout("pane-0"), "/w/tango-feature": layout("pane-1") },
      [tango],
    );
    expect(contexts.get("pane-1")).toEqual({
      projectId: "proj-tango",
      projectName: "tango",
      workspacePath: "/w/tango-feature",
      agentCommand: "claude",
    });
    expect(contexts.size).toBe(1);
  });

  it("skips Agents that already know their workspace, or are not active", () => {
    const known = agent({ projectId: "proj-tango", projectName: "tango", workspacePath: "/w/tango" });
    const done = agent({ id: "a2", status: "completed" });
    expect(orphanedAgentContexts([known, done], { "/w/tango": layout("pane-1") }, [tango]).size).toBe(0);
  });

  it("leaves a pane in a workspace no project owns alone", () => {
    expect(orphanedAgentContexts([agent({})], { "/w/elsewhere": layout("pane-1") }, [tango]).size).toBe(0);
  });

  it("skips a Home pane's Agent (Home has no owning project)", () => {
    const contexts = orphanedAgentContexts([agent({})], { [HOME_PATH]: layout("pane-1") }, [tango]);
    expect(contexts.size).toBe(0);
  });
});
