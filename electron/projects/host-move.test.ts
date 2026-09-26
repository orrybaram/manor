import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import type { GitBackend, ShellBackend } from "../backend/types";
import { hostsOf } from "./test-fakes";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("ProjectManager.moveProjectToHost (ADR-179)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-movetohost-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const OLD_PATH = "/Users/me/Code/app";
  const REPO = "https://github.com/org/app.git";

  /** Seed `projects.json` with a local project carrying per-path settings. */
  function seed(extra: Array<Record<string, unknown>> = [], project: Record<string, unknown> = {}) {
    const state = {
      projects: [
        {
          id: "p1",
          name: "App",
          path: OLD_PATH,
          selectedWorkspaceIndex: 0,
          workspaces: [],
          defaultBranch: "main",
          defaultRunCommand: null,
          worktreePath: "/Users/me/.manor/worktrees/app",
          color: "blue",
          commands: [{ id: "c1", name: "dev", command: "pnpm dev" }],
          workspaceNames: { [OLD_PATH]: "main", "/Users/me/wt/feat": "feat" },
          workspaceOrder: ["folder-1", OLD_PATH, "/Users/me/wt/feat"],
          workspaceIssues: {
            [OLD_PATH]: [{ id: "i1", identifier: "ENG-1", title: "t", url: "u" }],
          },
          workspaceHidden: { [OLD_PATH]: true },
          workspaceFolders: [{ id: "folder-1", name: "F", parentId: null }],
          workspaceFolderIds: { [OLD_PATH]: "folder-1" },
          ...project,
        },
        ...extra,
      ],
      selectedProjectIndex: 0,
      hosts: { box: { spec: { kind: "ssh", target: "me@box" } } },
    };
    fs.writeFileSync(path.join(tmpDir, "projects.json"), JSON.stringify(state));
  }

  /** Remote git: `origin` for adopted dirs, `origin/HEAD` for branch detection, clone ok. */
  function fakeGit(remoteOrigins: Record<string, string> = {}, defaultBranch?: string) {
    const cloneCalls: Array<[string, string]> = [];
    const git = {
      exec: vi.fn(async (cwd: string, args: string[]) => {
        if (args[0] === "config" && args[2] === "remote.origin.url") {
          if (cwd in remoteOrigins) return remoteOrigins[cwd];
          throw new Error("no such remote");
        }
        if (args[0] === "symbolic-ref" && defaultBranch) return `origin/${defaultBranch}\n`;
        if (args[0] === "remote" && args[1] === "get-url") {
          if (cwd in remoteOrigins) return `${remoteOrigins[cwd]}\n`;
          throw new Error("no such remote");
        }
        throw new Error(`unstubbed git: ${args.join(" ")}`);
      }),
      worktreeList: vi.fn(async () => []),
      cloneStream: vi.fn(
        (repoUrl: string, targetDir: string, callbacks: {
          onDone: (r: { exitCode: number | null; stderr: string }) => void;
        }) => {
          cloneCalls.push([repoUrl, targetDir]);
          callbacks.onDone({ exitCode: 0, stderr: "" });
          return { cancel: vi.fn() };
        },
      ),
    };
    return { git: git as unknown as GitBackend, cloneCalls, cloneStream: git.cloneStream };
  }

  function fakeShell(home: string, dirs: Record<string, string[]> = {}): ShellBackend {
    return {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => home),
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "test" && args[0] === "-e") {
          if (args[1] in dirs) return "";
          throw new Error(`missing: ${args[1]}`);
        }
        if (cmd === "sh" && args[0] === "-c") {
          const match = /ls -A (.+)$/.exec(args[1]);
          const dir = match ? match[1].replace(/^'|'$/g, "") : "";
          return (dirs[dir] ?? []).join("\n");
        }
        throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
      }),
    } as unknown as ShellBackend;
  }

  function readPersisted(): Record<string, unknown> & { id: string } {
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
    return state.projects.find((p: { id: string }) => p.id === "p1");
  }

  it("clones onto the host and rekeys the main workspace's per-path settings", async () => {
    seed();
    const { git, cloneCalls } = fakeGit({}, "trunk");
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    const info = await mgr.moveProjectToHost("p1", {
      hostId: "box",
      repoUrl: REPO,
      remoteDir: "~/code/app",
    });

    const target = "/home/u/code/app";
    expect(cloneCalls).toEqual([[REPO, target]]);
    expect(info.hostId).toBe("box");
    expect(info.path).toBe(target);
    expect(info.defaultBranch).toBe("trunk");

    const p = readPersisted();
    expect(p.workspaceNames).toEqual({ [target]: "main", "/Users/me/wt/feat": "feat" });
    expect(p.workspaceOrder).toEqual(["folder-1", target, "/Users/me/wt/feat"]);
    expect(Object.keys(p.workspaceIssues as object)).toEqual([target]);
    expect(p.workspaceHidden).toEqual({ [target]: true });
    expect(p.workspaceFolderIds).toEqual({ [target]: "folder-1" });
  });

  it("keeps the project's id, name, colour and commands", async () => {
    seed();
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    const info = await mgr.moveProjectToHost("p1", {
      hostId: "box",
      repoUrl: REPO,
      remoteDir: "/srv/app",
    });

    expect(info.id).toBe("p1");
    expect(info.name).toBe("App");
    expect(info.color).toBe("blue");
    expect(info.commands).toEqual([{ id: "c1", name: "dev", command: "pnpm dev" }]);
    // Detection failed, so the old default branch stays.
    expect(info.defaultBranch).toBe("main");
    expect((await mgr.getProjects())).toHaveLength(1);
  });

  it("resets an absolute worktreePath", async () => {
    seed();
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    const info = await mgr.moveProjectToHost("p1", {
      hostId: "box",
      repoUrl: REPO,
      remoteDir: "/srv/app",
    });

    expect(info.worktreePath).toBeNull();
    expect(readPersisted().worktreePath).toBeNull();
  });

  it("keeps a ~-relative worktreePath", async () => {
    seed([], { worktreePath: "~/wt" });
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    const info = await mgr.moveProjectToHost("p1", {
      hostId: "box",
      repoUrl: REPO,
      remoteDir: "/srv/app",
    });

    expect(info.worktreePath).toBe("~/wt");
  });

  it("keeps a ~/trees root set in settings through a move, resolving it on the host (ADR-183)", async () => {
    seed([], { worktreePath: null });
    const { git } = fakeGit();
    const worktreeGit = { ...git, worktreeAdd: vi.fn(async () => {}) } as unknown as GitBackend;
    const mgr = new ProjectManager(hostsOf(worktreeGit, fakeShell("/home/u")), tmpDir);

    await mgr.updateProject("p1", { worktreePath: "~/trees" });
    const info = await mgr.moveProjectToHost("p1", {
      hostId: "box",
      repoUrl: REPO,
      remoteDir: "/srv/app",
    });

    expect(info.worktreePath).toBe("~/trees");
    expect(readPersisted().worktreePath).toBe("~/trees");
    const [created] = await mgr.createWorkspacesFromIssues("p1", [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);
    expect(created.worktreePath).toBe("/home/u/trees/feature");
  });

  it("adopts a directory that is already a clone of the repo without cloning", async () => {
    seed();
    const { git, cloneStream } = fakeGit({ "/srv/app": REPO });
    const shell = fakeShell("/home/u", { "/srv/app": ["package.json"] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);

    const info = await mgr.moveProjectToHost("p1", {
      hostId: "box",
      repoUrl: REPO,
      remoteDir: "/srv/app",
    });

    expect(cloneStream).not.toHaveBeenCalled();
    expect(info.path).toBe("/srv/app");
  });

  it("rejects a directory another project already owns on that host", async () => {
    seed([
      {
        id: "p2",
        name: "Other",
        path: "/srv/app",
        hostId: "box",
        selectedWorkspaceIndex: 0,
        workspaces: [],
        defaultBranch: "main",
        defaultRunCommand: null,
        worktreePath: null,
      },
    ]);
    const { git, cloneStream } = fakeGit({ "/srv/app": REPO });
    const shell = fakeShell("/home/u", { "/srv/app": ["package.json"] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);

    await expect(
      mgr.moveProjectToHost("p1", { hostId: "box", repoUrl: REPO, remoteDir: "/srv/app" }),
    ).rejects.toThrow(/already belongs to project "Other"/);
    expect(cloneStream).not.toHaveBeenCalled();
    expect(readPersisted().path).toBe(OLD_PATH);
  });

  it("rejects the local host", async () => {
    seed();
    const { git, cloneStream } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    await expect(
      mgr.moveProjectToHost("p1", { hostId: "local", repoUrl: REPO, remoteDir: "/srv/app" }),
    ).rejects.toThrow(/remote host/);
    expect(cloneStream).not.toHaveBeenCalled();
  });

  it("rejects an unknown project", async () => {
    seed();
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    await expect(
      mgr.moveProjectToHost("nope", { hostId: "box", repoUrl: REPO, remoteDir: "/srv/app" }),
    ).rejects.toThrow(/Unknown project/);
  });

  it("leaves the project untouched and keeps git's message when the clone fails", async () => {
    seed();
    const git = {
      exec: vi.fn(async () => {
        throw new Error("unstubbed");
      }),
      worktreeList: vi.fn(async () => []),
      cloneStream: vi.fn((_u: string, _d: string, cb: {
        onDone: (r: { exitCode: number | null; stderr: string }) => void;
      }) => {
        cb.onDone({
          exitCode: 128,
          stderr: "fatal: could not create work tree dir '/srv/app': Permission denied\n",
        });
        return { cancel: vi.fn() };
      }),
    } as unknown as GitBackend;
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    await expect(
      mgr.moveProjectToHost("p1", { hostId: "box", repoUrl: REPO, remoteDir: "/srv/app" }),
    ).rejects.toThrow("fatal: could not create work tree dir '/srv/app': Permission denied");
    const p = readPersisted();
    expect(p.path).toBe(OLD_PATH);
    expect(p.hostId).toBeUndefined();
  });

  it("switching back to local restores the path the project had there", async () => {
    const localPath = path.join(tmpDir, "checkout");
    fs.mkdirSync(localPath);
    seed([], { path: localPath, workspaceNames: { [localPath]: "main" } });
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    await mgr.moveProjectToHost("p1", { hostId: "box", repoUrl: REPO, remoteDir: "/srv/app" });
    expect(readPersisted().hostPaths).toEqual({ local: localPath });

    const info = await mgr.switchProjectHost("p1", "local");
    expect(info.path).toBe(localPath);
    expect(info.hostId).toBe("local");
    const p = readPersisted();
    expect(p.hostId).toBeUndefined();
    expect(p.workspaceNames).toEqual({ [localPath]: "main" });
    expect(p.hostPaths).toEqual({ local: localPath, box: "/srv/app" });

    // And back to the box again, without cloning.
    const shell = fakeShell("/home/u", { "/srv/app": ["package.json"] });
    const mgr2 = new ProjectManager(hostsOf(git, shell), tmpDir);
    const back = await mgr2.switchProjectHost("p1", "box");
    expect(back.path).toBe("/srv/app");
    expect(back.hostId).toBe("box");
  });

  it("switchProjectHost takes an explicit path over the remembered one", async () => {
    const chosen = path.join(tmpDir, "chosen");
    fs.mkdirSync(chosen);
    seed([], { path: "/srv/app", hostId: "box" });
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    const info = await mgr.switchProjectHost("p1", "local", chosen);
    expect(info.path).toBe(chosen);
    expect(readPersisted().hostPaths).toEqual({ box: "/srv/app" });
  });

  it("switchProjectHost refuses a path missing on the target and changes nothing", async () => {
    seed([], { path: "/srv/app", hostId: "box" });
    const { git } = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    await expect(
      mgr.switchProjectHost("p1", "local"),
    ).rejects.toThrow('Project path "/srv/app" does not exist on this Mac.');
    const p = readPersisted();
    expect(p.path).toBe("/srv/app");
    expect(p.hostId).toBe("box");
  });

  it("getOriginUrl reads origin through the project's host, null on failure", async () => {
    seed([
      {
        id: "p2",
        name: "Other",
        path: "/srv/other",
        hostId: "box",
        selectedWorkspaceIndex: 0,
        workspaces: [],
        defaultBranch: "main",
        defaultRunCommand: null,
        worktreePath: null,
      },
    ]);
    const { git } = fakeGit({ [OLD_PATH]: REPO });
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);

    expect(await mgr.getOriginUrl("p1")).toBe(REPO);
    expect(await mgr.getOriginUrl("p2")).toBeNull();
    expect(await mgr.getOriginUrl("nope")).toBeNull();
  });

  it("projectPathExists checks the project's own host", async () => {
    const localDir = path.join(tmpDir, "repo");
    fs.mkdirSync(localDir);
    seed(
      [
        {
          id: "p2",
          name: "Remote",
          path: "/srv/there",
          hostId: "box",
          selectedWorkspaceIndex: 0,
          workspaces: [],
          defaultBranch: "main",
          defaultRunCommand: null,
          worktreePath: null,
        },
        {
          id: "p3",
          name: "Gone",
          path: OLD_PATH,
          hostId: "box",
          selectedWorkspaceIndex: 0,
          workspaces: [],
          defaultBranch: "main",
          defaultRunCommand: null,
          worktreePath: null,
        },
      ],
      { path: localDir },
    );
    const { git } = fakeGit();
    const shell = fakeShell("/home/u", { "/srv/there": [] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);

    expect(await mgr.projectPathExists("p1")).toBe(true);
    expect(await mgr.projectPathExists("p2")).toBe(true);
    expect(await mgr.projectPathExists("p3")).toBe(false);
    expect(await mgr.projectPathExists("nope")).toBe(false);
  });
});
