/**
 * Keep last N over fakes: which of an automation's run workspaces go, and
 * every reason one stays.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createRunWorkspacePruner, pruneRunWorkspaces, type RunWorkspaceRetentionDeps } from "../retention";
import type { AgentInfo } from "../../agent-persistence";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { ProjectInfo, WorkspaceInfo } from "../../projects/types";
import type { Automation, AutomationRun } from "../../../src/lib/automations";

const FOLDER = { id: "folder-auto", name: "Automations", parentId: null };

function automation(keepLast: number | null): Automation {
  return {
    id: "auto-1",
    name: "Nightly",
    enabled: true,
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    projectId: "project-1",
    prompt: "Go",
    agentKind: "claude",
    workspace: keepLast === null ? { mode: "new" } : { mode: "new", keepLast },
    missedGraceMinutes: 720,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastScheduledFor: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
  };
}

/** Run workspace `n` (day `n`): `/wt/n`, named `Nightly n`. */
function runWs(n: number, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { path: `/wt/${n}`, branch: `auto/nightly-${n}`, isMain: false, name: `Nightly ${n}`, folderId: FOLDER.id, ...overrides };
}

function run(n: number, overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: `run-${n}`,
    automationId: "auto-1",
    scheduledFor: `2026-10-${String(n).padStart(2, "0")}T09:00:00.000Z`,
    firedAt: `2026-10-${String(n).padStart(2, "0")}T09:00:00.000Z`,
    trigger: "schedule",
    outcome: "started",
    workspacePath: `/wt/${n}`,
    workspaceName: `Nightly ${n}`,
    paneId: `pane-${n}`,
    ...overrides,
  };
}

describe("pruneRunWorkspaces", () => {
  let workspaces: WorkspaceInfo[];
  let runs: AutomationRun[];
  let agents: Partial<AgentInfo>[];
  let risks: Map<string, string>;
  /** workspace path → the pane ids its layout holds. */
  let layouts: Map<string, string[]>;
  let unseenResponded: Set<string>;
  let log: ReturnType<typeof vi.fn<(message: string) => void>>;
  let remove: ReturnType<typeof vi.fn<(projectId: string, worktreePath: string) => Promise<void>>>;
  let deps: RunWorkspaceRetentionDeps;

  /** Runs 1..n, newest first, each with its workspace; run n is the one that just started. */
  function seed(n: number): void {
    workspaces = [{ path: "/repo", branch: "main", isMain: true, name: null }];
    runs = [];
    for (let i = 1; i <= n; i++) {
      workspaces.push(runWs(i));
      runs.unshift(run(i));
    }
  }

  const removed = (): string[] => remove.mock.calls.map((c) => c[1]).sort();

  beforeEach(() => {
    seed(5);
    agents = [];
    risks = new Map();
    layouts = new Map();
    unseenResponded = new Set();
    log = vi.fn<(message: string) => void>();
    remove = vi.fn(async (_projectId: string, _worktreePath: string) => {});
    deps = {
      runs: () => runs,
      projectManager: {
        getProjects: async () => [
          { id: "project-1", workspaces, folders: [FOLDER] } as unknown as ProjectInfo,
        ],
        worktreeRemovalRisk: async (_projectId: string, p: string) => risks.get(p) ?? null,
      },
      workspaceOps: { remove },
      agentManager: {
        getAllAgents: () => agents as AgentInfo[],
        getAgentById: (id: string) => (agents.find((a) => a.id === id) as AgentInfo | undefined) ?? null,
      },
      agentStatus: { getPaneState: () => undefined },
      layout: {
        get: (key: string) => {
          const panes = layouts.get(key);
          if (!panes) return null;
          const tabs = panes.map((paneId) => ({ id: `tab-${paneId}`, rootNode: { type: "leaf", paneId } }));
          return { layout: { panels: { p: { id: "p", tabs } } } } as unknown as LayoutEntry;
        },
      },
      unseen: { responded: unseenResponded, requiresInput: new Set() },
      log,
    };
  });

  it("keeps the newest N, the current run's among them, and removes the rest", async () => {
    await pruneRunWorkspaces(deps, automation(2), "/wt/5");
    expect(removed()).toEqual(["/wt/1", "/wt/2", "/wt/3"]);
    // The sidebar's remove, which keeps the branch.
    expect(remove).toHaveBeenCalledWith("project-1", "/wt/1");
  });

  it("does nothing without keepLast", async () => {
    await pruneRunWorkspaces(deps, automation(null), "/wt/5");
    expect(remove).not.toHaveBeenCalled();
  });

  it("never removes the current run's workspace, even with keep last 1", async () => {
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/1", "/wt/2", "/wt/3", "/wt/4"]);
  });

  it("never removes a dirty workspace, and it takes no slot", async () => {
    risks.set("/wt/4", "Uncommitted changes in workspace");
    risks.set("/wt/1", "1 commit on neither main nor a remote");
    await pruneRunWorkspaces(deps, automation(2), "/wt/5");
    // 4 is kept for safety, so 3 fills the second slot.
    expect(removed()).toEqual(["/wt/2"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("Nightly 4 (Uncommitted changes in workspace)");
  });

  it("keeps a workspace whose risk check throws", async () => {
    deps.projectManager.worktreeRemovalRisk = async (_id, p) => {
      if (p === "/wt/1") throw new Error("git gone");
      return null;
    };
    await pruneRunWorkspaces(deps, automation(2), "/wt/5");
    expect(removed()).toEqual(["/wt/2", "/wt/3"]);
  });

  it("never removes a renamed, moved or hidden workspace", async () => {
    workspaces[1] = runWs(1, { name: "Keep me" });
    workspaces[2] = runWs(2, { folderId: null });
    workspaces[3] = runWs(3, { hidden: true });
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/4"]);
  });

  it("never removes a workspace with an active agent", async () => {
    agents = [
      { id: "a1", status: "active", workspacePath: "/wt/1" },
      { id: "a2", status: "completed", workspacePath: "/wt/2" },
    ];
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/2", "/wt/3", "/wt/4"]);
  });

  it("ignores workspaces no started run of this automation recorded", async () => {
    // A same-named workspace no run made, a failed run's, a run from before
    // runs recorded their name, and a run whose workspace is already gone.
    workspaces.push(runWs(9));
    runs.push(run(10, { outcome: "failed", reason: "error" }));
    workspaces.push(runWs(10));
    runs.push(run(11, { workspaceName: undefined }));
    workspaces.push(runWs(11));
    runs.push(run(12));
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/1", "/wt/2", "/wt/3", "/wt/4"]);
  });

  it("counts a workspace two runs share once", async () => {
    runs.splice(1, 0, run(4, { id: "run-4b" }));
    await pruneRunWorkspaces(deps, automation(2), "/wt/5");
    expect(removed()).toEqual(["/wt/1", "/wt/2", "/wt/3"]);
  });

  it("keeps going when one removal fails, and never throws", async () => {
    remove.mockImplementation(async (_id, p) => {
      if (p === "/wt/2") throw new Error("Failed to remove worktree: busy");
    });
    await expect(pruneRunWorkspaces(deps, automation(1), "/wt/5")).resolves.toBeUndefined();
    expect(removed()).toEqual(["/wt/1", "/wt/2", "/wt/3", "/wt/4"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("removing /wt/2 failed: Failed to remove worktree: busy"));
  });

  it("logs, never throws, when the projects can't be read", async () => {
    deps.projectManager.getProjects = async () => {
      throw new Error("store gone");
    };
    await expect(pruneRunWorkspaces(deps, automation(1), "/wt/5")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("store gone"));
  });

  it("keeps a workspace the user opened a pane in, but not one holding only the run's own", async () => {
    layouts.set("/wt/1", ["pane-1", "pane-user"]);
    layouts.set("/wt/2", ["pane-2"]);
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/2", "/wt/3", "/wt/4"]);
    expect(log.mock.calls[0]![0]).toContain("Nightly 1 (a pane was opened in it)");
  });

  it("keeps a workspace whose run's agent, found by its pane, is active", async () => {
    agents = [{ id: "a1", status: "active", paneId: "pane-1", createdAt: "2026-10-01T09:00:05.000Z" }];
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/2", "/wt/3", "/wt/4"]);
  });

  it("keeps a workspace whose run's agent has a reply nobody has read", async () => {
    agents = [{ id: "a2", status: "completed", paneId: "pane-2", createdAt: "2026-10-02T09:00:05.000Z" }];
    unseenResponded.add("a2");
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/1", "/wt/3", "/wt/4"]);
    expect(log.mock.calls[0]![0]).toContain("Nightly 2 (its agent's reply is unread)");
  });

  it("matches an active agent's workspace however its path is written", async () => {
    agents = [
      { id: "a1", status: "active", workspacePath: "/wt/1/" },
      { id: "a3", status: "active", workspacePath: "box:/wt/3" },
    ];
    runs[1] = run(4, { workspacePath: "/wt/4/" });
    await pruneRunWorkspaces(deps, automation(1), "/wt/5/");
    expect(removed()).toEqual(["/wt/2", "/wt/4"]);
  });

  it("tells the risk check when the run fired", async () => {
    const risk = vi.fn(async () => null);
    deps.projectManager.worktreeRemovalRisk = risk;
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(risk).toHaveBeenCalledWith("project-1", "/wt/1", { createdAt: Date.parse("2026-10-01T09:00:00.000Z") });
  });

  it("asks again just before each removal", async () => {
    // Newest first: 2 is clean when weighed, and opened by its turn.
    remove.mockImplementation(async (_id, p) => {
      if (p === "/wt/4") layouts.set("/wt/2", ["pane-user"]);
    });
    await pruneRunWorkspaces(deps, automation(1), "/wt/5");
    expect(removed()).toEqual(["/wt/1", "/wt/3", "/wt/4"]);
  });

  it("runs one automation's prunes one at a time", async () => {
    const prune = createRunWorkspacePruner(deps);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    remove.mockImplementation(async (_id, p) => {
      if (p === "/wt/4") await gate;
      // What a removal does: the workspace leaves the project.
      workspaces = workspaces.filter((w) => w.path !== p);
    });
    const first = prune(automation(1), "/wt/5");
    const second = prune(automation(1), "/wt/5");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    // The second waits for the first: nothing is weighed twice at once.
    await new Promise((r) => setTimeout(r, 10));
    expect(remove).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    // The second found nothing left to remove.
    expect(remove.mock.calls.map((c) => c[1])).toEqual(["/wt/4", "/wt/3", "/wt/2", "/wt/1"]);
  });
});
