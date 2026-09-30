import { describe, it, expect } from "vitest";
import {
  itemKey,
  needsYouItems,
  runningAgentCount,
  openPrCount,
  primaryMember,
  type NeedsYouInput,
} from "../home-dashboard";
import type { AgentInfo, PaneAgentStatus } from "../../electron.d";
import type { ProjectInfo, WorkspaceInfo } from "../../store/project-store";
import type { TopLevelEntry } from "../../utils/sidebar-items";
import type { PrInfo } from "../pr-info";

const basePr = (overrides: Partial<PrInfo> = {}): PrInfo => ({
  number: 1,
  state: "open",
  title: "some pr",
  url: "https://github.com/example/repo/pull/1",
  ...overrides,
});

const baseWorkspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  path: "/repo/ws",
  branch: "feature",
  isMain: false,
  name: "ws",
  ...overrides,
});

const baseProject = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  id: "p1",
  name: "Project One",
  path: "/repo/p1",
  defaultBranch: "main",
  workspaces: [],
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
  ...overrides,
});

const baseAgent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "a1",
  agentSessionId: "s1",
  name: "Agent",
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  completedAt: null,
  activatedAt: null,
  projectId: "p1",
  projectName: "Project One",
  hostId: "local",
  workspacePath: "/repo/ws",
  cwd: "/repo/ws",
  agentKind: "claude",
  agentCommand: null,
  paneId: "pane1",
  lastAgentStatus: null,
  resumedAt: null,
  ...overrides,
});

const baseNeedsYouInput = (overrides: Partial<NeedsYouInput> = {}): NeedsYouInput => ({
  projects: [],
  agents: [],
  paneAgentStatus: {},
  unseenRespondedAgentIds: new Set(),
  ...overrides,
});

const status = (status: PaneAgentStatus["status"]): PaneAgentStatus => ({
  status,
  reason: "",
  kind: "claude",
});

describe("needsYouItems", () => {
  it("orders the five tiers: input, error, blocked, ready, finished", () => {
    const ws1 = baseWorkspace({
      path: "/repo/p1/blocked",
      pr: basePr({
        url: "https://github.com/example/repo/pull/10",
        hasConflicts: true,
      }),
    });
    const ws2 = baseWorkspace({
      path: "/repo/p1/ready",
      pr: basePr({
        url: "https://github.com/example/repo/pull/11",
        isDraft: false,
        reviewDecision: "APPROVED",
      }),
    });
    const project = baseProject({ workspaces: [ws1, ws2] });

    const agentFinished = baseAgent({
      id: "finished",
      paneId: "pane-finished",
      workspacePath: "/repo/ws",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const agentError = baseAgent({
      id: "error",
      paneId: "pane-error",
      workspacePath: "/repo/ws",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    const agentInput = baseAgent({
      id: "input",
      paneId: "pane-input",
      workspacePath: "/repo/ws",
      updatedAt: "2024-01-03T00:00:00.000Z",
    });
    const project2 = baseProject({ id: "p2", name: "Project Two", workspaces: [] });

    const input = baseNeedsYouInput({
      projects: [project, project2],
      // Deliberately listed out of tier order.
      agents: [agentFinished, agentError, agentInput],
      paneAgentStatus: {
        "pane-finished": status("responded"),
        "pane-error": status("error"),
        "pane-input": status("requires_input"),
      },
      unseenRespondedAgentIds: new Set(["finished"]),
    });

    const items = needsYouItems(input);
    expect(items.map((i) => i.tier)).toEqual([
      "input",
      "error",
      "blocked",
      "ready",
      "finished",
    ]);
  });

  it("orders agents within a tier by oldest updatedAt first", () => {
    const newer = baseAgent({
      id: "newer",
      paneId: "pane-newer",
      updatedAt: "2024-02-01T00:00:00.000Z",
    });
    const older = baseAgent({
      id: "older",
      paneId: "pane-older",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const input = baseNeedsYouInput({
      projects: [baseProject()],
      agents: [newer, older],
      paneAgentStatus: {
        "pane-newer": status("requires_input"),
        "pane-older": status("requires_input"),
      },
    });

    const items = needsYouItems(input);
    expect(items.map((i) => (i.kind === "agent" ? i.agent.id : null))).toEqual([
      "older",
      "newer",
    ]);
  });

  it("orders PRs within a tier by project order, then workspace order", () => {
    const projectB = baseProject({
      id: "pB",
      name: "B",
      workspaces: [
        baseWorkspace({
          path: "/repo/pB/second",
          pr: basePr({ url: "https://github.com/example/repo/pull/2", hasConflicts: true }),
        }),
        baseWorkspace({
          path: "/repo/pB/third",
          pr: basePr({ url: "https://github.com/example/repo/pull/3", hasConflicts: true }),
        }),
      ],
    });
    const projectA = baseProject({
      id: "pA",
      name: "A",
      workspaces: [
        baseWorkspace({
          path: "/repo/pA/first",
          pr: basePr({ url: "https://github.com/example/repo/pull/1", hasConflicts: true }),
        }),
      ],
    });

    // `projects` order is B, A — the ranking must follow that, not alphabetical.
    const input = baseNeedsYouInput({ projects: [projectB, projectA] });
    const items = needsYouItems(input);
    expect(items.map((i) => (i.kind === "pr" ? i.pr.url : null))).toEqual([
      "https://github.com/example/repo/pull/2",
      "https://github.com/example/repo/pull/3",
      "https://github.com/example/repo/pull/1",
    ]);
  });

  it("excludes Home agents (no projectId)", () => {
    const homeAgent = baseAgent({
      id: "home",
      projectId: null,
      paneId: "pane-home",
    });
    const input = baseNeedsYouInput({
      projects: [baseProject()],
      agents: [homeAgent],
      paneAgentStatus: { "pane-home": status("requires_input") },
    });

    expect(needsYouItems(input)).toEqual([]);
  });

  it("dedupes PRs by url across workspaces", () => {
    const sharedUrl = "https://github.com/example/repo/pull/42";
    const project = baseProject({
      workspaces: [
        baseWorkspace({ path: "/repo/p1/a", pr: basePr({ url: sharedUrl, hasConflicts: true }) }),
        baseWorkspace({ path: "/repo/p1/b", pr: basePr({ url: sharedUrl, hasConflicts: true }) }),
      ],
    });
    const input = baseNeedsYouInput({ projects: [project] });
    const items = needsYouItems(input);
    expect(items).toHaveLength(1);
  });

  it("labels a blocked PR by the first applicable cause", () => {
    const project = baseProject({
      workspaces: [
        baseWorkspace({
          pr: basePr({ hasConflicts: true, unresolvedThreads: 3 }),
        }),
      ],
    });
    const [item] = needsYouItems(baseNeedsYouInput({ projects: [project] }));
    expect(item.kind).toBe("pr");
    if (item.kind === "pr") expect(item.reason).toBe("conflicts");
  });
});

describe("itemKey", () => {
  it("keys agents by id and PRs by URL", () => {
    const project = baseProject();
    const workspace = baseWorkspace();
    expect(itemKey({ kind: "agent", tier: "input", agent: baseAgent({ id: "x" }), project })).toBe(
      "agent:x",
    );
    expect(
      itemKey({ kind: "pr", tier: "ready", pr: basePr(), project, workspace, reason: "ready to merge" }),
    ).toBe("pr:https://github.com/example/repo/pull/1");
  });
});

describe("runningAgentCount", () => {
  it("counts panes that are thinking or working for a live agent, once per pane", () => {
    const agents: AgentInfo[] = [
      baseAgent({ id: "a1", paneId: "p1", status: "active" }),
      baseAgent({ id: "a2", paneId: "p2", status: "active" }),
      // Same pane as a1 (e.g. a stale record) — must not double-count.
      baseAgent({ id: "a3", paneId: "p1", status: "active" }),
      baseAgent({ id: "a4", paneId: "p3", status: "completed" }),
    ];
    const paneAgentStatus: Record<string, PaneAgentStatus> = {
      p1: status("thinking"),
      p2: status("working"),
      p3: status("thinking"),
    };
    expect(runningAgentCount(agents, paneAgentStatus)).toBe(2);
  });
});

describe("openPrCount", () => {
  it("dedupes open PRs by url", () => {
    const url = "https://github.com/example/repo/pull/7";
    const project = baseProject({
      workspaces: [
        baseWorkspace({ path: "/a", pr: basePr({ url }) }),
        baseWorkspace({ path: "/b", pr: basePr({ url }) }),
        baseWorkspace({ path: "/c", pr: basePr({ url: "other", state: "closed" }) }),
      ],
    });
    expect(openPrCount([project])).toBe(1);
  });
});

describe("primaryMember", () => {
  const group = (lastUsedHostId: string | null) => ({
    id: "g1",
    name: "Repo",
    memberIds: ["a", "b"],
    lastUsedHostId,
  });
  const groupEntry = (lastUsedHostId: string | null): TopLevelEntry<ProjectInfo> => {
    const a = baseProject({ id: "a", hostId: "local", group: group(lastUsedHostId) });
    const b = baseProject({ id: "b", hostId: "remote-1", group: group(lastUsedHostId) });
    return {
      kind: "group",
      key: "g1",
      group: group(lastUsedHostId),
      sections: [
        { project: a, items: [] },
        { project: b, items: [] },
      ],
    };
  };

  it("returns a lone project as is", () => {
    const project = baseProject();
    expect(primaryMember({ kind: "project", key: project.id, project })).toBe(project);
  });

  it("picks a group's lastUsedHostId member", () => {
    expect(primaryMember(groupEntry("remote-1"))?.id).toBe("b");
  });

  it("falls back to a group's first member", () => {
    expect(primaryMember(groupEntry(null))?.id).toBe("a");
    expect(primaryMember(groupEntry("gone"))?.id).toBe("a");
  });
});

