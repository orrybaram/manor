import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import { normalizeOriginUrl, validateRemoteDir, validateRepoUrl } from "./remote-clone";
import type { GitBackend, ShellBackend } from "../backend/types";
import { hostsOf } from "./test-fakes";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("validateRepoUrl (ADR-178 ticket 5)", () => {
  it.each([
    "https://github.com/org/repo.git",
    "https://github.com/org/repo",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
  ])("accepts %s", (url) => {
    expect(() => validateRepoUrl(url)).not.toThrow();
  });

  it.each([
    "",
    "not a url",
    "file:///etc/passwd",
    "https://github.com/org/repo.git; rm -rf /",
    "-oProxyCommand=whoami",
    // scp-style user part starting with `-` — otherwise a valid-looking
    // remote that `git clone` could misread as an option (ADR-178 ticket 5
    // review).
    "-oProxyCommand=whoami@github.com:org/repo.git",
  ])("rejects %s", (url) => {
    expect(() => validateRepoUrl(url)).toThrow();
  });
});

describe("validateRemoteDir (ADR-178 ticket 5)", () => {
  it.each(["/srv/app", "~/code/repo", "~", "/home/user/my-app_2"])(
    "accepts %s",
    (dir) => {
      expect(() => validateRemoteDir(dir)).not.toThrow();
    },
  );

  it.each([
    "",
    "relative/path",
    "/srv/app; rm -rf /",
    "/srv/$(whoami)",
    "/srv/app\ninjected",
    "../escape",
  ])("rejects %s", (dir) => {
    expect(() => validateRemoteDir(dir)).toThrow();
  });
});

describe("normalizeOriginUrl (ADR-178 ticket 5 review)", () => {
  it("treats git@host:path, ssh://git@host/path and https://host/path as the same identity", () => {
    const forms = [
      "git@github.com:org/repo.git",
      "ssh://git@github.com/org/repo.git",
      "https://github.com/org/repo.git",
      "https://github.com/org/repo",
      "https://github.com/org/repo/",
    ];
    const normalized = forms.map(normalizeOriginUrl);
    expect(new Set(normalized).size).toBe(1);
  });

  it("is case-insensitive on the host", () => {
    expect(normalizeOriginUrl("https://GitHub.com/org/repo.git")).toBe(
      normalizeOriginUrl("https://github.com/org/repo.git"),
    );
  });

  it("ignores an embedded user and a port", () => {
    expect(normalizeOriginUrl("https://me@github.com:443/org/repo.git")).toBe(
      normalizeOriginUrl("https://github.com/org/repo.git"),
    );
  });

  it("treats different repos as different identities", () => {
    expect(normalizeOriginUrl("git@github.com:org/repo-a.git")).not.toBe(
      normalizeOriginUrl("git@github.com:org/repo-b.git"),
    );
  });
});

describe("ProjectManager.addRemoteProject (ADR-178 ticket 5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-addremote-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  type FakeGit = GitBackend & {
    cloneStream: ReturnType<typeof vi.fn>;
    cloneCalls: Array<[string, string]>;
  };

  /** A fake remote `GitBackend` whose `cloneStream` clone succeeds by default. */
  function fakeGit(opts: {
    onDone?: { exitCode: number | null; stderr: string };
    lines?: string[];
    remoteOrigins?: Record<string, string>;
  } = {}): FakeGit {
    const cloneCalls: Array<[string, string]> = [];
    const remoteOrigins = opts.remoteOrigins ?? {};
    return {
      exec: vi.fn(async (cwd: string, args: string[]) => {
        if (
          args[0] === "config" &&
          args[1] === "--get" &&
          args[2] === "remote.origin.url"
        ) {
          if (cwd in remoteOrigins) return remoteOrigins[cwd];
          throw new Error("no such remote");
        }
        throw new Error(`unstubbed git: ${args.join(" ")}`);
      }),
      worktreeList: vi.fn(async () => []),
      cloneCalls,
      cloneStream: vi.fn(
        (repoUrl: string, targetDir: string, callbacks: {
          onLine: (line: string) => void;
          onDone: (r: { exitCode: number | null; stderr: string }) => void;
        }) => {
          cloneCalls.push([repoUrl, targetDir]);
          for (const line of opts.lines ?? ["Cloning into..."]) {
            callbacks.onLine(line);
          }
          callbacks.onDone(opts.onDone ?? { exitCode: 0, stderr: "" });
          return { cancel: vi.fn() };
        },
      ),
    } as unknown as FakeGit;
  }

  /** A fake remote `ShellBackend` with a fake filesystem for existing-dir checks. */
  function fakeShell(
    home: string,
    dirs: Record<string, string[] | null> = {},
  ): ShellBackend {
    return {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => home),
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "test" && args[0] === "-e") {
          const dir = args[1];
          if (dir in dirs) return "";
          throw new Error(`missing: ${dir}`);
        }
        if (cmd === "sh" && args[0] === "-c") {
          const script = args[1];
          const match = /ls -A (.+)$/.exec(script);
          const dir = match ? match[1].replace(/^'|'$/g, "") : "";
          const entries = dirs[dir] ?? [];
          return entries.join("\n");
        }
        throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
      }),
    } as unknown as ShellBackend;
  }

  it("rejects a project on the local host", async () => {
    const mgr = new ProjectManager(hostsOf(fakeGit(), fakeShell("/home/u")), tmpDir);
    await expect(
      mgr.addRemoteProject({
        hostId: "local",
        repoUrl: "https://github.com/org/repo.git",
        remoteDir: "/srv/app",
        name: "App",
      }),
    ).rejects.toThrow(/remote host/);
  });

  it("rejects an invalid repo URL before touching the host", async () => {
    const git = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await expect(
      mgr.addRemoteProject({
        hostId: "box",
        repoUrl: "not a url",
        remoteDir: "/srv/app",
        name: "App",
      }),
    ).rejects.toThrow(/Repo URL/);
    expect(git.cloneStream).not.toHaveBeenCalled();
  });

  it("rejects an invalid remote directory before touching the host", async () => {
    const git = fakeGit();
    const mgr = new ProjectManager(hostsOf(git, fakeShell("/home/u")), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await expect(
      mgr.addRemoteProject({
        hostId: "box",
        repoUrl: "https://github.com/org/repo.git",
        remoteDir: "relative/path",
        name: "App",
      }),
    ).rejects.toThrow(/Remote directory/);
    expect(git.cloneStream).not.toHaveBeenCalled();
  });

  it("clones into the expanded ~/-relative directory and adds the project", async () => {
    const git = fakeGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    const project = await mgr.addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "~/code/repo",
      name: "Repo",
    });

    expect(git.cloneCalls).toEqual([
      ["https://github.com/org/repo.git", "/home/remoteuser/code/repo"],
    ]);
    expect(project.path).toBe("/home/remoteuser/code/repo");
    expect(project.hostId).toBe("box");
  });

  it("refuses a non-empty target directory that isn't already this repo", async () => {
    const git = fakeGit();
    const shell = fakeShell("/home/remoteuser", {
      "/srv/app": ["some-file"],
    });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    await expect(
      mgr.addRemoteProject({
        hostId: "box",
        repoUrl: "https://github.com/org/repo.git",
        remoteDir: "/srv/app",
        name: "App",
      }),
    ).rejects.toThrow(/already exists and is not empty/);
    expect(git.cloneStream).not.toHaveBeenCalled();
  });

  it("adopts a directory that is already a clone of the same repo, without cloning again", async () => {
    const git = fakeGit({
      remoteOrigins: { "/srv/app": "https://github.com/org/repo.git" },
    });
    const shell = fakeShell("/home/remoteuser", { "/srv/app": ["package.json"] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    const project = await mgr.addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "/srv/app",
      name: "App",
    });

    expect(git.cloneStream).not.toHaveBeenCalled();
    expect(project.path).toBe("/srv/app");
  });

  it("adopts a directory whose origin is the same repo in a different URL form (scp vs. https)", async () => {
    const git = fakeGit({
      // The checkout's `origin` is scp-style; the user typed https.
      remoteOrigins: { "/srv/app": "git@github.com:org/repo.git" },
    });
    const shell = fakeShell("/home/remoteuser", { "/srv/app": ["package.json"] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    const project = await mgr.addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "/srv/app",
      name: "App",
    });

    expect(git.cloneStream).not.toHaveBeenCalled();
    expect(project.path).toBe("/srv/app");
  });

  it("adopting an existing clone twice returns the same project instead of a duplicate", async () => {
    const git = fakeGit({
      remoteOrigins: { "/srv/app": "https://github.com/org/repo.git" },
    });
    const shell = fakeShell("/home/remoteuser", { "/srv/app": ["package.json"] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    const first = await mgr.addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "/srv/app",
      name: "App",
    });
    const second = await mgr.addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "/srv/app",
      name: "App",
    });

    expect(second.id).toBe(first.id);
    const projects = await mgr.getProjects();
    expect(projects.filter((p) => p.path === "/srv/app")).toHaveLength(1);
  });

  it("clones into an empty existing directory", async () => {
    const git = fakeGit();
    const shell = fakeShell("/home/remoteuser", { "/srv/app": [] });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    await mgr.addRemoteProject({
      hostId: "box",
      repoUrl: "https://github.com/org/repo.git",
      remoteDir: "/srv/app",
      name: "App",
    });

    expect(git.cloneCalls).toEqual([["https://github.com/org/repo.git", "/srv/app"]]);
  });

  it("rejects and never adds the project when the clone fails", async () => {
    const git = fakeGit({ onDone: { exitCode: 128, stderr: "fatal: could not read from remote" } });
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    await expect(
      mgr.addRemoteProject({
        hostId: "box",
        repoUrl: "https://github.com/org/repo.git",
        remoteDir: "/srv/app",
        name: "App",
      }),
    ).rejects.toThrow(/could not read from remote/);

    const projects = await mgr.getProjects();
    expect(projects).toHaveLength(0);
  });
});
