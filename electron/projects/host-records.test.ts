import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import type { GitBackend } from "../backend/types";
import { worktreesDir } from "../paths";
import { toDirSlug } from "../branch-name";
import { hostsOf } from "./test-fakes";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("ProjectManager hosts (ADR-160)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-hosts-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function gitNamed(name: string): GitBackend {
    return {
      exec: vi.fn(async () => {
        throw new Error("no origin");
      }),
      worktreeList: vi.fn(async (cwd: string) => [
        { path: cwd, branch: name, isMain: true },
      ]),
    } as unknown as GitBackend;
  }

  it("reads a project persisted without hostId as local, with no migration", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({
        projects: [
          {
            id: "p1",
            name: "Old",
            path: "/tmp/old",
            selectedWorkspaceIndex: 0,
            workspaces: [],
            defaultBranch: "main",
            defaultRunCommand: null,
            worktreePath: null,
          },
        ],
        selectedProjectIndex: 0,
      }),
    );
    const resolver = vi.fn((hostId: string) => gitNamed(hostId));
    const mgr = new ProjectManager(hostsOf(resolver), tmpDir);

    const [project] = await mgr.getProjects();
    expect(project.hostId).toBe("local");
    expect(mgr.getProjectHostId("p1")).toBe("local");
    expect(mgr.getHosts()).toEqual([]);
    expect(new Set(resolver.mock.calls.map(([id]) => id))).toEqual(new Set(["local"]));
  });

  it("does not write hostId for a local project", async () => {
    const mgr = new ProjectManager(gitNamed("local"), tmpDir);
    await mgr.addProject("Local", "/tmp/local");
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
    expect(saved.projects[0]).not.toHaveProperty("hostId");
    expect(saved).not.toHaveProperty("hosts");
  });

  it("routes a remote project's git through its host and persists the host", async () => {
    const gits = new Map<string, GitBackend>();
    const resolver = (hostId: string) => {
      if (!gits.has(hostId)) gits.set(hostId, gitNamed(hostId));
      return gits.get(hostId)!;
    };
    const mgr = new ProjectManager(hostsOf(resolver), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote", "/home/me/app", "box");

    expect(project.hostId).toBe("box");
    expect(project.workspaces[0].branch).toBe("box");
    expect(gits.get("box")!.worktreeList).toHaveBeenCalledWith("/home/me/app");
    expect(gits.has("local")).toBe(false);

    const reloaded = new ProjectManager(hostsOf(resolver), tmpDir);
    expect(reloaded.getHosts()).toEqual([
      { hostId: "box", spec: { kind: "ssh", target: "me@box" } },
    ]);
    const [info] = await reloaded.getProjects();
    expect(info.hostId).toBe("box");
    expect(reloaded.remoteHostIdsInUse()).toEqual(["box"]);
  });

  it("lists only remote projects' worktrees for a remote refresh", async () => {
    const gits = new Map<string, GitBackend>();
    const resolver = (hostId: string) => {
      if (!gits.has(hostId)) gits.set(hostId, gitNamed(hostId));
      return gits.get(hostId)!;
    };
    const mgr = new ProjectManager(hostsOf(resolver), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await mgr.addProject("Local", "/tmp/local");
    await mgr.addProject("Remote", "/home/me/app", "box");
    await mgr.getProjects();
    vi.mocked(gits.get("local")!.worktreeList).mockClear();
    vi.mocked(gits.get("box")!.worktreeList).mockClear();

    const remote = await mgr.getRemoteProjects();

    expect(remote.map((p) => [p.name, p.hostId])).toEqual([["Remote", "box"]]);
    expect(gits.get("box")!.worktreeList).toHaveBeenCalledWith("/home/me/app");
    expect(gits.get("local")!.worktreeList).not.toHaveBeenCalled();
  });

  it("keeps extra per-host fields when a host's spec is replaced", () => {
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({
        projects: [],
        selectedProjectIndex: 0,
        hosts: { box: { spec: { kind: "ssh", target: "old" }, lastHookSeq: 42 } },
      }),
    );
    const mgr = new ProjectManager(gitNamed("local"), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "new" });
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
    expect(saved.hosts.box).toEqual({ spec: { kind: "ssh", target: "new" }, lastHookSeq: 42 });
    expect(() => mgr.saveHost("local", { kind: "ssh", target: "x" })).toThrow();
  });

  it("records each host's hook cursor, debounced, and flushes it on demand", () => {
    const mgr = new ProjectManager(gitNamed("local"), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    // Never met: null, not 0, so the hook feed can tell first contact apart.
    expect(mgr.getHostHookCursor("box")).toBeNull();
    mgr.setHostHookCursor("box", { seq: 7, epoch: "e1" });
    expect(mgr.getHostHookCursor("box")).toEqual({ seq: 7, epoch: "e1" });
    // Unknown hosts are ignored rather than created.
    mgr.setHostHookCursor("ghost", { seq: 3, epoch: null });
    expect(mgr.getHostHookCursor("ghost")).toBeNull();

    const read = () =>
      JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8")).hosts.box;
    expect(read().lastHookSeq).toBeUndefined();
    mgr.flushHostHookSeqs();
    expect(read()).toEqual({
      spec: { kind: "ssh", target: "me@box" },
      lastHookSeq: 7,
      hookJournalEpoch: "e1",
    });
    expect(new ProjectManager(gitNamed("local"), tmpDir).getHostHookCursor("box")).toEqual({
      seq: 7,
      epoch: "e1",
    });

    // A seq stored before epochs existed reads back with a null epoch.
    mgr.setHostHookCursor("box", { seq: 0, epoch: null });
    mgr.flushHostHookSeqs();
    expect(read()).toEqual({ spec: { kind: "ssh", target: "me@box" }, lastHookSeq: 0 });
    expect(mgr.getHostHookCursor("box")).toEqual({ seq: 0, epoch: null });
  });

  it("does not route a local project's worktrees to a same-named remote project", () => {
    const project = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: "App",
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...extra,
    });
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({
        // The remote project comes first, so a tie would have gone to it.
        projects: [
          project("r1", { path: "/home/me/app", hostId: "box" }),
          project("l1", { path: "/Users/me/app" }),
          project("r2", {
            name: "Other",
            path: "/home/me/other",
            hostId: "box",
            worktreePath: "/home/me/other-trees",
          }),
          project("r3", { name: "Shared", path: "/srv/shared", hostId: "box" }),
          project("l3", { name: "Shared", path: "/srv/shared" }),
        ],
        selectedProjectIndex: 0,
        hosts: { box: { spec: { kind: "ssh", target: "me@box" } } },
      }),
    );
    const mgr = new ProjectManager(hostsOf(gitNamed), tmpDir);

    // The default worktree root is this machine's; it belongs to local only.
    expect(mgr.hostIdForPath(path.join(worktreesDir(), toDirSlug("App"), "feature"))).toBe("local");
    // An explicit worktree root on a remote project still counts.
    expect(mgr.hostIdForPath("/home/me/other-trees/feature")).toBe("box");
    // Equally close local and remote roots: local wins.
    expect(mgr.hostIdForPath("/srv/shared/src")).toBe("local");
    expect(mgr.hostIdForPath("/home/me/app/src")).toBe("box");
  });

  it("resolves a path to the host of the project containing it", async () => {
    const mgr = new ProjectManager(hostsOf(gitNamed), tmpDir);
    await mgr.addProject("Local", "/Users/me/app");
    // No remote project yet: everything is local.
    expect(mgr.hostIdForPath("/home/me/app/src")).toBe("local");

    await mgr.addProject("Remote", "/home/me/app", "box");
    expect(mgr.hostIdForPath("/home/me/app")).toBe("box");
    expect(mgr.hostIdForPath("/home/me/app/src")).toBe("box");
    expect(mgr.hostIdForPath("/home/me/app2")).toBe("local");
    expect(mgr.hostIdForPath("/Users/me/app/src")).toBe("local");
    expect(mgr.hostIdForPath("/somewhere/else")).toBe("local");
  });
});
