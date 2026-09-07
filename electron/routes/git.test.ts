import { describe, it, expect } from "vitest";
import { gitRoutes } from "./git";
import type { ControlDeps, Route } from "./types";
import type { ProjectInfo } from "../persistence";
import type { GitBackend } from "../backend/types";

function route(method: Route["method"], path: string): Route {
  const found = gitRoutes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`No route ${method} ${path}`);
  return found;
}

const WORKSPACE_PATH = "/repo/ws-1";

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    name: "Test Project",
    path: "/repo",
    defaultBranch: "main",
    workspaces: [
      { path: WORKSPACE_PATH, branch: "feature", isMain: false, name: null },
    ],
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
    folders: [],
    sidebarOrder: [],
    ...overrides,
  };
}

/** A fake `GitBackend` recording every call it receives. */
function makeGit() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const git: GitBackend = {
    async exec() {
      return "";
    },
    async stage(cwd, files) {
      record("stage", [cwd, files]);
    },
    async unstage(cwd, files) {
      record("unstage", [cwd, files]);
    },
    async discard(cwd, files) {
      record("discard", [cwd, files]);
    },
    async commit(cwd, message, flags) {
      record("commit", [cwd, message, flags]);
    },
    async stash(cwd, files) {
      record("stash", [cwd, files]);
    },
    pushStream(cwd, opts, callbacks) {
      record("pushStream", [cwd, opts]);
      callbacks.onLine("Enumerating objects");
      callbacks.onLine("Writing objects");
      callbacks.onDone({ exitCode: 0, stderr: "" });
      return { cancel: () => record("pushStream:cancel", []) };
    },
    async getFullDiff(cwd, defaultBranch) {
      record("getFullDiff", [cwd, defaultBranch]);
      return "full diff";
    },
    async getLocalDiff(cwd) {
      record("getLocalDiff", [cwd]);
      return "local diff";
    },
    async getStagedFiles(cwd) {
      record("getStagedFiles", [cwd]);
      return ["a.txt"];
    },
    async worktreeList() {
      return [];
    },
    async worktreeAdd() {},
    async worktreeRemove() {},
  };
  return { git, calls };
}

function deps(
  git: GitBackend | null,
  projects: ProjectInfo[] = [makeProject()],
): ControlDeps {
  const projectManager = {
    async getProjects() {
      return projects;
    },
  };
  return {
    backend: git ? ({ git } as unknown as ControlDeps["backend"]) : null,
    projectManager: projectManager as unknown as ControlDeps["projectManager"],
  } as unknown as ControlDeps;
}

async function call(
  r: Route,
  d: ControlDeps,
  opts: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
) {
  const calls: Array<{ status: number; body: unknown }> = [];
  const url = new URL(`http://localhost${r.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(k, v);
  }
  await r.handler({
    deps: d,
    params: {},
    url,
    json: (status, body) => calls.push({ status, body }),
    readBody: async () => opts.body ?? {},
  });
  return calls[0];
}

describe("git routes", () => {
  it("forwards message and flags on commit", async () => {
    const { git, calls } = makeGit();
    const res = await call(route("POST", "/git/commit"), deps(git), {
      body: { cwd: WORKSPACE_PATH, message: "fix things", flags: ["--amend"] },
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(calls.commit).toEqual([[WORKSPACE_PATH, "fix things", ["--amend"]]]);
  });

  it("400s commit when 'message' is missing", async () => {
    const { git } = makeGit();
    const res = await call(route("POST", "/git/commit"), deps(git), {
      body: { cwd: WORKSPACE_PATH },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("message");
  });

  it("stages, unstages, discards, and stashes a non-empty files array", async () => {
    const { git, calls } = makeGit();
    const d = deps(git);
    for (const [action, key] of [
      ["stage", "stage"],
      ["unstage", "unstage"],
      ["discard", "discard"],
      ["stash", "stash"],
    ] as const) {
      const res = await call(route("POST", `/git/${action}`), d, {
        body: { cwd: WORKSPACE_PATH, files: ["a.txt", "b.txt"] },
      });
      expect(res).toEqual({ status: 200, body: { ok: true } });
      expect(calls[key]).toEqual([[WORKSPACE_PATH, ["a.txt", "b.txt"]]]);
    }
  });

  it("400s stage when 'files' is empty", async () => {
    const { git } = makeGit();
    const res = await call(route("POST", "/git/stage"), deps(git), {
      body: { cwd: WORKSPACE_PATH, files: [] },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("files");
  });

  it("collects push output lines and the exit code", async () => {
    const { git, calls } = makeGit();
    const res = await call(route("POST", "/git/push"), deps(git), {
      body: { cwd: WORKSPACE_PATH, remote: "origin", branch: "feature" },
    });
    expect(res).toEqual({
      status: 200,
      body: {
        exitCode: 0,
        lines: ["Enumerating objects", "Writing objects"],
        stderr: "",
      },
    });
    expect(calls.pushStream).toEqual([
      [
        WORKSPACE_PATH,
        { remote: "origin", branch: "feature", setUpstream: undefined },
      ],
    ]);
  });

  it("returns staged files", async () => {
    const { git } = makeGit();
    const res = await call(route("GET", "/git/staged-files"), deps(git), {
      query: { cwd: WORKSPACE_PATH },
    });
    expect(res).toEqual({ status: 200, body: ["a.txt"] });
  });

  it("defaults diff to local scope", async () => {
    const { git, calls } = makeGit();
    const res = await call(route("GET", "/git/diff"), deps(git), {
      query: { cwd: WORKSPACE_PATH },
    });
    expect(res).toEqual({ status: 200, body: "local diff" });
    expect(calls.getLocalDiff).toEqual([[WORKSPACE_PATH]]);
    expect(calls.getFullDiff).toBeUndefined();
  });

  it("uses the project's default branch for scope=full", async () => {
    const { git, calls } = makeGit();
    const res = await call(route("GET", "/git/diff"), deps(git), {
      query: { cwd: WORKSPACE_PATH, scope: "full" },
    });
    expect(res).toEqual({ status: 200, body: "full diff" });
    expect(calls.getFullDiff).toEqual([[WORKSPACE_PATH, "main"]]);
  });

  it("400s an unknown cwd", async () => {
    const { git } = makeGit();
    const res = await call(route("GET", "/git/staged-files"), deps(git), {
      query: { cwd: "/somewhere/else" },
    });
    expect(res.status).toBe(400);
  });

  it("503s every route when the git backend is unavailable", async () => {
    const res = await call(route("GET", "/git/staged-files"), deps(null), {
      query: { cwd: WORKSPACE_PATH },
    });
    expect(res.status).toBe(503);
  });

  it("503s when project management is unavailable", async () => {
    const { git } = makeGit();
    const d = {
      backend: { git } as unknown as ControlDeps["backend"],
      projectManager: null,
    } as unknown as ControlDeps;
    const res = await call(route("GET", "/git/staged-files"), d, {
      query: { cwd: WORKSPACE_PATH },
    });
    expect(res.status).toBe(503);
  });
});
