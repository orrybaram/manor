import { describe, it, expect, vi } from "vitest";
import {
  moveWorkspaceToHost,
  preflightWorkspaceMove,
  type WorkspaceHostMoveDeps,
  type WorkspaceMoveProgress,
  type WorkspaceRecreator,
} from "./workspace-host-move";
import type { ProjectInfo, WorkspaceInfo } from "./types";
import type { GitBackend } from "../backend/types";

const SRC = "/Users/me/.manor/worktrees/app/feat";
const TARGET_MAIN = "/home/u/code/app";
const TARGET_WS = "/home/u/.manor/worktrees/app/feat";

function project(
  id: string,
  hostId: string,
  path: string,
  workspaces: WorkspaceInfo[],
  extra: Partial<ProjectInfo> = {},
): ProjectInfo {
  return {
    id,
    name: "App",
    path,
    defaultBranch: "main",
    workspaces: [{ path, branch: "main", isMain: true, name: null }, ...workspaces],
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
    hostId,
    folders: [],
    sidebarOrder: [],
    group: null,
    ...extra,
  };
}

const GROUP = { id: "g1", name: "App", memberIds: ["src", "dst"], lastUsedHostId: null };

const sourceWs: WorkspaceInfo = {
  path: SRC,
  branch: "feat",
  isMain: false,
  name: "Feature",
  linkedIssues: [
    { id: "i1", identifier: "ENG-1", title: "One", url: "u1" },
    { id: "i2", identifier: "ENG-2", title: "Two", url: "u2" },
  ],
  folderId: "f-src",
};

/** What each host's git says, per cwd: the knobs a test turns. */
interface GitState {
  status: Record<string, string>;
  branch: Record<string, string | null>;
  origin: Set<string>;
  upstream: Record<string, string | null>;
  ahead: Record<string, number>;
  head: Record<string, string>;
  /** Shas the source's HEAD contains. */
  ancestors: Set<string>;
  /** Target cwds whose ff-only merge fails. */
  ffFails: Set<string>;
  pushExit: number;
}

function gitState(): GitState {
  return {
    status: {},
    branch: { [SRC]: "feat" },
    origin: new Set([SRC]),
    upstream: { [SRC]: "origin/feat" },
    ahead: { [SRC]: 2 },
    head: {},
    ancestors: new Set(),
    ffFails: new Set(),
    pushExit: 0,
  };
}

function fakeGit(state: GitState, log: string[], hostId: string): Pick<GitBackend, "exec" | "pushStream"> {
  return {
    exec: vi.fn(async (cwd: string, args: string[]) => {
      const cmd = args.join(" ");
      if (args[0] === "status") return state.status[cwd] ?? "";
      if (args[0] === "symbolic-ref") {
        const b = state.branch[cwd];
        if (!b) throw new Error("not a symbolic ref");
        return `${b}\n`;
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        if (state.origin.has(cwd)) return "https://github.com/org/app.git\n";
        throw new Error("No such remote 'origin'");
      }
      if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
        const u = state.upstream[cwd];
        if (!u) throw new Error("no upstream");
        return `${u}\n`;
      }
      if (args[0] === "rev-list") return `${state.ahead[cwd] ?? 0}\n`;
      if (args[0] === "rev-parse" && args[1] === "HEAD") return `${state.head[cwd] ?? "abc"}\n`;
      if (args[0] === "merge-base") {
        if (state.ancestors.has(args[2])) return "";
        throw new Error("not an ancestor");
      }
      if (args[0] === "fetch") {
        log.push(`${hostId}: git ${cmd} @ ${cwd}`);
        return "";
      }
      if (args[0] === "merge") {
        log.push(`${hostId}: git ${cmd} @ ${cwd}`);
        if (state.ffFails.has(cwd)) throw new Error("fatal: Not possible to fast-forward, aborting.");
        return "";
      }
      throw new Error(`unstubbed git: ${cmd}`);
    }),
    pushStream: vi.fn((cwd, opts, callbacks) => {
      log.push(`${hostId}: push ${opts.branch}${opts.setUpstream ? " -u" : ""} @ ${cwd}`);
      queueMicrotask(() =>
        callbacks.onDone({ exitCode: state.pushExit, stderr: state.pushExit ? "rejected" : "" }),
      );
      return { cancel: () => {} };
    }),
  };
}

interface Setup {
  /** Whether the target already has the group's member. */
  targetMember?: boolean;
  /** The target member already has a workspace on the branch. */
  targetHasBranch?: boolean;
  startScript?: string | null;
}

function world(opts: Setup = {}) {
  const log: string[] = [];
  const git = gitState();
  const grouped = opts.targetMember ?? true;
  const src = project("src", "local", "/Users/me/Code/app", [sourceWs], {
    group: grouped ? GROUP : null,
    folders: [{ id: "f-src", name: "Sprint", parentId: null }],
    worktreeStartScript: opts.startScript ?? null,
  });
  const dstWorkspaces: WorkspaceInfo[] = opts.targetHasBranch
    ? [{ path: TARGET_WS, branch: "feat", isMain: false, name: "Feature" }]
    : [];
  const dst = project("dst", "box", TARGET_MAIN, dstWorkspaces, {
    group: GROUP,
    folders: [{ id: "f-dst", name: "Sprint", parentId: null }],
    worktreeStartScript: opts.startScript ?? null,
  });
  const projects: ProjectInfo[] = grouped ? [src, dst] : [src];
  const gits = new Map<string, ReturnType<typeof fakeGit>>();

  const deps = {
    projects: vi.fn(async () => projects.map((p) => ({ ...p, workspaces: [...p.workspaces] }))),
    connect: vi.fn(async (hostId: string) => {
      log.push(`connect ${hostId}`);
    }),
    git: (hostId: string) => {
      if (!gits.has(hostId)) gits.set(hostId, fakeGit(git, log, hostId));
      return gits.get(hostId)!;
    },
    setUp: vi.fn(async (projectId: string, hostId: string) => {
      log.push(`setUp ${projectId} -> ${hostId}`);
      projects.push(dst);
      return { ok: true as const, project: dst };
    }),
    createWorkspace: vi.fn(async (target: ProjectInfo, req: { name: string; branch: string }) => {
      log.push(`create ${target.id} ${req.name} ${req.branch}`);
      dst.workspaces.push({ path: TARGET_WS, branch: req.branch, isMain: false, name: req.name });
      return {
        workspacePath: TARGET_WS,
        ...(target.worktreeStartScript ? { setup: { status: "exited" as const, exitCode: 0 } } : {}),
      };
    }),
    createFolder: vi.fn(async () => null),
    linkIssue: vi.fn(async (_t: ProjectInfo, path: string, issue: { id: string }) => {
      log.push(`link ${issue.id} @ ${path}`);
    }),
    removeWorkspace: vi.fn(async (p: ProjectInfo, path: string) => {
      log.push(`remove ${p.id} ${path}`);
    }),
  } satisfies WorkspaceHostMoveDeps;
  return { deps, git, log, events: [] as WorkspaceMoveProgress[] };
}

const REQ = { projectId: "src", path: SRC, targetHostId: "box" };

/** Whatever changes a host: what the log records beyond reads. */
function writes(log: string[]): string[] {
  return log.filter((l) => !l.startsWith("connect"));
}

describe("preflightWorkspaceMove", () => {
  it("reports the branch, origin, ahead count and the target's member", async () => {
    const { deps } = world();
    const pre = await preflightWorkspaceMove(deps, REQ);
    expect(pre).toMatchObject({
      sourceHostId: "local",
      branch: "feat",
      name: "Feature",
      isMain: false,
      hasOrigin: true,
      dirtyFiles: [],
      aheadCount: 2,
      needsPush: true,
      targetProjectId: "dst",
      targetHasProject: true,
      refusals: [],
    });
    expect(pre.existingTargetWorktree).toBeUndefined();
  });

  it("lists dirty files with their porcelain codes, renames whole", async () => {
    const { deps, git } = world();
    git.status[SRC] = " M src/a.ts\0?? new file.txt\0R  b.ts\0old b.ts\0";
    const pre = await preflightWorkspaceMove(deps, REQ);
    expect(pre.dirtyFiles).toEqual([
      { code: " M", path: "src/a.ts" },
      { code: "??", path: "new file.txt" },
      { code: "R ", path: "b.ts" },
    ]);
    expect(pre.refusals).toEqual([{ code: "dirty", files: pre.dirtyFiles }]);
  });

  it("refuses the main workspace, the same host and a detached HEAD", async () => {
    const { deps, git } = world();
    git.branch["/Users/me/Code/app"] = "main";
    git.origin.add("/Users/me/Code/app");
    const main = await preflightWorkspaceMove(deps, { ...REQ, path: "/Users/me/Code/app" });
    expect(main.refusals.map((r) => r.code)).toEqual(["main-workspace"]);

    const same = await preflightWorkspaceMove(deps, { ...REQ, targetHostId: "local" });
    expect(same.refusals.map((r) => r.code)).toEqual(["same-host"]);

    git.branch[SRC] = null;
    const detached = await preflightWorkspaceMove(deps, REQ);
    expect(detached.refusals.map((r) => r.code)).toEqual(["detached"]);
  });

  it("asks a remote source's own git", async () => {
    const { deps } = world();
    const gitFor = vi.spyOn(deps, "git");
    const projects = await deps.projects();
    projects[0].hostId = "other";
    deps.projects.mockResolvedValueOnce(projects);
    await preflightWorkspaceMove(deps, REQ);
    expect(gitFor).toHaveBeenCalledWith("other");
    expect(gitFor).not.toHaveBeenCalledWith("local");
  });

  it("finds the target's workspace on the branch, with whether it can fast-forward", async () => {
    const { deps, git } = world({ targetHasBranch: true });
    git.head[TARGET_WS] = "old";
    git.ancestors.add("old");
    const pre = await preflightWorkspaceMove(deps, REQ);
    expect(pre.existingTargetWorktree).toEqual({ path: TARGET_WS, dirty: false, canFastForward: true });
    expect(pre.refusals).toEqual([]);

    git.ancestors.clear();
    const diverged = await preflightWorkspaceMove(deps, REQ);
    expect(diverged.refusals.map((r) => r.code)).toEqual(["target-cannot-fast-forward"]);

    git.status[TARGET_WS] = " M x.ts\0";
    const dirty = await preflightWorkspaceMove(deps, REQ);
    expect(dirty.refusals).toEqual([{ code: "target-dirty", files: [{ code: " M", path: "x.ts" }] }]);
  });

  it("skips the push when origin already has every commit", async () => {
    const { deps, git } = world();
    git.ahead[SRC] = 0;
    expect((await preflightWorkspaceMove(deps, REQ)).needsPush).toBe(false);
    git.upstream[SRC] = null;
    expect((await preflightWorkspaceMove(deps, REQ)).needsPush).toBe(true);
  });
});

describe("moveWorkspaceToHost", () => {
  it("refuses a dirty workspace and changes nothing", async () => {
    const { deps, git, log, events } = world();
    git.status[SRC] = " M src/a.ts\0";
    const result = await moveWorkspaceToHost(deps, REQ, (e) => events.push(e));
    expect(result).toEqual({
      ok: false,
      refusals: [{ code: "dirty", files: [{ code: " M", path: "src/a.ts" }] }],
    });
    expect(writes(log)).toEqual([]);
    expect(events).toEqual([]);
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a workspace with no origin", async () => {
    const { deps, git, log } = world();
    git.origin.clear();
    const result = await moveWorkspaceToHost(deps, REQ);
    expect(result).toEqual({ ok: false, refusals: [{ code: "no-origin" }] });
    expect(writes(log)).toEqual([]);
  });

  it("refuses the main workspace", async () => {
    const { deps, git, log } = world();
    git.branch["/Users/me/Code/app"] = "main";
    git.origin.add("/Users/me/Code/app");
    const result = await moveWorkspaceToHost(deps, { ...REQ, path: "/Users/me/Code/app" });
    expect(result).toEqual({ ok: false, refusals: [{ code: "main-workspace" }] });
    expect(writes(log)).toEqual([]);
  });

  it("pushes, sets up, creates, runs the start script and removes the source, in order", async () => {
    const { deps, log, events } = world({ targetMember: false, startScript: "pnpm i" });
    const result = await moveWorkspaceToHost(deps, REQ, (e) => events.push(e));
    expect(result).toEqual({
      ok: true,
      targetProjectId: "dst",
      targetPath: TARGET_WS,
      targetWorkspaceKey: `box:${TARGET_WS}`,
      reused: false,
      sourceRemoved: true,
    });
    expect(writes(log)).toEqual([
      `local: push feat @ ${SRC}`,
      "setUp src -> box",
      "create dst Feature feat",
      `link i2 @ ${TARGET_WS}`,
      `box: git fetch origin feat @ ${TARGET_WS}`,
      `box: git merge --ff-only origin/feat @ ${TARGET_WS}`,
      `remove src ${SRC}`,
    ]);
    expect(deps.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: "dst" }), {
      name: "Feature",
      branch: "feat",
      linkedIssue: sourceWs.linkedIssues![0],
      folderId: "f-dst",
    });
    expect(events[0]).toEqual({
      type: "plan",
      steps: [
        { id: "push" },
        { id: "setUp" },
        { id: "create" },
        { id: "setupScript" },
        { id: "removeSource" },
      ],
    });
    const statuses = events.slice(1).map((e) => (e.type === "step" ? `${e.index}:${e.step}:${e.status}` : ""));
    expect(statuses).toEqual([
      "0:push:running",
      "0:push:done",
      "1:setUp:running",
      "1:setUp:done",
      "2:create:running",
      "2:create:done",
      "3:setupScript:running",
      "3:setupScript:done",
      "4:removeSource:running",
      "4:removeSource:done",
    ]);
  });

  it("sets the upstream on a branch that has none", async () => {
    const { deps, git, log } = world();
    git.upstream[SRC] = null;
    await moveWorkspaceToHost(deps, REQ);
    expect(log).toContain(`local: push feat -u @ ${SRC}`);
  });

  it("hands back a set up that needs input, and goes no further", async () => {
    const { deps, log } = world({ targetMember: false });
    const needsInput = {
      kind: "needsInput" as const,
      reason: "dir-taken" as const,
      repoUrl: "https://github.com/org/app.git",
      targetDir: "~/code/app",
      mode: "copy" as const,
      hostId: "box",
    };
    deps.setUp.mockResolvedValueOnce({ ok: false, needsInput } as never);
    const result = await moveWorkspaceToHost(deps, REQ);
    expect(result).toEqual({ ok: false, needsInput });
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
    expect(log).toContain(`local: push feat @ ${SRC}`);
  });

  it("reuses the target's workspace on the branch, fast-forwarding it", async () => {
    const { deps, git, log } = world({ targetHasBranch: true, startScript: "pnpm i" });
    git.head[TARGET_WS] = "old";
    git.ancestors.add("old");
    const events: WorkspaceMoveProgress[] = [];
    const result = await moveWorkspaceToHost(deps, REQ, (e) => events.push(e));
    expect(result).toMatchObject({ ok: true, targetPath: TARGET_WS, reused: true });
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(writes(log)).toEqual([
      `local: push feat @ ${SRC}`,
      `box: git fetch origin feat @ ${TARGET_WS}`,
      `box: git merge --ff-only origin/feat @ ${TARGET_WS}`,
      `remove src ${SRC}`,
    ]);
    // A reused workspace was set up already: no start script.
    expect(events[0]).toEqual({
      type: "plan",
      steps: [{ id: "push" }, { id: "create" }, { id: "removeSource" }],
    });
  });

  it("refuses a reused workspace that can't fast-forward, before pushing", async () => {
    const { deps, git, log } = world({ targetHasBranch: true });
    git.head[TARGET_WS] = "theirs";
    const result = await moveWorkspaceToHost(deps, REQ);
    expect(result).toEqual({ ok: false, refusals: [{ code: "target-cannot-fast-forward" }] });
    expect(writes(log)).toEqual([]);
  });

  it("fails the create step when the fast-forward itself fails, keeping the source", async () => {
    const { deps, git } = world({ targetHasBranch: true });
    git.head[TARGET_WS] = "old";
    git.ancestors.add("old");
    git.ffFails.add(TARGET_WS);
    const result = await moveWorkspaceToHost(deps, REQ);
    expect(result).toMatchObject({ ok: false, step: "create" });
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
  });

  it("leaves the source untouched when create fails after the push", async () => {
    const { deps, log, events } = world();
    deps.createWorkspace.mockRejectedValueOnce(new Error("fatal: invalid reference: feat"));
    const result = await moveWorkspaceToHost(deps, REQ, (e) => events.push(e));
    expect(result).toEqual({ ok: false, step: "create", error: "fatal: invalid reference: feat" });
    expect(log).toContain(`local: push feat @ ${SRC}`);
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toEqual({
      type: "step",
      index: 1,
      step: "create",
      status: "failed",
      error: "fatal: invalid reference: feat",
    });
  });

  it("fails at the push when git rejects it", async () => {
    const { deps, git } = world();
    git.pushExit = 1;
    const result = await moveWorkspaceToHost(deps, REQ);
    expect(result).toEqual({ ok: false, step: "push", error: "rejected" });
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
  });

  it("fails at the start script when it exits non-zero, keeping the source", async () => {
    const { deps } = world({ startScript: "exit 1" });
    deps.createWorkspace.mockResolvedValueOnce({
      workspacePath: TARGET_WS,
      setup: { status: "exited", exitCode: 1 },
    });
    const result = await moveWorkspaceToHost(deps, REQ);
    expect(result).toMatchObject({ ok: false, step: "setupScript" });
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the source with keepSource", async () => {
    const { deps, events } = world();
    const result = await moveWorkspaceToHost(deps, { ...REQ, keepSource: true }, (e) => events.push(e));
    expect(result).toMatchObject({ ok: true, sourceRemoved: false });
    expect(deps.removeWorkspace).not.toHaveBeenCalled();
    expect(events[0]).toEqual({ type: "plan", steps: [{ id: "push" }, { id: "create" }] });
  });

  it("runs the recreator's steps between create and removal, and a throw there keeps the source", async () => {
    const { deps, log, events } = world();
    const run = vi.fn(async (_move, begin: (i: number) => void) => {
      begin(0);
      log.push("restore");
      begin(1);
      log.push("agent claude");
    });
    const recreator: WorkspaceRecreator = {
      plan: async () => [{ id: "restore" }, { id: "agents", detail: "claude" }],
      run,
    };
    const result = await moveWorkspaceToHost({ ...deps, recreator }, REQ, (e) => events.push(e));
    expect(result).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: SRC,
        targetKey: `box:${TARGET_WS}`,
        targetPath: TARGET_WS,
        branch: "feat",
      }),
      expect.any(Function),
    );
    expect(writes(log).slice(-3)).toEqual(["restore", "agent claude", `remove src ${SRC}`]);
    expect(events[0]).toEqual({
      type: "plan",
      steps: [
        { id: "push" },
        { id: "create" },
        { id: "restore" },
        { id: "agents", detail: "claude" },
        { id: "removeSource" },
      ],
    });

    const again = world();
    const failing: WorkspaceRecreator = {
      plan: async () => [{ id: "restore" }],
      run: async (_move, begin) => {
        begin(0);
        throw new Error("layout refused");
      },
    };
    const failed = await moveWorkspaceToHost({ ...again.deps, recreator: failing }, REQ);
    expect(failed).toEqual({ ok: false, step: "restore", error: "layout refused" });
    expect(again.deps.removeWorkspace).not.toHaveBeenCalled();
  });
});
