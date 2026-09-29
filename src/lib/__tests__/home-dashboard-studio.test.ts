import { describe, it, expect } from "vitest";
import {
  headline,
  needsYouCards,
  openPrStats,
  prPipeline,
  prStage,
  projectTiles,
  type NeedsYouCardsInput,
  type ProjectTileDeps,
} from "../home-dashboard-studio";
import type { AgentInfo, PaneAgentStatus } from "../../electron.d";
import type { ProjectInfo, WorkspaceInfo } from "../../store/project-store";
import type { HostStatusInfo } from "../../store/host-store";
import type { PrInfo } from "../pr-info";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2024-01-02T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

const basePr = (overrides: Partial<PrInfo> = {}): PrInfo => ({
  number: 1,
  state: "open",
  title: "some pr",
  url: "https://github.com/example/repo/pull/1",
  ...overrides,
});

const baseWorkspace = (
  overrides: Partial<WorkspaceInfo> = {},
): WorkspaceInfo => ({
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

const status = (status: PaneAgentStatus["status"]): PaneAgentStatus => ({
  status,
  reason: "",
  kind: "claude",
});

const prUrl = (n: number) => `https://github.com/example/repo/pull/${n}`;
const checks = (passing: number, failing: number, pending: number) => ({
  passing,
  failing,
  pending,
  total: passing + failing + pending,
});

describe("prStage", () => {
  it("puts pending PRs with running checks in checks", () => {
    expect(prStage(basePr({ checks: checks(1, 0, 2) }))).toBe("checks");
    expect(prStage(basePr({ isDraft: true, checks: checks(1, 0, 2) }))).toBe(
      "checks",
    );
  });

  it("puts review, drafts and idle pending PRs in review", () => {
    expect(prStage(basePr({ reviewDecision: "REVIEW_REQUIRED" }))).toBe(
      "review",
    );
    expect(prStage(basePr({ isDraft: true, checks: checks(3, 0, 0) }))).toBe(
      "review",
    );
    expect(prStage(basePr())).toBe("review");
  });

  it("maps blocked, ready and queued", () => {
    expect(
      prStage(basePr({ hasConflicts: true, checks: checks(0, 0, 2) })),
    ).toBe("blocked");
    expect(prStage(basePr({ reviewDecision: "APPROVED" }))).toBe("ready");
    expect(
      prStage(basePr({ queuedToMerge: true, checks: checks(0, 0, 1) })),
    ).toBe("ready");
  });
});

describe("prPipeline / openPrStats", () => {
  const project = baseProject({
    workspaces: [
      baseWorkspace({
        path: "/a",
        pr: basePr({
          url: prUrl(1),
          checks: checks(1, 0, 1),
          updatedAt: hoursAgo(1),
        }),
      }),
      baseWorkspace({
        path: "/b",
        pr: basePr({ url: prUrl(2), isDraft: true }),
      }),
      baseWorkspace({
        path: "/c",
        pr: basePr({
          url: prUrl(3),
          reviewDecision: "REVIEW_REQUIRED",
          updatedAt: hoursAgo(30),
        }),
      }),
      baseWorkspace({
        path: "/d",
        pr: basePr({
          url: prUrl(4),
          hasConflicts: true,
          updatedAt: hoursAgo(2),
        }),
      }),
      baseWorkspace({
        path: "/e",
        pr: basePr({ url: prUrl(5), queuedToMerge: true }),
      }),
      baseWorkspace({
        path: "/f",
        pr: basePr({ url: prUrl(6), state: "merged" }),
      }),
      baseWorkspace({
        path: "/g",
        pr: basePr({ url: prUrl(3), reviewDecision: "REVIEW_REQUIRED" }),
      }),
      baseWorkspace({
        path: "/h",
        pr: basePr({
          url: prUrl(7),
          reviewDecision: "REVIEW_REQUIRED",
          updatedAt: hoursAgo(5),
        }),
      }),
    ],
  });

  it("columns open PRs in stage order, deduped, with labels, checks and ages", () => {
    const pipeline = prPipeline([project], NOW);
    expect(pipeline.map((c) => c.stage)).toEqual([
      "checks",
      "review",
      "blocked",
      "ready",
    ]);
    const urls = pipeline.map((c) => c.rows.map((r) => r.pr.url));
    // Review: oldest first (#3 at 30h, #7 at 5h), unknown age (#2) last.
    expect(urls).toEqual([
      [prUrl(1)],
      [prUrl(3), prUrl(7), prUrl(2)],
      [prUrl(4)],
      [prUrl(5)],
    ]);

    const [checksCol, reviewCol, blockedCol, readyCol] = pipeline;
    expect(checksCol.rows[0]).toMatchObject({
      label: null,
      checks: { passing: 1, failing: 0, pending: 1, total: 2 },
      ageMs: HOUR,
      stale: false,
    });
    expect(reviewCol.rows[0]).toMatchObject({ ageMs: 30 * HOUR, stale: true });
    expect(reviewCol.rows[2]).toMatchObject({
      label: "draft",
      ageMs: null,
      stale: false,
      checks: null,
    });
    expect(blockedCol.rows[0].label).toBe("conflicts");
    expect(readyCol.rows[0].label).toBe("queued");
  });

  it("summarizes a pipeline", () => {
    expect(openPrStats(prPipeline([project], NOW))).toEqual({
      total: 6,
      oldestAgeMs: 30 * HOUR,
      byStage: { checks: 1, review: 3, blocked: 1, ready: 1 },
    });
    expect(openPrStats(prPipeline([], NOW))).toEqual({
      total: 0,
      oldestAgeMs: null,
      byStage: { checks: 0, review: 0, blocked: 0, ready: 0 },
    });
  });
});

describe("needsYouCards", () => {
  const cardsInput = (
    overrides: Partial<NeedsYouCardsInput> = {},
  ): NeedsYouCardsInput => ({
    projects: [],
    agents: [],
    paneAgentStatus: {},
    unseenRespondedAgentIds: new Set(),
    ...overrides,
  });

  const project = baseProject({
    workspaces: [
      baseWorkspace({ path: "/repo/ws", diffStats: { added: 12, removed: 3 } }),
      baseWorkspace({
        path: "/checks",
        pr: basePr({
          url: prUrl(1),
          checks: checks(4, 2, 0),
          checkRuns: [
            { name: "lint", status: "failing", url: "https://ci/lint" },
            { name: "unit", status: "failing" },
            { name: "build", status: "passing", url: "https://ci/build" },
          ],
          updatedAt: hoursAgo(3),
        }),
      }),
      baseWorkspace({
        path: "/conflicts",
        pr: basePr({ url: prUrl(2), hasConflicts: true }),
      }),
      baseWorkspace({
        path: "/changes",
        pr: basePr({ url: prUrl(3), reviewDecision: "CHANGES_REQUESTED" }),
      }),
      baseWorkspace({
        path: "/threads",
        pr: basePr({ url: prUrl(4), unresolvedThreads: 2 }),
      }),
      baseWorkspace({
        path: "/ready",
        pr: basePr({
          url: prUrl(5),
          reviewDecision: "APPROVED",
          checks: checks(5, 0, 0),
        }),
      }),
    ],
  });

  const agents = [
    baseAgent({ id: "input", paneId: "p-input", updatedAt: hoursAgo(2) }),
    baseAgent({ id: "error", paneId: "p-error", updatedAt: hoursAgo(1) }),
    baseAgent({ id: "done", paneId: "p-done", updatedAt: hoursAgo(1) }),
  ];

  const input = cardsInput({
    projects: [project],
    agents,
    paneAgentStatus: {
      "p-input": status("requires_input"),
      "p-error": status("error"),
      "p-done": status("responded"),
    },
    unseenRespondedAgentIds: new Set(["done"]),
    paneTitle: { "p-error": "npm test" },
  });

  it("keeps tier order and attaches context, key and age", () => {
    const cards = needsYouCards(input, NOW);
    expect(cards.map((c) => c.key)).toEqual([
      "agent:input",
      "agent:error",
      `pr:${prUrl(1)}`,
      `pr:${prUrl(2)}`,
      `pr:${prUrl(3)}`,
      `pr:${prUrl(4)}`,
      `pr:${prUrl(5)}`,
      "agent:done",
    ]);
    expect(cards.map((c) => c.context)).toEqual([
      { kind: "input" },
      { kind: "error", paneTitle: "npm test" },
      {
        kind: "checks",
        failing: [
          { name: "lint", url: "https://ci/lint" },
          { name: "unit", url: null },
        ],
        failingCount: 2,
        passing: 4,
        total: 6,
      },
      { kind: "conflicts" },
      { kind: "changes-requested" },
      { kind: "threads", count: 2 },
      { kind: "ready", approved: true, checksPassing: 5, checksTotal: 5 },
      { kind: "finished", diff: { added: 12, removed: 3 } },
    ]);
    expect(cards[0].ageMs).toBe(2 * HOUR);
    expect(cards[2].ageMs).toBe(3 * HOUR);
    expect(cards[3].ageMs).toBeNull();
  });

  it("drops snoozed items", () => {
    const cards = needsYouCards(
      { ...input, snoozed: new Set(["agent:error", `pr:${prUrl(2)}`]) },
      NOW,
    );
    expect(cards.map((c) => c.key)).not.toContain("agent:error");
    expect(cards.map((c) => c.key)).not.toContain(`pr:${prUrl(2)}`);
    expect(cards).toHaveLength(6);
  });

  it("omits the error pane title and finished diff when unknown", () => {
    const cards = needsYouCards(
      cardsInput({
        projects: [baseProject({ workspaces: [baseWorkspace()] })],
        agents: [
          baseAgent({ id: "e", paneId: "pe" }),
          baseAgent({ id: "f", paneId: "pf" }),
        ],
        paneAgentStatus: { pe: status("error"), pf: status("responded") },
        unseenRespondedAgentIds: new Set(["f"]),
      }),
      NOW,
    );
    expect(cards.map((c) => c.context)).toEqual([
      { kind: "error" },
      { kind: "finished" },
    ]);
  });
});

describe("headline", () => {
  it("reads the mockup sentence", () => {
    expect(headline({ needsYou: 3, running: 3, openPrs: 5 })).toEqual({
      lead: "3 things need you.",
      rest: "3 agents are working and 5 PRs are with reviewers.",
    });
  });

  it("uses singulars and drops zero clauses", () => {
    expect(headline({ needsYou: 1, running: 1, openPrs: 0 })).toEqual({
      lead: "1 thing needs you.",
      rest: "1 agent is working.",
    });
    expect(headline({ needsYou: 0, running: 0, openPrs: 1 })).toEqual({
      lead: "Nothing needs you.",
      rest: "1 PR is with reviewers.",
    });
  });

  it("reads all clear when everything is zero", () => {
    expect(headline({ needsYou: 0, running: 0, openPrs: 0 })).toEqual({
      lead: "All clear.",
      rest: "No agents running and no open PRs.",
    });
    expect(headline({ needsYou: 2, running: 0, openPrs: 0 }).rest).toBe(
      "No agents running and no open PRs.",
    );
  });
});

describe("projectTiles", () => {
  const host = (
    hostId: string,
    s: HostStatusInfo["status"],
  ): HostStatusInfo => ({
    hostId,
    spec: null,
    status: s,
  });
  const deps = (overrides: Partial<ProjectTileDeps> = {}): ProjectTileDeps => ({
    projects: [],
    agents: [],
    paneAgentStatus: {},
    unseenRespondedAgentIds: new Set(),
    hosts: [host("local", "connected")],
    hostName: (id) => (id === "local" ? "local" : id),
    now: NOW,
    ...overrides,
  });

  const group = {
    id: "g1",
    name: "Repo",
    memberIds: ["a", "b"],
    lastUsedHostId: null,
  };
  const memberA = baseProject({
    id: "a",
    name: "Repo",
    hostId: "local",
    color: "#f00",
    group,
    workspaces: [
      baseWorkspace({
        path: "/a/needs",
        name: "needs",
        pr: basePr({ url: prUrl(1), hasConflicts: true }),
      }),
      baseWorkspace({
        path: "/a/run",
        name: "run",
        diffStats: { added: 10, removed: 2 },
      }),
      baseWorkspace({
        path: "/a/hidden",
        hidden: true,
        diffStats: { added: 99, removed: 99 },
      }),
    ],
  });
  const memberB = baseProject({
    id: "b",
    name: "Repo",
    hostId: "devbox",
    color: "#f00",
    group,
    workspaces: [
      baseWorkspace({
        path: "/b/ready",
        name: null,
        pr: basePr({ url: prUrl(2), queuedToMerge: true }),
      }),
      baseWorkspace({
        path: "/b/open",
        name: "open",
        pr: basePr({ url: prUrl(3) }),
        diffStats: { added: 5, removed: 1 },
      }),
      baseWorkspace({ path: "/b/idle", name: "idle" }),
    ],
  });
  const solo = baseProject({
    id: "solo",
    name: "Solo",
    workspaces: [baseWorkspace({ path: "/solo" })],
  });

  it("builds one tile per top-level entry with urgent-first workspace states", () => {
    const tiles = projectTiles(
      [memberA, solo, memberB],
      deps({
        agents: [
          baseAgent({
            id: "r",
            projectId: "a",
            workspacePath: "/a/run",
            paneId: "pr",
          }),
          // A running agent in a workspace that already needs you stays "needs-you".
          baseAgent({
            id: "r2",
            projectId: "a",
            workspacePath: "/a/needs",
            paneId: "pr2",
          }),
        ],
        paneAgentStatus: { pr: status("working"), pr2: status("thinking") },
        hosts: [host("local", "connected"), host("devbox", "error")],
        ports: [
          {
            port: 5173,
            processName: "vite",
            workspacePath: "/a/run",
            hostId: "local",
          },
          {
            port: 3000,
            processName: "node",
            workspacePath: "/b/open",
            hostId: "devbox",
          },
          {
            port: 80,
            processName: "other",
            workspacePath: "/b/open",
            hostId: "local",
          },
          {
            port: 22,
            processName: "none",
            workspacePath: null,
            hostId: "local",
          },
        ],
      }),
    );

    expect(tiles.map((t) => t.key)).toEqual(["g1", "solo"]);
    const [repo, soloTile] = tiles;
    expect(repo).toMatchObject({
      name: "Repo",
      color: "#f00",
      host: {
        label: "local + devbox",
        state: "partial",
        status: "Can't connect",
      },
      diff: { added: 15, removed: 3 },
      needsYou: 1,
      running: 2,
      openPrs: 3,
      port: { port: 3000, label: "node" },
    });
    expect(repo.workspaces.map((w) => [w.name, w.state])).toEqual([
      ["needs", "needs-you"],
      ["run", "running"],
      ["ready", "pr-ready"],
      ["open", "pr-open"],
      ["idle", "idle"],
    ]);
    expect(repo.workspaces[2]).toMatchObject({
      projectId: "b",
      path: "/b/ready",
    });

    expect(soloTile).toMatchObject({
      name: "Solo",
      host: { label: "local", state: "online" },
      diff: { added: 0, removed: 0 },
      needsYou: 0,
      running: 0,
      openPrs: 0,
    });
    expect(soloTile.host.status).toBeUndefined();
    expect(soloTile.port).toBeUndefined();
  });

  it("does not count snoozed items as needing you", () => {
    const [tile] = projectTiles(
      [
        baseProject({
          workspaces: [baseWorkspace({ pr: basePr({ hasConflicts: true }) })],
        }),
      ],
      deps({ snoozed: new Set([`pr:${prUrl(1)}`]) }),
    );
    expect(tile.needsYou).toBe(0);
    expect(tile.workspaces[0].state).toBe("pr-open");
  });
});
