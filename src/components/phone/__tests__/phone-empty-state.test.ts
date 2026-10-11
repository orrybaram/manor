import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../../electron.d";
import type { HostId } from "../../../lib/hosts";
import {
  RECENT_AGENT_LIMIT,
  greetingFor,
  recentStatus,
  recentWorkspaceAgents,
} from "../phone-empty-state";

const LOCAL = "local" as HostId;
const REMOTE = "remote" as HostId;

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    id: "a",
    agentSessionId: "s",
    name: null,
    status: "completed",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    completedAt: null,
    activatedAt: null,
    projectId: "p",
    projectName: "manor",
    hostId: LOCAL,
    workspacePath: "/ws",
    cwd: "/ws",
    agentKind: "claude",
    agentCommand: null,
    paneId: null,
    lastAgentStatus: null,
    resumedAt: null,
    transcriptPath: null,
    ...over,
  } as AgentInfo;
}

describe("greetingFor", () => {
  it("follows the hour", () => {
    expect(greetingFor(new Date(2026, 0, 1, 8))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 0, 1, 13))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 0, 1, 21))).toBe("Good evening");
    expect(greetingFor(new Date(2026, 0, 1, 2))).toBe("Good evening");
  });
});

describe("recentWorkspaceAgents", () => {
  it("keeps this workspace's agents on this host, newest first", () => {
    const agents = [
      agent({ id: "old", updatedAt: "2026-10-01T00:00:00Z" }),
      agent({ id: "other-ws", workspacePath: "/elsewhere" }),
      agent({ id: "other-host", hostId: REMOTE }),
      agent({ id: "new", updatedAt: "2026-10-02T00:00:00Z" }),
    ];
    expect(recentWorkspaceAgents(agents, "/ws", LOCAL).map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("is empty with no workspace, and capped", () => {
    expect(recentWorkspaceAgents([agent({})], null, LOCAL)).toEqual([]);
    const many = Array.from({ length: RECENT_AGENT_LIMIT + 3 }, (_, i) => agent({ id: String(i) }));
    expect(recentWorkspaceAgents(many, "/ws", LOCAL)).toHaveLength(RECENT_AGENT_LIMIT);
  });
});

describe("recentStatus", () => {
  it("labels each lifecycle", () => {
    expect(recentStatus(agent({ status: "completed" }))).toEqual({ label: "Finished", tone: "done" });
    expect(recentStatus(agent({ status: "error" }))).toEqual({ label: "Errored", tone: "error" });
    expect(recentStatus(agent({ status: "abandoned" }))).toEqual({ label: "Interrupted", tone: "neutral" });
    expect(recentStatus(agent({ status: "active" }))).toEqual({ label: "Paused", tone: "neutral" });
  });
});
