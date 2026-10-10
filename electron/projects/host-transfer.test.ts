import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import { LOCAL_HOST_ID, type GitBackend, type ShellBackend } from "../backend/types";
import { hostsOf } from "./test-fakes";
import type { ProjectHostResolver } from "./types";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("ProjectManager.planTransfer / transferProject (ADR-213)", () => {
  let tmpDir: string;
  /** This machine's home in these tests: a fresh directory, so nothing real is touched. */
  let localHome: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-transfer-test-${crypto.randomUUID()}`);
    localHome = path.join(tmpDir, "home");
    fs.mkdirSync(localHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const REPO = "https://github.com/org/app.git";
  const OTHER_REPO = "https://github.com/org/other.git";
  const REMOTE_HOME = "/home/u";

  function project(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: "App",
      path: "/Users/me/Code/app",
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...extra,
    };
  }

  function seed(projects: Array<Record<string, unknown>>, groups?: unknown[]) {
    const state = {
      projects,
      selectedProjectIndex: 0,
      hosts: { box: { spec: { kind: "ssh", target: "me@box" } } },
      ...(groups ? { groups } : {}),
    };
    fs.writeFileSync(path.join(tmpDir, "projects.json"), JSON.stringify(state));
  }

  function readState(): {
    projects: Array<Record<string, unknown> & { id: string }>;
    groups?: Array<Record<string, unknown> & { memberIds: string[] }>;
  } {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
  }

  /** Git answering `origin` per checkout path, and a clone that always succeeds. */
  function fakeGit(origins: Record<string, string> = {}) {
    const cloneCalls: Array<[string, string]> = [];
    const git = {
      exec: vi.fn(async (cwd: string, args: string[]) => {
        if (args[0] === "config" && args[2] === "remote.origin.url") {
          if (cwd in origins) return origins[cwd];
          throw new Error("no such remote");
        }
        if (args[0] === "remote" && args[1] === "get-url") {
          if (cwd in origins) return `${origins[cwd]}\n`;
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
    return { git: git as unknown as GitBackend, cloneCalls };
  }

  /** The remote host's shell: `dirs` exist, with the listed entries. */
  function fakeShell(dirs: Record<string, string[]> = {}): ShellBackend {
    return {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => REMOTE_HOME),
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
        if (cmd === "cat") throw new Error("no such file");
        throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
      }),
    } as unknown as ShellBackend;
  }

  /** `hostsOf`, with this machine's home pinned to `home`. */
  function hosts(git: GitBackend, shell: ShellBackend, home = localHome): ProjectHostResolver {
    const base = hostsOf(git, shell);
    return (hostId) => {
      const h = base(hostId);
      if (hostId !== LOCAL_HOST_ID) return h;
      return { git: h.git, shell: h.shell, facts: { ...h.facts, homeDir: async () => home } };
    };
  }

  /** A manager over a local `p1` at `/Users/me/Code/app`, this machine's home `/Users/me`. */
  function localSource(
    origins: Record<string, string>,
    dirs: Record<string, string[]> = {},
    extra: Array<Record<string, unknown>> = [],
    p1: Record<string, unknown> = {},
    groups?: unknown[],
  ) {
    seed([project("p1", p1), ...extra], groups);
    const fake = fakeGit(origins);
    const mgr = new ProjectManager(hosts(fake.git, fakeShell(dirs), "/Users/me"), tmpDir);
    return { mgr, ...fake };
  }

  const SRC = "/Users/me/Code/app";

  describe("planTransfer", () => {
    it("prefers the remembered path over a project to adopt", async () => {
      const { mgr } = localSource(
        { [SRC]: REPO, "/srv/old": REPO, "/srv/app": REPO },
        { "/srv/old": [".git"], "/srv/app": [".git"] },
        [project("p2", { path: "/srv/app", hostId: "box" })],
        { hostPaths: { box: "/srv/old" } },
      );
      expect(await mgr.planTransfer("p1", "box")).toEqual({
        kind: "ready",
        repoUrl: REPO,
        targetDir: "/srv/old",
        via: "remembered",
      });
    });

    it("skips a remembered path that is no longer a clone of the repo", async () => {
      const { mgr } = localSource(
        { [SRC]: REPO, "/srv/old": OTHER_REPO },
        { "/srv/old": [".git"] },
        [],
        { hostPaths: { box: "/srv/old" } },
      );
      expect(await mgr.planTransfer("p1", "box")).toMatchObject({ kind: "ready", via: "mirror" });
    });

    it("prefers adopting a same-origin project over mirroring", async () => {
      const { mgr } = localSource(
        { [SRC]: REPO, "/srv/app": REPO },
        { "/srv/app": [".git"] },
        [project("p2", { path: "/srv/app", hostId: "box" })],
      );
      expect(await mgr.planTransfer("p1", "box")).toEqual({
        kind: "ready",
        repoUrl: REPO,
        targetDir: "/srv/app",
        via: "adopt",
      });
    });

    it("does not adopt a project that is in another group", async () => {
      const { mgr } = localSource(
        { [SRC]: REPO, "/srv/app": REPO },
        { "/srv/app": [".git"] },
        [
          project("p2", { path: "/srv/app", hostId: "box" }),
          project("p3", { path: "/Users/me/other", hostId: "local" }),
        ],
        {},
        [{ id: "g", name: "Other", memberIds: ["p3", "p2"], lastUsedHostId: null }],
      );
      expect(await mgr.planTransfer("p1", "box")).toMatchObject({ kind: "ready", via: "mirror" });
    });

    it("mirrors a path under this machine's home to the same path under the host's", async () => {
      const { mgr } = localSource({ [SRC]: REPO });
      expect(await mgr.planTransfer("p1", "box")).toEqual({
        kind: "ready",
        repoUrl: REPO,
        targetDir: "~/Code/app",
        via: "mirror",
      });
    });

    it("falls back to ~/code/<slug> for a path outside home", async () => {
      const { mgr } = localSource({ "/opt/app": REPO }, {}, [], {
        path: "/opt/app",
        name: "My App",
      });
      expect(await mgr.planTransfer("p1", "box")).toEqual({
        kind: "ready",
        repoUrl: REPO,
        targetDir: "~/code/my-app",
        via: "default",
      });
    });

    it("asks when the project has no origin", async () => {
      const { mgr } = localSource({});
      expect(await mgr.planTransfer("p1", "box")).toEqual({
        kind: "needsInput",
        reason: "no-origin",
        repoUrl: null,
        targetDir: "~/Code/app",
      });
    });

    it("asks when the target directory holds something else", async () => {
      const { mgr } = localSource({ [SRC]: REPO }, { "/home/u/Code/app": ["notes.txt"] });
      expect(await mgr.planTransfer("p1", "box")).toEqual({
        kind: "needsInput",
        reason: "dir-taken",
        repoUrl: REPO,
        targetDir: "~/Code/app",
      });
    });

    it("asks when another project owns the target directory", async () => {
      const { mgr } = localSource(
        { [SRC]: REPO, "/home/u/Code/app": OTHER_REPO },
        { "/home/u/Code/app": [".git"] },
        [project("p2", { name: "Other", path: "/home/u/Code/app", hostId: "box" })],
      );
      expect(await mgr.planTransfer("p1", "box")).toMatchObject({
        kind: "needsInput",
        reason: "dir-taken",
        targetDir: "~/Code/app",
      });
    });

    it("asks when the group already has a member on the host", async () => {
      const { mgr } = localSource(
        { [SRC]: REPO },
        { "/srv/app": [".git"] },
        [project("p2", { path: "/srv/app", hostId: "box" })],
        {},
        [{ id: "g", name: "App", memberIds: ["p1", "p2"], lastUsedHostId: null }],
      );
      expect(await mgr.planTransfer("p1", "box")).toMatchObject({
        kind: "needsInput",
        reason: "host-taken",
        repoUrl: REPO,
      });
    });
  });

  describe("transferProject: copy", () => {
    it("clones a new project and links it, the group taking the source's settings", async () => {
      const { mgr, cloneCalls } = localSource({ [SRC]: REPO }, {}, [], {
        color: "blue",
        commands: [{ id: "c1", name: "dev", command: "pnpm dev" }],
      });

      const result = await mgr.transferProject("p1", "box", "copy");

      expect(cloneCalls).toEqual([[REPO, "/home/u/Code/app"]]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.project.id).not.toBe("p1");
      expect(result.project.hostId).toBe("box");
      expect(result.project.path).toBe("/home/u/Code/app");
      expect(result.project.group?.memberIds).toEqual(["p1", result.project.id]);

      const state = readState();
      expect(state.projects).toHaveLength(2);
      expect(state.groups).toHaveLength(1);
      expect(state.groups![0]).toMatchObject({
        name: "App",
        color: "blue",
        commands: [{ id: "c1", name: "dev", command: "pnpm dev" }],
      });
    });

    it("links an adopted project without cloning", async () => {
      const { mgr, cloneCalls } = localSource(
        { [SRC]: REPO, "/srv/app": REPO },
        { "/srv/app": [".git"] },
        [project("p2", { path: "/srv/app", hostId: "box" })],
      );

      const result = await mgr.transferProject("p1", "box", "copy");

      expect(cloneCalls).toEqual([]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.project.id).toBe("p2");
      expect(readState().projects).toHaveLength(2);
      expect(readState().groups![0].memberIds).toEqual(["p1", "p2"]);
    });

    it("returns what to ask rather than throwing", async () => {
      const { mgr, cloneCalls } = localSource({});
      expect(await mgr.transferProject("p1", "box", "copy")).toEqual({
        ok: false,
        needsInput: {
          kind: "needsInput",
          reason: "no-origin",
          repoUrl: null,
          targetDir: "~/Code/app",
          mode: "copy",
          hostId: "box",
        },
      });
      expect(cloneCalls).toEqual([]);
    });

    it("skips planning with overrides", async () => {
      // No origin: planning would ask.
      const { mgr, cloneCalls } = localSource({});

      const result = await mgr.transferProject("p1", "box", "copy", {
        repoUrl: REPO,
        targetDir: "/srv/custom",
      });

      expect(cloneCalls).toEqual([[REPO, "/srv/custom"]]);
      expect(result.ok).toBe(true);
    });

    it("keeps the host check with overrides", async () => {
      const { mgr, cloneCalls } = localSource(
        { [SRC]: REPO },
        {},
        [project("p2", { path: "/srv/app", hostId: "box" })],
        {},
        [{ id: "g", name: "App", memberIds: ["p1", "p2"], lastUsedHostId: null }],
      );

      const result = await mgr.transferProject("p1", "box", "copy", {
        repoUrl: REPO,
        targetDir: "/srv/custom",
      });

      expect(result).toMatchObject({ ok: false, needsInput: { reason: "host-taken" } });
      expect(cloneCalls).toEqual([]);
    });

    const ISSUE = { id: "i1", identifier: "ENG-1", title: "Fix it", url: "https://linear.app/i1" };

    it("carries the main workspace's name and issues onto the new path (ADR-214)", async () => {
      const { mgr } = localSource({ [SRC]: REPO }, {}, [], {
        workspaceNames: { [SRC]: "Trunk", "/Users/me/wt/feature": "Feature" },
        workspaceIssues: { [SRC]: [ISSUE] },
        workspaceFolderIds: { [SRC]: "f1" },
      });

      const result = await mgr.transferProject("p1", "box", "copy");

      if (!result.ok) throw new Error("expected ok");
      const copy = readState().projects.find((p) => p.id === result.project.id)!;
      // Only the main workspace's entries, under the new path; no folders.
      expect(copy.workspaceNames).toEqual({ "/home/u/Code/app": "Trunk" });
      expect(copy.workspaceIssues).toEqual({ "/home/u/Code/app": [ISSUE] });
      expect(copy).not.toHaveProperty("workspaceFolderIds");
    });

    it("keeps an adopted project's own name and issues", async () => {
      const OWN = { ...ISSUE, id: "i2", identifier: "ENG-2" };
      const { mgr } = localSource(
        { [SRC]: REPO, "/srv/app": REPO },
        { "/srv/app": [".git"] },
        [
          project("p2", {
            path: "/srv/app",
            hostId: "box",
            workspaceNames: { "/srv/app": "Mine" },
            workspaceIssues: { "/srv/app": [OWN] },
          }),
        ],
        { workspaceNames: { [SRC]: "Trunk" }, workspaceIssues: { [SRC]: [ISSUE] } },
      );

      await mgr.transferProject("p1", "box", "copy");

      const adopted = readState().projects.find((p) => p.id === "p2")!;
      expect(adopted.workspaceNames).toEqual({ "/srv/app": "Mine" });
      expect(adopted.workspaceIssues).toEqual({ "/srv/app": [OWN] });
    });
  });

  describe("transferProject: move", () => {
    it("moves to this machine with no remembered path by cloning there, keeping the id", async () => {
      seed([project("p1", { path: "/home/u/code/app", hostId: "box" })]);
      const { git, cloneCalls } = fakeGit({ "/home/u/code/app": REPO });
      const mgr = new ProjectManager(hosts(git, fakeShell()), tmpDir);

      const result = await mgr.transferProject("p1", LOCAL_HOST_ID, "move");

      const target = path.join(localHome, "code", "app");
      expect(cloneCalls).toEqual([[REPO, target]]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.project.id).toBe("p1");
      expect(result.project.hostId).toBe(LOCAL_HOST_ID);
      expect(result.project.path).toBe(target);
      const state = readState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].hostPaths).toEqual({ box: "/home/u/code/app" });
    });

    it("switches to a remembered path without cloning", async () => {
      const checkout = path.join(localHome, "checkout");
      fs.mkdirSync(checkout);
      seed([
        project("p1", { path: "/srv/app", hostId: "box", hostPaths: { local: checkout } }),
      ]);
      const { git, cloneCalls } = fakeGit({ "/srv/app": REPO, [checkout]: REPO });
      const mgr = new ProjectManager(hosts(git, fakeShell()), tmpDir);

      expect(await mgr.planTransfer("p1", LOCAL_HOST_ID)).toMatchObject({ via: "remembered" });
      const result = await mgr.transferProject("p1", LOCAL_HOST_ID, "move");

      expect(cloneCalls).toEqual([]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.project.id).toBe("p1");
      expect(result.project.path).toBe(checkout);
      expect(result.project.hostId).toBe(LOCAL_HOST_ID);
    });

    it("refuses to move onto another project's checkout", async () => {
      const { mgr, cloneCalls } = localSource(
        { [SRC]: REPO, "/srv/app": REPO },
        { "/srv/app": [".git"] },
        [project("p2", { path: "/srv/app", hostId: "box" })],
      );

      const result = await mgr.transferProject("p1", "box", "move");

      expect(result).toEqual({
        ok: false,
        needsInput: {
          kind: "needsInput",
          reason: "dir-taken",
          repoUrl: REPO,
          targetDir: "/srv/app",
          mode: "move",
          hostId: "box",
        },
      });
      expect(cloneCalls).toEqual([]);
      expect(readState().projects.find((p) => p.id === "p1")?.path).toBe(SRC);
    });

    it("re-clones a missing checkout onto the project's own host", async () => {
      seed([project("p1", { path: "/home/u/Code/app", hostId: "box" })]);
      const { git, cloneCalls } = fakeGit({ "/home/u/Code/app": REPO });
      const mgr = new ProjectManager(hosts(git, fakeShell()), tmpDir);

      const result = await mgr.transferProject("p1", "box", "move");

      expect(cloneCalls).toEqual([[REPO, "/home/u/Code/app"]]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.project.id).toBe("p1");
      expect(result.project.path).toBe("/home/u/Code/app");
    });

    it("re-clones onto the project's own host with overrides", async () => {
      // A missing checkout has no origin to read, so the dialog supplies one.
      seed([project("p1", { path: "/home/u/Code/app", hostId: "box" })]);
      const { git, cloneCalls } = fakeGit();
      const mgr = new ProjectManager(hosts(git, fakeShell()), tmpDir);

      const result = await mgr.transferProject("p1", "box", "move", {
        repoUrl: REPO,
        targetDir: "/home/u/Code/app",
      });

      expect(cloneCalls).toEqual([[REPO, "/home/u/Code/app"]]);
      expect(result.ok).toBe(true);
    });

    it("moves to the overrides' directory", async () => {
      const { mgr, cloneCalls } = localSource({});

      const result = await mgr.transferProject("p1", "box", "move", {
        repoUrl: REPO,
        targetDir: "/srv/custom",
      });

      expect(cloneCalls).toEqual([[REPO, "/srv/custom"]]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.project.id).toBe("p1");
      expect(result.project.path).toBe("/srv/custom");
    });
  });
});
