import { describe, expect, it } from "vitest";
import {
  agentCommandFor,
  readAgentTranscript,
  workspaceRecreator,
  type HostLayout,
  type WorkspaceRecreatorDeps,
} from "./workspace-recreator";
import type { AgentInfo } from "../agent-persistence";
import { getConnector } from "../agent-connectors";
import type { SessionPreview } from "../sessions/preview";
import type { RecreateContext } from "./workspace-host-move";
import { applyLayoutCommand, type LayoutCommand } from "../../src/lib/layout/commands";
import type { LayoutEntry, PersistedPaneSession } from "../../src/lib/layout/protocol";
import {
  createSinglePanelLayout,
  layoutPaneIds,
  type Tab,
  type WorkspaceLayout,
} from "../../src/lib/layout/workspace-layout";
import { workspaceKey, type WorkspaceKey } from "../../src/lib/workspace-key";

const SRC = "/Users/me/.manor/worktrees/app/feat";
const DST = "/home/u/.manor/worktrees/app/feat";
const SOURCE_KEY = workspaceKey("local", SRC);
const TARGET_KEY = workspaceKey("box", DST);

const MOVE: RecreateContext = {
  sourceProjectId: "src",
  sourceHostId: "local",
  sourcePath: SRC,
  sourceKey: SOURCE_KEY,
  targetProjectId: "dst",
  targetHostId: "box",
  targetPath: DST,
  targetKey: TARGET_KEY,
  branch: "feat",
};

interface Queued {
  paneId: string;
  text: string;
  kind: string;
  opts?: unknown;
}

/** One host's layout store: the reducer over its entries, and its pending queue. */
function fakeHost(entries: Record<string, LayoutEntry> = {}) {
  const queued: Queued[] = [];
  const applied: LayoutCommand[] = [];
  const layout: HostLayout = {
    async read(key) {
      return entries[key] ?? null;
    },
    async apply(key, command) {
      applied.push(command);
      const entry =
        entries[key] ??
        (entries[key] = {
          version: 0,
          layout: createSinglePanelLayout("panel-minted", [], []),
          defaultViewport: { activePanelId: "panel-minted", selectedTabIds: {}, focusedPaneIds: {} },
          paneSessions: {},
          claims: [],
        });
      const before = layoutPaneIds(entry.layout);
      entry.layout = applyLayoutCommand({ layout: entry.layout, closedStack: [] }, command).layout;
      entry.version += 1;
      return { version: entry.version, addedPaneIds: [...layoutPaneIds(entry.layout)].filter((p) => !before.has(p)) };
    },
    async queue(paneId, text, kind, opts) {
      queued.push({ paneId, text, kind, ...(opts ? { opts } : {}) });
    },
  };
  return { layout, entries, queued, applied };
}

function entry(layout: WorkspaceLayout, paneSessions: Record<string, PersistedPaneSession> = {}): LayoutEntry {
  return {
    version: 1,
    layout,
    defaultViewport: { activePanelId: Object.keys(layout.panels)[0], selectedTabIds: {}, focusedPaneIds: {} },
    paneSessions,
    claims: [],
  };
}

const tab = (id: string, title: string, paneId: string): Tab => ({
  id,
  title,
  rootNode: { type: "leaf", paneId },
});

const AT_WORK = (kind: string) => ({ status: "responded", reason: "Stop hook", kind });

function sourceEntry(): LayoutEntry {
  return entry(
    {
      panelTree: {
        type: "split",
        direction: "horizontal",
        ratio: 0.4,
        first: { type: "leaf", panelId: "A" },
        second: { type: "leaf", panelId: "B" },
      },
      panels: {
        A: { id: "A", tabs: [tab("t1", "api", "p1"), tab("t2", "web", "p2")], pinnedTabIds: [] },
        B: { id: "B", tabs: [tab("t3", "logs", "p3")], pinnedTabIds: [] },
      },
    },
    {
      p1: { daemonSessionId: "p1", lastCwd: `${SRC}/api server`, lastTitle: null },
      p2: { daemonSessionId: "p2", lastCwd: SRC, lastTitle: null, lastAgentStatus: AT_WORK("claude") },
      p3: { daemonSessionId: "p3", lastCwd: SRC, lastTitle: null, lastAgentStatus: AT_WORK("codex") },
    },
  );
}

function hosts(
  source: ReturnType<typeof fakeHost>,
  target: ReturnType<typeof fakeHost>,
  extra: Partial<WorkspaceRecreatorDeps> = {},
): WorkspaceRecreatorDeps {
  return {
    layout: (hostId: string) => (hostId === "local" ? source.layout : target.layout),
    agents: () => [],
    transcript: async () => ({ turns: [], truncated: false }),
    agentCommand: async () => "claude --dangerously-skip-permissions",
    hostName: (hostId) => (hostId === "local" ? "this Mac" : "wsl-box"),
    ...extra,
  };
}

const planOf = (key: WorkspaceKey) => ({ projectId: "src", hostId: "local", path: SRC, key });

describe("workspaceRecreator: restore", () => {
  it("plans a restore for a source with tabs, and nothing for one without", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const recreator = workspaceRecreator(hosts(source, fakeHost()));
    expect(await recreator.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }]);

    const empty = fakeHost({ [SOURCE_KEY]: entry(createSinglePanelLayout("A", [], [])) });
    expect(await workspaceRecreator(hosts(empty, fakeHost())).plan(planOf(SOURCE_KEY))).toEqual([]);
    expect(await workspaceRecreator(hosts(fakeHost(), fakeHost())).plan(planOf(SOURCE_KEY))).toEqual([]);
  });

  it("rebuilds the layout in a target with none, binding the panel the server makes", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    const begun: number[] = [];
    await workspaceRecreator(hosts(source, target)).run(MOVE, (i) => begun.push(i));

    expect(begun).toEqual([0]);
    const built = target.entries[TARGET_KEY].layout;
    expect(built.panelTree).toMatchObject({ type: "split", direction: "horizontal", ratio: 0.4 });
    const panels = Object.values(built.panels).map((p) => p.tabs.map((t) => t.title));
    expect(panels).toEqual([["api", "web"], ["logs"]]);
    expect(built.panels["panel-minted"]).toBeDefined();
    // The source is read, never written.
    expect(source.applied).toEqual([]);
  });

  it("queues a cd to each moved cwd, quoted, before the tab exists", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    await workspaceRecreator(hosts(source, target)).run(MOVE, () => {});
    expect(target.queued).toEqual([
      { paneId: expect.any(String), text: `cd '${DST}/api server'`, kind: "shell" },
    ]);
    const api = Object.values(target.entries[TARGET_KEY].layout.panels)
      .flatMap((p) => p.tabs)
      .find((t) => t.title === "api")!;
    expect(api.rootNode).toMatchObject({ paneId: target.queued[0].paneId });
  });

  it("fails the step when the target refuses a command", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    target.layout.apply = async () => ({ error: "Workspace was removed" });
    await expect(workspaceRecreator(hosts(source, target)).run(MOVE, () => {})).rejects.toThrow(
      /Workspace was removed/,
    );
  });
});

function agent(paneId: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: `agent-${paneId}`,
    agentSessionId: `session-${paneId}`,
    name: "Fix the login redirect",
    status: "active",
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T11:00:00.000Z",
    completedAt: null,
    activatedAt: null,
    projectId: "src",
    projectName: "App",
    hostId: "local",
    workspacePath: SRC,
    cwd: SRC,
    agentKind: "claude",
    agentCommand: "claude --resume session-old",
    paneId,
    lastAgentStatus: null,
    resumedAt: null,
    transcriptPath: `/Users/me/.claude/projects/x/session-${paneId}.jsonl`,
    ...extra,
  };
}

const PREVIEW: SessionPreview = {
  truncated: true,
  turns: [
    { role: "user", text: "Fix the login redirect loop", first: true },
    { role: "assistant", text: "Looking at the middleware." },
    { role: "tool", name: "Read", summary: "src/middleware.ts" },
    { role: "user", text: "Also keep the next= param" },
  ],
};

describe("workspaceRecreator: agents", () => {
  it("plans an agents step naming the kind, or how many", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const one = workspaceRecreator(hosts(source, fakeHost(), { agents: () => [agent("p2")] }));
    expect(await one.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }, { id: "agents", detail: "claude" }]);

    const two = workspaceRecreator(
      hosts(source, fakeHost(), {
        agents: () => [agent("p2"), agent("p3", { agentKind: "codex" }), agent("elsewhere")],
      }),
    );
    expect(await two.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }, { id: "agents", detail: "2 agents" }]);

    const ended = workspaceRecreator(
      hosts(source, fakeHost(), { agents: () => [agent("p2", { status: "completed" })] }),
    );
    expect(await ended.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }]);
  });

  it("starts a fresh agent of the same kind with the handoff, in the old pane's place", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    const asked: string[] = [];
    const recreator = workspaceRecreator(
      hosts(source, target, {
        agents: () => [agent("p2")],
        transcript: async (hostId, a) => {
          asked.push(`${hostId}:${a.agentSessionId}`);
          return PREVIEW;
        },
      }),
    );
    await recreator.plan(planOf(SOURCE_KEY));
    const begun: number[] = [];
    // The agent's pane must not exist until its launch line is queued.
    const queuedFirst: boolean[] = [];
    const apply = target.layout.apply;
    target.layout.apply = async (key, command) => {
      if (command.type === "new-tab" && command.tab.title === "web") {
        queuedFirst.push(target.queued.some((q) => q.kind === "agent-startup"));
      }
      return apply(key, command);
    };
    await recreator.run(MOVE, (i) => begun.push(i));

    expect(begun).toEqual([0, 1]);
    expect(asked).toEqual(["local:session-p2"]);
    expect(queuedFirst).toEqual([true]);

    const built = target.entries[TARGET_KEY].layout;
    expect(Object.values(built.panels).map((p) => p.tabs.map((t) => t.title))).toEqual([["api", "web"], ["logs"]]);
    const web = built.panels["panel-minted"].tabs[1];
    const launch = target.queued.find((q) => q.kind === "agent-startup")!;
    expect(web.rootNode).toMatchObject({ paneId: launch.paneId });
    expect(launch.text).toBe("claude --dangerously-skip-permissions");
    const opts = launch.opts as { prompt: string; agentKind: string };
    expect(opts.agentKind).toBe("claude");
    expect(opts.prompt).toContain("Continuing work moved from this Mac to wsl-box");
    expect(opts.prompt).toContain("Fix the login redirect");
    expect(opts.prompt).toContain("Fix the login redirect loop");
    expect(opts.prompt).toContain("Also keep the next= param");
    expect(opts.prompt).not.toContain("src/middleware.ts");
    expect(opts.prompt).toContain("branch feat");
  });

  it("starts the agent with the title and branch note when its transcript can't be read", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    const recreator = workspaceRecreator(
      hosts(source, target, {
        agents: () => [agent("p2")],
        transcript: async () => {
          throw new Error("wsl-box is offline");
        },
      }),
    );
    await recreator.plan(planOf(SOURCE_KEY));
    await recreator.run(MOVE, () => {});
    const launch = target.queued.find((q) => q.kind === "agent-startup")!;
    const { prompt } = launch.opts as { prompt: string };
    expect(prompt).toContain("Fix the login redirect");
    expect(prompt).toContain("branch feat");
    expect(prompt).not.toContain("The last");
    const titles = Object.values(target.entries[TARGET_KEY].layout.panels).map((p) => p.tabs.map((t) => t.title));
    expect(titles).toEqual([["api", "web"], ["logs"]]);
  });

  it("brings an agent that started after the plan back as a shell", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    let agents: AgentInfo[] = [];
    const recreator = workspaceRecreator(hosts(source, target, { agents: () => agents }));
    expect(await recreator.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }]);
    agents = [agent("p2")];
    const begun: number[] = [];
    await recreator.run(MOVE, (i) => begun.push(i));
    expect(begun).toEqual([0]);
    expect(target.queued.filter((q) => q.kind === "agent-startup")).toEqual([]);
  });
});

describe("workspaceRecreator: again, after a failure", () => {
  it("adds no tab and starts no agent a second time when the move is retried", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    const recreator = workspaceRecreator(hosts(source, target, { agents: () => [agent("p2")] }));
    const tabs = () => Object.values(target.entries[TARGET_KEY].layout.panels).map((p) => p.tabs.map((t) => t.title));

    await recreator.plan(planOf(SOURCE_KEY));
    await recreator.run(MOVE, () => {});
    // Then the move failed at removeSource; Retry plans and runs it again.
    await recreator.plan(planOf(SOURCE_KEY));
    await recreator.run(MOVE, () => {});
    expect(tabs()).toEqual([["api", "web"], ["logs"]]);
    expect(target.queued.filter((q) => q.kind === "agent-startup")).toHaveLength(1);
  });

  it("starts the agent on a retry when the first try failed before its tab landed", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    const recreator = workspaceRecreator(hosts(source, target, { agents: () => [agent("p2")] }));
    const apply = target.layout.apply;
    let refuse = true;
    target.layout.apply = async (key, command) =>
      refuse && command.type === "new-tab" && command.tab.title === "web"
        ? { error: "host went away" }
        : apply(key, command);

    await recreator.plan(planOf(SOURCE_KEY));
    await expect(recreator.run(MOVE, () => {})).rejects.toThrow(/host went away/);
    refuse = false;
    await recreator.plan(planOf(SOURCE_KEY));
    await recreator.run(MOVE, () => {});

    const panels = Object.values(target.entries[TARGET_KEY].layout.panels);
    expect(panels.map((p) => p.tabs.map((t) => t.title))).toEqual([["api", "web"], ["logs"]]);
    const launches = target.queued.filter((q) => q.kind === "agent-startup");
    expect(launches).toHaveLength(2);
    expect(panels[0].tabs[1].rootNode).toMatchObject({ paneId: launches[1].paneId });
  });
});

describe("workspaceRecreator: moved again onto the same host", () => {
  const titles = (target: ReturnType<typeof fakeHost>) =>
    Object.values(target.entries[TARGET_KEY].layout.panels).map((p) => p.tabs.map((t) => t.title));

  for (const [name, memory] of [
    ["in the same session, by a new recreator", () => new Map()],
    ["after a restart, with nothing remembered", null],
  ] as const) {
    it(`adds no tab a second time: ${name}`, async () => {
      const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
      const target = fakeHost();
      const shared = memory ? memory() : undefined;
      const recreator = () => workspaceRecreator(hosts(source, target, { agents: () => [agent("p2")] }), shared);

      const first = recreator();
      await first.plan(planOf(SOURCE_KEY));
      await first.run(MOVE, () => {});
      // Kept; then moved again onto the workspace the first move made.
      const second = recreator();
      await second.plan(planOf(SOURCE_KEY));
      await second.run(MOVE, () => {});

      expect(titles(target)).toEqual([["api", "web"], ["logs"]]);
      expect(target.queued.filter((q) => q.kind === "agent-startup")).toHaveLength(1);
    });

    it(`adds only the tab the source gained since: ${name}`, async () => {
      const entry = sourceEntry();
      const source = fakeHost({ [SOURCE_KEY]: entry });
      const target = fakeHost();
      const shared = memory ? memory() : undefined;
      const recreator = () => workspaceRecreator(hosts(source, target), shared);

      const first = recreator();
      await first.plan(planOf(SOURCE_KEY));
      await first.run(MOVE, () => {});
      entry.layout.panels.B.tabs.push(tab("t4", "tests", "p4"));
      const second = recreator();
      await second.plan(planOf(SOURCE_KEY));
      await second.run(MOVE, () => {});

      expect(titles(target)).toEqual([["api", "web"], ["logs", "tests"]]);
    });
  }
});

describe("agents whose CLI is gone", () => {
  it("comes back as a shell when its pane's last status says the agent ended", async () => {
    const entry = sourceEntry();
    entry.paneSessions.p2 = {
      ...entry.paneSessions.p2,
      lastAgentStatus: { status: "idle", reason: "agent process exited", kind: null },
    };
    const source = fakeHost({ [SOURCE_KEY]: entry });
    const recreator = workspaceRecreator(hosts(source, fakeHost(), { agents: () => [agent("p2")] }));
    expect(await recreator.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }]);
  });
});

describe("readAgentTranscript", () => {
  const summary = (kind: string, sessionId: string, path: string) =>
    ({ kind, sessionId, path }) as unknown as import("../sessions/types").SessionSummary;

  it("reads the transcript the hooks named", async () => {
    const asked: unknown[] = [];
    await readAgentTranscript(
      {
        list: async () => {
          throw new Error("not asked");
        },
        preview: async (_h, ref) => (asked.push(ref), PREVIEW),
      },
      "local",
      agent("p2"),
    );
    expect(asked).toEqual([
      { hostId: "local", kind: "claude", sessionId: "session-p2", path: "/Users/me/.claude/projects/x/session-p2.jsonl" },
    ]);
  });

  it("finds a transcript the hooks never named in the host's Session list, by kind and id", async () => {
    const asked: unknown[] = [];
    const preview = await readAgentTranscript(
      {
        list: async (hostId) => {
          expect(hostId).toBe("box");
          return [
            summary("claude", "session-p3", "/wrong.jsonl"),
            summary("codex", "session-p3", "/home/u/.codex/sessions/r.jsonl"),
          ];
        },
        preview: async (_h, ref) => (asked.push(ref.path), PREVIEW),
      },
      "box",
      agent("p3", { agentKind: "codex", transcriptPath: null }),
    );
    expect(asked).toEqual(["/home/u/.codex/sessions/r.jsonl"]);
    expect(preview).toBe(PREVIEW);
  });

  it("throws when the list has no such Session", async () => {
    await expect(
      readAgentTranscript(
        { list: async () => [], preview: async () => PREVIEW },
        "local",
        agent("p3", { transcriptPath: null }),
      ),
    ).rejects.toThrow(/not in its host's list/);
  });
});

describe("agentCommandFor", () => {
  it("takes the first candidate of the kind, without its session arguments", () => {
    expect(agentCommandFor("claude", ["codex", "claude --resume abc"])).toBe("claude");
    expect(agentCommandFor("codex", ["claude", null])).toBe(getConnector("codex").defaultCommand);
  });
});
