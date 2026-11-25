import { describe, it, expect } from "vitest";
import {
  formatNavCount,
  needsYouPhrase,
  visibleNeedsYouCount,
} from "../useNeedsYouCount";
import { itemKey, needsYouItems, type NeedsYouInput } from "../../lib/home-dashboard";
import type { AgentInfo, PaneAgentStatus } from "../../electron.d";
import type { ProjectInfo, WorkspaceInfo } from "../../store/project-store";

const workspace = (path: string, prUrl?: string): WorkspaceInfo => ({
  path,
  branch: "feature",
  isMain: false,
  name: path,
  ...(prUrl
    ? { pr: { number: 1, state: "open", title: "pr", url: prUrl, hasConflicts: true } }
    : {}),
});

const project = (workspaces: WorkspaceInfo[]): ProjectInfo => ({
  id: "p1",
  name: "Project One",
  path: "/repo/p1",
  defaultBranch: "main",
  workspaces,
  selectedWorkspaceIndex: 0,
  defaultRunCommand: null,
  worktreePath: null,
  worktreeStartScript: null,
  worktreeTeardownScript: null,
  linearAssociations: [],
  color: null,
  agentCommand: null,
  commands: [],
  themeName: null,
  setupComplete: true,
  portlessEnabled: true,
  hostId: "local",
  folders: [],
  sidebarOrder: [],
  group: null,
});

const agent = (id: string): AgentInfo => ({
  id,
  agentSessionId: `s-${id}`,
  name: id,
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  completedAt: null,
  activatedAt: null,
  projectId: "p1",
  projectName: "Project One",
  hostId: "local",
  workspacePath: "/repo/p1/ws",
  cwd: "/repo/p1/ws",
  agentKind: "claude",
  agentCommand: null,
  paneId: `pane-${id}`,
  lastAgentStatus: null,
  resumedAt: null,
  transcriptPath: null,
});

const status = (s: PaneAgentStatus["status"]): PaneAgentStatus => ({
  status: s,
  reason: "",
  kind: "claude",
});

// Two agents waiting on input, one errored, one finished and unseen, one
// running (not counted), and a PR with conflicts: five items.
const input: NeedsYouInput = {
  projects: [
    project([
      workspace("/repo/p1/ws"),
      workspace("/repo/p1/pr", "https://github.com/example/repo/pull/7"),
    ]),
  ],
  agents: [agent("a"), agent("b"), agent("c"), agent("d"), agent("e")],
  paneAgentStatus: {
    "pane-a": status("requires_input"),
    "pane-b": status("requires_input"),
    "pane-c": status("error"),
    "pane-d": status("responded"),
    "pane-e": status("thinking"),
  },
  unseenRespondedAgentIds: new Set(["d"]),
};

describe("visibleNeedsYouCount", () => {
  it("counts every Needs you item when nothing is snoozed", () => {
    expect(needsYouItems(input)).toHaveLength(5);
    expect(visibleNeedsYouCount(input, new Set())).toBe(5);
  });

  it("leaves out snoozed agents and PRs, by the dashboard's item key", () => {
    const snoozed = new Set([
      "agent:b",
      "pr:https://github.com/example/repo/pull/7",
      // A snooze for an item that no longer needs you changes nothing.
      "agent:gone",
    ]);
    expect(visibleNeedsYouCount(input, snoozed)).toBe(3);
    const keys = needsYouItems(input).map(itemKey);
    expect(keys).toContain("agent:b");
    expect(keys).toContain("pr:https://github.com/example/repo/pull/7");
  });

  it("is 0 when every item is snoozed", () => {
    const snoozed = new Set(needsYouItems(input).map(itemKey));
    expect(visibleNeedsYouCount(input, snoozed)).toBe(0);
  });
});

describe("formatNavCount", () => {
  it("caps at 99+", () => {
    expect(formatNavCount(7)).toBe("7");
    expect(formatNavCount(99)).toBe("99");
    expect(formatNavCount(100)).toBe("99+");
  });
});

describe("needsYouPhrase", () => {
  it("agrees with the count", () => {
    expect(needsYouPhrase(1)).toBe("1 needs you");
    expect(needsYouPhrase(7)).toBe("7 need you");
  });
});
