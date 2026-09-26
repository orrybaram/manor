import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import type { GitBackend, ShellBackend } from "../backend/types";
import { worktreesDir } from "../paths";
import { toDirSlug } from "../branch-name";
import { hostsOf } from "./test-fakes";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("ProjectManager host-relative paths (ADR-178)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-host-paths-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fullGit(): GitBackend {
    return {
      exec: vi.fn(async () => ""),
      worktreeList: vi.fn(async () => []),
      worktreeAdd: vi.fn(async () => {}),
      worktreeRemove: vi.fn(async () => {}),
    } as unknown as GitBackend;
  }

  /** A fake remote `ShellBackend`: `home` for `homeDir`, `files` for `cat`/`test -e`. */
  function fakeShell(
    home: string,
    opts: { files?: Record<string, string> } = {},
  ): ShellBackend & { execCalls: Array<[string, string[], unknown]> } {
    const files = opts.files ?? {};
    const execCalls: Array<[string, string[], unknown]> = [];
    return {
      execCalls,
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => home),
      exec: vi.fn(async (cmd: string, args: string[], execOpts?: unknown) => {
        execCalls.push([cmd, args, execOpts]);
        if (cmd === "cat") {
          const filePath = args[0];
          if (filePath in files) return files[filePath];
          throw new Error(`no such file: ${filePath}`);
        }
        if (cmd === "test" && args[0] === "-e") {
          const filePath = args[1];
          if (filePath in files) return "";
          throw new Error(`missing: ${filePath}`);
        }
        if (cmd === "sh" && args[0] === "-c") {
          return "";
        }
        throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
      }),
    } as unknown as ShellBackend & { execCalls: Array<[string, string[], unknown]> };
  }

  it("resolves a remote project's default worktree root against the host's home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(shell.homeDir).toHaveBeenCalled();
    expect(results[0].worktreePath).toBe(
      "/home/remoteuser/.manor/worktrees/remote-app/feature",
    );
  });

  it("expands a leading ~ in project.worktreePath against the remote host's home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, { worktreePath: "~/custom-trees" });

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe("/home/remoteuser/custom-trees/feature");
  });

  it("does not call the remote host for a local project's home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    const project = await mgr.addProject("Local App", "/tmp/local-app");

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe(
      path.join(worktreesDir(), toDirSlug("Local App"), "feature"),
    );
    expect(shell.homeDir).not.toHaveBeenCalled();
  });

  it("runs the teardown script through the host's shell, not local execAsync", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, {
      worktreeTeardownScript: "docker compose down",
    });

    await mgr.removeWorktree(project.id, "/home/remoteuser/.manor/worktrees/remote-app/feature");

    expect(shell.execCalls).toContainEqual([
      "sh",
      ["-c", "docker compose down"],
      { cwd: "/home/remoteuser/.manor/worktrees/remote-app/feature", timeout: 10 * 60 * 1000 },
    ]);
  });

  it("checks whether a remote worktree still exists through the host's shell, not local fs", async () => {
    const git = fullGit();
    (git.worktreeRemove as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("worktree remove failed"),
    );
    const shell = fakeShell("/home/remoteuser", {
      files: { "/home/remoteuser/.manor/worktrees/remote-app/feature": "" },
    });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    // The directory still exists on the box (per the fake shell's `test -e`)
    // — that must surface as a real failure, not be silently swallowed.
    await expect(
      mgr.removeWorktree(project.id, "/home/remoteuser/.manor/worktrees/remote-app/feature"),
    ).rejects.toThrow(/Failed to remove worktree/);

    expect(shell.execCalls).toContainEqual([
      "test",
      ["-e", "/home/remoteuser/.manor/worktrees/remote-app/feature"],
      undefined,
    ]);
  });

  it("reads package.json and lockfile presence through the host's shell for a remote project", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser", {
      files: {
        "/srv/app/package.json": JSON.stringify({
          scripts: { build: "tsc", test: "vitest" },
        }),
        "/srv/app/pnpm-lock.yaml": "",
      },
    });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    expect(project.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "build", command: "pnpm run build" }),
        expect.objectContaining({ name: "test", command: "pnpm run test" }),
      ]),
    );
  });

  it("includes a remote project's default worktree root in hostIdForPath once its home is known", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await mgr.addProject("Remote App", "/srv/app", "box");

    // Home is not known synchronously yet — the default root is skipped.
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "local",
    );

    // getProjects() warms every remote host's home in the background.
    await mgr.getProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "box",
    );
  });

  it("keeps local worktree resolution byte-identical with no shell resolver supplied", async () => {
    const git = fullGit();
    const mgr = new ProjectManager(git, tmpDir);
    const project = await mgr.addProject("Local App", "/tmp/local-app-2");

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe(
      path.join(worktreesDir(), toDirSlug("Local App"), "feature"),
    );
  });

  it("keeps the local teardown script's original 30s timeout, not the remote's 10min one", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/someone");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    const project = await mgr.addProject("Local App", "/tmp/local-app-3");
    await mgr.updateProject(project.id, { worktreeTeardownScript: "rm -rf tmp" });

    await mgr.removeWorktree(project.id, "/tmp/local-app-3-worktree");

    expect(shell.execCalls).toContainEqual([
      "sh",
      ["-c", "rm -rf tmp"],
      { cwd: "/tmp/local-app-3-worktree", timeout: 30000 },
    ]);
  });

  it("saves a ~ worktreePath without asking the host, and expands it only on use (ADR-183)", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    let reachable = false;
    shell.homeDir = vi.fn(async () => {
      if (!reachable) throw new Error("host unreachable");
      return "/home/remoteuser";
    });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    const updated = await mgr.updateProject(project.id, { worktreePath: "~/custom-trees" });
    expect(updated?.worktreePath).toBe("~/custom-trees");
    expect(shell.homeDir).not.toHaveBeenCalled();

    const issue = { number: 1, title: "feature", url: "https://example.com/1" };
    const [failed] = await mgr.createWorkspacesFromIssues(project.id, [issue]);
    expect(failed.error).toMatch(/host unreachable/);

    // A reachable host on a later call is not blocked by the earlier failure.
    reachable = true;
    const [created] = await mgr.createWorkspacesFromIssues(project.id, [issue]);
    expect(created.worktreePath).toBe("/home/remoteuser/custom-trees/feature");
  });

  it("expands a local project's ~ worktreePath against this machine's home", async () => {
    const git = fullGit();
    const mgr = new ProjectManager(git, tmpDir);
    const project = await mgr.addProject("Local App", "/tmp/local-app-4");
    await mgr.updateProject(project.id, { worktreePath: "~/trees" });

    const [result] = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(result.worktreePath).toBe(path.join(os.homedir(), "trees", "feature"));
  });

  it("routes a remote project's ~ worktree root once its home is known", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, { worktreePath: "~/trees" });
    expect(mgr.hostIdForPath("/home/remoteuser/trees/feature")).toBe("local");

    await mgr.getProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mgr.hostIdForPath("/home/remoteuser/trees/feature")).toBe("box");
  });

  it("saves an absolute worktreePath without asking an unreachable host for its home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    shell.homeDir = vi.fn(async () => {
      throw new Error("host unreachable");
    });
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    const updated = await mgr.updateProject(project.id, {
      worktreePath: "/srv/custom-trees",
    });

    expect(updated?.worktreePath).toBe("/srv/custom-trees");
    expect(shell.homeDir).not.toHaveBeenCalled();
  });

  it("clears the cached home directory when a host's spec is replaced with saveHost", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await mgr.addProject("Remote App", "/srv/app", "box");

    await mgr.getProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "box",
    );

    // The host moved to a different machine with a different home. Replacing
    // its spec must drop the stale cached home, so routing does not keep
    // using the old machine's path until it is re-resolved.
    mgr.saveHost("box", { kind: "ssh", target: "me@new-box" });
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "local",
    );
  });

  it("never drops the leading slash when joining an absolute worktree root (posixJoin)", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(hostsOf(git, shell), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, { worktreePath: "/" });

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe("/feature");
  });
});
