/**
 * `createFireRun` over fakes: which project it fires for, the workspace it
 * makes or reuses, the agent command it picks, and what each failure records.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createFireRun, type FireRunDeps } from "../fire-run";
import type { ProjectInfo, WorkspaceInfo } from "../../projects/types";
import type { Automation } from "../../../src/lib/automations";

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    name: "manor",
    path: "/repo",
    defaultBranch: "main",
    workspaces: [{ path: "/repo", branch: "main", isMain: true, name: null }],
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
    ...overrides,
  };
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "Nightly triage",
    enabled: true,
    schedule: { cron: "0 9 * * *", timezone: "Europe/London" },
    projectId: "project-1",
    prompt: "Triage new issues",
    agentKind: "claude",
    workspace: { mode: "new" },
    missedGraceMinutes: 720,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastScheduledFor: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    ...overrides,
  };
}

// 09:00 in London on Oct 29 (GMT, after the clocks went back).
const SCHEDULED = "2026-10-29T09:00:00.000Z";
const ctx = { trigger: "schedule" as const, scheduledFor: SCHEDULED };

describe("createFireRun", () => {
  let projects: ProjectInfo[];
  let deps: {
    projectManager: {
      getProjects: ReturnType<typeof vi.fn>;
      createWorkspaceFolder: ReturnType<typeof vi.fn>;
      runBaseRef: ReturnType<typeof vi.fn>;
    };
    workspaceOps: { create: ReturnType<typeof vi.fn> };
    startAgent: ReturnType<typeof vi.fn>;
  };
  let fire: ReturnType<typeof createFireRun>;

  beforeEach(() => {
    projects = [project()];
    let folders = 0;
    deps = {
      projectManager: {
        getProjects: vi.fn(async () => projects),
        runBaseRef: vi.fn(async () => null),
        // Adds the folder to the project, as the manager does.
        createWorkspaceFolder: vi.fn((projectId: string, name: string, parentId: string | null) => {
          const folder = { id: `folder-${++folders}`, name, parentId };
          const p = projects.find((x) => x.id === projectId)!;
          p.folders = [...p.folders, folder];
          return folder;
        }),
      },
      workspaceOps: {
        create: vi.fn(async (req: { projectId: string; name: string; branch: string; folderId: string }) => {
          const path = `/worktrees/${req.branch}`;
          const ws: WorkspaceInfo = { path, branch: req.branch, isMain: false, name: req.name, folderId: req.folderId };
          const p = projects.find((x) => x.id === req.projectId)!;
          p.workspaces = [...p.workspaces, ws];
          return { project: p, workspacePath: path };
        }),
      },
      startAgent: vi.fn(async (workspacePath: string) => ({
        ok: true,
        data: { tabId: "tab-1", paneId: "pane-1", workspacePath },
      })),
    };
    fire = createFireRun(deps as unknown as FireRunDeps);
  });

  it("fails as project-missing when the project is not on this host", async () => {
    projects = [project({ hostId: "box-1" })];
    expect(await fire(automation(), ctx)).toEqual({
      outcome: "failed",
      reason: "project-missing",
      detail: "The project isn't set up on this host",
    });
    expect(deps.workspaceOps.create).not.toHaveBeenCalled();
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it("branches a new run workspace from the base the repo has, e.g. a local default branch with no origin", async () => {
    deps.projectManager.runBaseRef.mockResolvedValue("refs/heads/main");
    await fire(automation(), ctx);
    expect(deps.workspaceOps.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "refs/heads/main" }),
    );
  });

  it("fails as project-missing when the project is gone", async () => {
    projects = [];
    expect(await fire(automation(), ctx)).toMatchObject({ outcome: "failed", reason: "project-missing" });
  });

  it("makes a workspace in the Automations folder, named in the automation's timezone", async () => {
    const result = await fire(automation(), ctx);
    expect(deps.projectManager.createWorkspaceFolder).toHaveBeenCalledWith("project-1", "Automations", null);
    expect(deps.workspaceOps.create).toHaveBeenCalledWith({
      projectId: "project-1",
      name: "Nightly triage · Oct 29 09:00",
      branch: "auto/nightly-triage-20261029-0900",
      folderId: "folder-1",
      // A run isn't the user picking a host, and its agent waits for setup.
      recordLastUsedHost: false,
      awaitSetup: { timeoutMs: 10 * 60_000 },
    });
    expect(result).toEqual({
      outcome: "started",
      workspacePath: "/worktrees/auto/nightly-triage-20261029-0900",
      paneId: "pane-1",
      // What keep last N checks a rename against.
      workspaceName: "Nightly triage · Oct 29 09:00",
    });
  });

  it("trims to keep last N once a new-workspace run has started, without waiting", async () => {
    const prune = vi.fn(() => new Promise<void>(() => {}));
    fire = createFireRun({ ...deps, pruneRunWorkspaces: prune } as unknown as FireRunDeps);
    const keeping = automation({ workspace: { mode: "new", keepLast: 3 } });
    expect(await fire(keeping, ctx)).toMatchObject({ outcome: "started" });
    expect(prune).toHaveBeenCalledWith(keeping, "/worktrees/auto/nightly-triage-20261029-0900");
  });

  it("trims nothing when the run's agent fails to start, or it reuses a workspace", async () => {
    const prune = vi.fn(async () => {});
    fire = createFireRun({ ...deps, pruneRunWorkspaces: prune } as unknown as FireRunDeps);
    deps.startAgent.mockResolvedValueOnce({ ok: false, error: "no pty" });
    expect(await fire(automation(), ctx)).toMatchObject({ outcome: "failed" });
    projects[0]!.workspaces.push({ path: "/worktrees/inbox", branch: "inbox", isMain: false, name: "Inbox" });
    await fire(automation({ workspace: { mode: "reuse", workspacePath: "/worktrees/inbox" } }), ctx);
    expect(prune).not.toHaveBeenCalled();
  });

  it("reads the time in the automation's own zone", async () => {
    await fire(automation({ schedule: { cron: "0 9 * * *", timezone: "America/New_York" } }), {
      trigger: "schedule",
      scheduledFor: "2026-10-29T13:05:00.000Z",
    });
    expect(deps.workspaceOps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Nightly triage · Oct 29 09:05",
        branch: "auto/nightly-triage-20261029-0905",
      }),
    );
  });

  it("makes the folder once and reuses it on the next run", async () => {
    await fire(automation(), ctx);
    await fire(automation(), { trigger: "schedule", scheduledFor: "2026-10-30T09:00:00.000Z" });
    expect(deps.projectManager.createWorkspaceFolder).toHaveBeenCalledTimes(1);
    expect(deps.workspaceOps.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ folderId: "folder-1", branch: "auto/nightly-triage-20261030-0900" }),
    );
  });

  it("uses a nested folder's namesake only at the top level", async () => {
    projects = [project({ folders: [{ id: "nested", name: "Automations", parentId: "other" }] })];
    await fire(automation(), ctx);
    expect(deps.projectManager.createWorkspaceFolder).toHaveBeenCalledTimes(1);
  });

  it("numbers a second run in the same minute", async () => {
    await fire(automation(), ctx);
    await fire(automation(), ctx);
    expect(deps.workspaceOps.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Nightly triage · Oct 29 09:00 (2)",
        branch: "auto/nightly-triage-20261029-0900-2",
      }),
    );
  });

  it("fails as workspace-failed when the workspace is not made", async () => {
    deps.workspaceOps.create.mockResolvedValueOnce({ project: null, workspacePath: null });
    expect(await fire(automation(), ctx)).toMatchObject({ outcome: "failed", reason: "workspace-failed" });
    deps.workspaceOps.create.mockRejectedValueOnce(new Error("fatal: a branch named x already exists"));
    expect(await fire(automation(), ctx)).toEqual({
      outcome: "failed",
      reason: "workspace-failed",
      detail: "fatal: a branch named x already exists",
    });
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it("reuses a workspace of the project", async () => {
    projects = [
      project({
        workspaces: [
          { path: "/repo", branch: "main", isMain: true, name: null },
          { path: "/worktrees/inbox", branch: "inbox", isMain: false, name: "Inbox" },
        ],
      }),
    ];
    const result = await fire(automation({ workspace: { mode: "reuse", workspacePath: "/worktrees/inbox" } }), ctx);
    expect(deps.workspaceOps.create).not.toHaveBeenCalled();
    expect(deps.startAgent).toHaveBeenCalledWith("/worktrees/inbox", {
      prompt: "Triage new issues",
      agentCommand: "claude --dangerously-skip-permissions",
      // Seeded for the pane, so its Agent has a project with no renderer.
      paneContext: {
        projectId: "project-1",
        projectName: "manor",
        workspacePath: "/worktrees/inbox",
        agentCommand: "claude --dangerously-skip-permissions",
      },
    });
    expect(result).toEqual({ outcome: "started", workspacePath: "/worktrees/inbox", paneId: "pane-1" });
  });

  it("fails as workspace-failed when the reused workspace is gone", async () => {
    const result = await fire(automation({ workspace: { mode: "reuse", workspacePath: "/worktrees/gone" } }), ctx);
    expect(result).toEqual({
      outcome: "failed",
      reason: "workspace-failed",
      detail: "The workspace /worktrees/gone is no longer in manor",
    });
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it("uses the project's agent command when it starts the same kind", async () => {
    projects = [project({ agentCommand: "claude --model opus" })];
    await fire(automation(), ctx);
    expect(deps.startAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prompt: "Triage new issues", agentCommand: "claude --model opus" }),
    );
  });

  it("uses the kind's default command when the project's starts another kind", async () => {
    projects = [project({ agentCommand: "claude --model opus" })];
    await fire(automation({ agentKind: "codex" }), ctx);
    expect(deps.startAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prompt: "Triage new issues", agentCommand: "codex --yolo" }),
    );
  });

  it("starts the agent only after the setup script exits cleanly", async () => {
    const created = deps.workspaceOps.create.getMockImplementation() as (req: unknown) => Promise<object>;
    deps.workspaceOps.create.mockImplementationOnce(async (req) => ({
      ...(await created(req)),
      setup: { status: "exited", exitCode: 0 },
    }));
    expect(await fire(automation(), ctx)).toMatchObject({ outcome: "started" });
    expect(deps.startAgent).toHaveBeenCalledTimes(1);
  });

  it("fails as workspace-failed, starting no agent, when the setup script fails", async () => {
    const created = deps.workspaceOps.create.getMockImplementation() as (req: unknown) => Promise<object>;
    const path = "/worktrees/auto/nightly-triage-20261029-0900";
    for (const [setup, detail] of [
      [{ status: "exited", exitCode: 1 }, "Setup script exited with code 1"],
      [{ status: "failed", error: "no layout" }, "Setup script could not start: no layout"],
      [{ status: "timed-out" }, "Setup script was still running after 10 minutes"],
    ] as const) {
      projects = [project()];
      deps.workspaceOps.create.mockImplementationOnce(async (req) => ({ ...(await created(req)), setup }));
      expect(await fire(automation(), ctx)).toEqual({
        outcome: "failed",
        reason: "workspace-failed",
        detail,
        workspacePath: path,
      });
    }
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it("waits for setup as long as setupTimeoutMs says", async () => {
    fire = createFireRun({ ...(deps as unknown as FireRunDeps), setupTimeoutMs: 1_000 });
    await fire(automation(), ctx);
    expect(deps.workspaceOps.create).toHaveBeenCalledWith(
      expect.objectContaining({ awaitSetup: { timeoutMs: 1_000 } }),
    );
  });

  it("records a failed start with its error and the workspace it was for", async () => {
    deps.startAgent.mockResolvedValueOnce({ ok: false, status: 400, error: "The Dashboard can't host panes" });
    expect(await fire(automation(), ctx)).toEqual({
      outcome: "failed",
      reason: "error",
      detail: "The Dashboard can't host panes",
      workspacePath: "/worktrees/auto/nightly-triage-20261029-0900",
    });
  });
});
