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

describe("ProjectManager linked-project groups (ADR-192)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-groups-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function project(id: string, hostId: string | undefined, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: `Project ${id}`,
      path: `/home/me/code/${id}`,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...(hostId ? { hostId } : {}),
      ...extra,
    };
  }

  /**
   * Local `local-app`, and `box-app` / `box-other` on `box`, `mac-app` on
   * `mac` — the same repo on three hosts plus a second project on the box.
   */
  function seed(state: Record<string, unknown> = {}) {
    const full = {
      projects: [
        project("local-app", undefined, {
          color: "blue",
          workspaceOrder: ["/home/me/code/local-app"],
          workspaceNames: { "/home/me/code/local-app": "main" },
        }),
        project("box-app", "box"),
        project("box-other", "box"),
        project("mac-app", "mac"),
      ],
      selectedProjectIndex: 0,
      hosts: {
        box: { spec: { kind: "ssh", target: "me@box" } },
        mac: { spec: { kind: "ssh", target: "me@mac" } },
      },
      ...state,
    };
    fs.writeFileSync(path.join(tmpDir, "projects.json"), JSON.stringify(full));
  }

  function manager(): ProjectManager {
    const git = {
      exec: vi.fn(async () => {
        throw new Error("no git here");
      }),
      worktreeList: vi.fn(async () => []),
    } as unknown as GitBackend;
    const shell = {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => "/home/me"),
      exec: vi.fn(async () => ""),
    } as unknown as ShellBackend;
    return new ProjectManager(hostsOf(git, shell), tmpDir);
  }

  function readState(): { groups?: unknown; projects: Array<Record<string, unknown>> } {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
  }

  async function groupOf(mgr: ProjectManager, id: string) {
    const projects = await mgr.getProjects();
    return projects.find((p) => p.id === id)!.group ?? null;
  }

  it("links a local and a remote project into a new group", async () => {
    seed();
    const mgr = manager();

    const group = mgr.linkProjects("box-app", "local-app");

    expect(group).toMatchObject({
      name: "Project local-app",
      memberIds: ["local-app", "box-app"],
      lastUsedHostId: "local",
    });
    const projects = await mgr.getProjects();
    expect(projects.find((p) => p.id === "local-app")!.group).toEqual(group);
    expect(projects.find((p) => p.id === "box-app")!.group).toEqual(group);
    expect(projects.find((p) => p.id === "mac-app")!.group).toBeNull();
  });

  it("adds a project on a third host to an existing group, from either side", async () => {
    seed();
    const mgr = manager();
    const { id } = mgr.linkProjects("box-app", "local-app");

    // The ungrouped project names a member; the group is the member's.
    const joined = mgr.linkProjects("local-app", "mac-app");

    expect(joined.id).toBe(id);
    expect(joined.memberIds).toEqual(["local-app", "box-app", "mac-app"]);
  });

  it("allows only one project per host in a group", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");

    expect(() => mgr.linkProjects("box-other", "local-app")).toThrow(
      /already has a project on me@box/,
    );
    expect(() => mgr.linkProjects("box-other", "box-app")).toThrow(/one project per host|already has/);
    // Two projects on one host can't start a group either.
    mgr.unlinkProject("box-app");
    expect(() => mgr.linkProjects("box-other", "box-app")).toThrow(/one project per host/);
    expect(await groupOf(mgr, "box-other")).toBeNull();
  });

  it("refuses to link a project with itself, an unknown project, or across two groups", () => {
    seed({
      projects: [
        project("local-app", undefined),
        project("box-app", "box"),
        project("local-2", undefined),
        project("mac-app", "mac"),
      ],
    });
    const mgr = manager();
    expect(() => mgr.linkProjects("local-app", "local-app")).toThrow(/itself/);
    expect(() => mgr.linkProjects("local-app", "nope")).toThrow(/Unknown project/);

    mgr.linkProjects("box-app", "local-app");
    mgr.linkProjects("mac-app", "local-2");
    expect(() => mgr.linkProjects("mac-app", "box-app")).toThrow(/different groups/);
    // Linking two members of the same group is a no-op.
    expect(mgr.linkProjects("local-app", "box-app").memberIds).toEqual([
      "local-app",
      "box-app",
    ]);
  });

  it("unlinks without touching either project's workspaces or settings", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");
    const before = readState().projects;

    mgr.unlinkProject("box-app");

    expect(await groupOf(mgr, "local-app")).toBeNull();
    expect(await groupOf(mgr, "box-app")).toBeNull();
    const after = readState();
    expect(after.projects).toEqual(before);
    // A group of one dissolves, and no empty list is left behind.
    expect(after).not.toHaveProperty("groups");
  });

  it("keeps a group of three going when one member leaves", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");
    mgr.linkProjects("mac-app", "local-app");

    mgr.unlinkProject("local-app");

    const group = await groupOf(mgr, "box-app");
    expect(group?.memberIds).toEqual(["box-app", "mac-app"]);
    // The host it was last used on has no member any more.
    expect(group?.lastUsedHostId).toBeNull();
    expect(await groupOf(mgr, "local-app")).toBeNull();
  });

  it("drops a removed project from its group", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");

    mgr.removeProject("box-app");

    expect(await groupOf(mgr, "local-app")).toBeNull();
    expect(readState()).not.toHaveProperty("groups");
  });

  it("round-trips groups through projects.json", async () => {
    seed();
    const group = manager().linkProjects("box-app", "local-app");

    expect(readState().groups).toEqual([
      {
        id: group.id,
        name: "Project local-app",
        memberIds: ["local-app", "box-app"],
        lastUsedHostId: "local",
      },
    ]);
    const reloaded = manager();
    expect(await groupOf(reloaded, "box-app")).toEqual(group);
    expect(await groupOf(reloaded, "local-app")).toEqual(group);
  });

  it("writes a file with no groups back without a groups key", () => {
    seed();
    const mgr = manager();
    mgr.selectProject(1);
    expect(readState()).not.toHaveProperty("groups");
  });

  it("repairs groups from disk that break the rules", async () => {
    seed({
      groups: [
        // A second member on `box`, an unknown id and a repeat are dropped.
        {
          id: "g1",
          name: "App",
          memberIds: ["local-app", "box-app", "box-other", "ghost", "local-app"],
          lastUsedHostId: "box",
        },
        // `box-app` is already in g1, which leaves g2 with one member.
        { id: "g2", name: "Other", memberIds: ["box-app", "mac-app"], lastUsedHostId: null },
      ],
    });
    const mgr = manager();

    expect(await groupOf(mgr, "local-app")).toEqual({
      id: "g1",
      name: "App",
      memberIds: ["local-app", "box-app"],
      lastUsedHostId: "box",
    });
    expect(await groupOf(mgr, "mac-app")).toBeNull();
    expect(await groupOf(mgr, "box-other")).toBeNull();
  });

  it("refuses to switch a member onto a host another member is on", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");

    await expect(mgr.switchProjectHost("local-app", "box", "/home/me/code/app")).rejects.toThrow(
      /already has a project on me@box/,
    );
  });
});
