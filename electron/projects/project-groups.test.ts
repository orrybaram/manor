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

  it("unlinks without touching either project's workspaces or per-host settings", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");
    const before = readState().projects;

    mgr.unlinkProject("box-app");

    expect(await groupOf(mgr, "local-app")).toBeNull();
    expect(await groupOf(mgr, "box-app")).toBeNull();
    const after = readState();
    // Each keeps the group's shared settings as its own; nothing else moves.
    const shared = { name: "Project local-app", color: "blue", agentCommand: null, linearAssociations: [], themeName: null, commands: [] };
    expect(after.projects).toEqual(
      before.map((p) =>
        p.id === "local-app" || p.id === "box-app" ? { ...p, ...shared } : p,
      ),
    );
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
        // A new group takes its first member's shared settings.
        color: "blue",
        agentCommand: null,
        linearAssociations: [],
        themeName: null,
        commands: [],
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

  it("dissolves a whole group at once, every member keeping the shared settings", async () => {
    seed();
    const mgr = manager();
    const { id } = mgr.linkProjects("box-app", "local-app");
    mgr.linkProjects("mac-app", "local-app");
    const before = readState().projects;

    mgr.unlinkGroup(id);
    mgr.unlinkGroup("no-such-group");

    for (const pid of ["local-app", "box-app", "mac-app"]) {
      expect(await groupOf(mgr, pid)).toBeNull();
    }
    const shared = { name: "Project local-app", color: "blue", agentCommand: null, linearAssociations: [], themeName: null, commands: [] };
    expect(readState().projects).toEqual(
      before.map((p) => (p.id === "box-other" ? p : { ...p, ...shared })),
    );
    expect(readState()).not.toHaveProperty("groups");
  });

  it("clears a saved last-used host that no member is on", async () => {
    seed({
      groups: [
        { id: "g1", name: "App", memberIds: ["local-app", "box-app"], lastUsedHostId: "mac" },
      ],
    });
    expect((await groupOf(manager(), "local-app"))?.lastUsedHostId).toBeNull();
  });

  it("refuses to move a member onto a host another member is on, before cloning", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");

    await expect(
      mgr.moveProjectToHost("local-app", {
        hostId: "box",
        repoUrl: "https://github.com/org/app.git",
        remoteDir: "/home/me/code/app",
      }),
    ).rejects.toThrow(/already has a project on me@box \("Project box-app"\)/);
    // Nothing moved.
    expect(readState().projects.find((p) => p.id === "local-app")).not.toHaveProperty("hostId");
  });

  it("refuses to switch a member onto a host another member is on", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");

    await expect(mgr.switchProjectHost("local-app", "box", "/home/me/code/app")).rejects.toThrow(
      /already has a project on me@box/,
    );
  });

  describe("shared settings (ticket 2)", () => {
    const TEAM = { teamId: "t1", teamName: "Team", teamKey: "TM" };

    async function info(mgr: ProjectManager, id: string) {
      return (await mgr.getProjects()).find((p) => p.id === id)!;
    }

    it("resolves shared settings group first, then project", async () => {
      seed({
        groups: [
          // No agent command or Linear on the group: members show their own.
          { id: "g1", name: "App", memberIds: ["local-app", "box-app"], lastUsedHostId: null, color: null },
        ],
      });
      const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
      disk.projects[1] = { ...disk.projects[1], agentCommand: "codex", linearAssociations: [TEAM] };
      fs.writeFileSync(path.join(tmpDir, "projects.json"), JSON.stringify(disk));
      const mgr = manager();

      const local = await info(mgr, "local-app");
      const box = await info(mgr, "box-app");
      // The group's name, and its null color over local-app's own "blue".
      expect(local).toMatchObject({ name: "App", color: null, agentCommand: null, linearAssociations: [] });
      expect(box).toMatchObject({ name: "App", color: null, agentCommand: "codex", linearAssociations: [TEAM] });
      // Per-host settings are each member's own.
      expect(box.path).toBe("/home/me/code/box-app");
      // An ungrouped project reads its own.
      expect(await info(mgr, "mac-app")).toMatchObject({ name: "Project mac-app", color: null });
    });

    it("a new group takes its first member's shared settings", async () => {
      seed();
      const mgr = manager();

      mgr.linkProjects("box-app", "local-app");

      expect(await info(mgr, "box-app")).toMatchObject({ name: "Project local-app", color: "blue" });
    });

    it("writes group settings to the group, not the members", async () => {
      seed();
      const mgr = manager();
      const { id } = mgr.linkProjects("box-app", "local-app");
      const before = readState().projects;

      const members = await mgr.updateGroup(id, {
        name: "  App  ",
        color: "green",
        agentCommand: "claude --fast",
        linearAssociations: [TEAM],
      });

      const shared = { name: "App", color: "green", agentCommand: "claude --fast", linearAssociations: [TEAM] };
      expect(members.map((p) => p.id)).toEqual(["local-app", "box-app"]);
      for (const p of members) expect(p).toMatchObject(shared);
      expect(members[0].group?.name).toBe("App");
      const after = readState() as { groups: Array<Record<string, unknown>>; projects: unknown[] };
      expect(after.groups[0]).toMatchObject(shared);
      expect(after.projects).toEqual(before);
      // A blank name leaves the group's name alone.
      await mgr.updateGroup(id, { name: "   " });
      expect((await info(mgr, "box-app")).name).toBe("App");
      await expect(mgr.updateGroup("no-such-group", { color: "red" })).rejects.toThrow(/Unknown group/);
    });

    it("sends a grouped project's shared updates to its group", async () => {
      seed();
      const mgr = manager();
      mgr.linkProjects("box-app", "local-app");

      const updated = await mgr.updateProject("box-app", { color: "red", worktreePath: "~/wt" });

      expect(updated).toMatchObject({ color: "red", worktreePath: "~/wt" });
      // The other member shows the shared color, not the per-host path.
      expect(await info(mgr, "local-app")).toMatchObject({ color: "red", worktreePath: null });
      const box = readState().projects.find((p) => p.id === "box-app")!;
      expect(box.worktreePath).toBe("~/wt");
      expect(box).not.toHaveProperty("color");
    });

    it("copies the group's shared settings onto the project that leaves", async () => {
      seed();
      const mgr = manager();
      const { id } = mgr.linkProjects("box-app", "local-app");
      mgr.linkProjects("mac-app", "local-app");
      await mgr.updateGroup(id, { name: "App", color: "green", linearAssociations: [TEAM] });

      mgr.unlinkProject("box-app");

      const shared = { name: "App", color: "green", agentCommand: null, linearAssociations: [TEAM] };
      expect(await info(mgr, "box-app")).toMatchObject({ ...shared, group: null });
      expect(readState().projects.find((p) => p.id === "box-app")).toMatchObject(shared);
      // The two left stay grouped and keep reading the group.
      expect(await info(mgr, "mac-app")).toMatchObject({ ...shared, group: { id } });
      // A later group edit no longer reaches the one that left.
      await mgr.updateGroup(id, { color: "red" });
      expect((await info(mgr, "box-app")).color).toBe("green");
      // The last member of a dissolved group keeps them too.
      mgr.removeProject("mac-app");
      expect(await info(mgr, "local-app")).toMatchObject({ name: "App", color: "red", group: null });
    });

    it("leaves a member's own value when the group never had that setting", async () => {
      seed({
        groups: [{ id: "g1", name: "App", memberIds: ["local-app", "box-app"], lastUsedHostId: null }],
      });
      const mgr = manager();

      mgr.unlinkProject("box-app");

      // Only the name was the group's; local-app keeps its own color.
      expect(await info(mgr, "local-app")).toMatchObject({ name: "App", color: "blue" });
    });

    it("keeps a group's shared settings on the one member left when it loads", async () => {
      seed({
        groups: [
          // `ghost` is gone, so the group dissolves at load.
          {
            id: "g1",
            name: "App",
            memberIds: ["box-app", "ghost"],
            lastUsedHostId: null,
            color: "green",
            agentCommand: "codex",
            linearAssociations: [TEAM],
          },
        ],
      });
      const mgr = manager();

      expect(await info(mgr, "box-app")).toMatchObject({
        name: "App",
        color: "green",
        agentCommand: "codex",
        linearAssociations: [TEAM],
        group: null,
      });
      mgr.selectProject(0);
      expect(readState()).not.toHaveProperty("groups");
      expect(readState().projects.find((p) => p.id === "box-app")).toMatchObject({ name: "App", color: "green" });
    });

    it("drops malformed Linear entries on a group read from disk", async () => {
      seed({
        groups: [
          {
            id: "g1",
            name: "App",
            memberIds: ["local-app", "box-app"],
            lastUsedHostId: null,
            linearAssociations: [null, { teamId: 1 }, TEAM],
          },
        ],
      });

      expect((await info(manager(), "box-app")).linearAssociations).toEqual([TEAM]);
    });

    it("loads a group's shared settings from disk, dropping malformed ones", async () => {
      seed({
        groups: [
          {
            id: "g1",
            name: "App",
            memberIds: ["local-app", "box-app"],
            lastUsedHostId: null,
            color: 7,
            agentCommand: "codex",
            linearAssociations: "TM",
          },
        ],
      });
      const mgr = manager();

      // The bad color and Linear fall through to the member's own.
      expect(await info(mgr, "local-app")).toMatchObject({
        color: "blue",
        agentCommand: "codex",
        linearAssociations: [],
      });
    });
  });

  describe("shared theme and commands (ADR-193 ticket 1)", () => {
    const CMD = { id: "c1", name: "Build", command: "npm run build" };

    async function info(mgr: ProjectManager, id: string) {
      return (await mgr.getProjects()).find((p) => p.id === id)!;
    }

    it("resolves themeName group first, then project; commands like linearAssociations", async () => {
      seed({
        groups: [
          // A null theme on the group is a value; no commands, so members
          // show their own.
          { id: "g1", name: "App", memberIds: ["local-app", "box-app"], lastUsedHostId: null, themeName: null },
        ],
      });
      const disk = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
      disk.projects[1] = { ...disk.projects[1], commands: [CMD], themeName: "dracula" };
      fs.writeFileSync(path.join(tmpDir, "projects.json"), JSON.stringify(disk));
      const mgr = manager();

      const local = await info(mgr, "local-app");
      const box = await info(mgr, "box-app");
      // The group's null theme wins over box-app's own "dracula".
      expect(local).toMatchObject({ themeName: null, commands: [] });
      expect(box).toMatchObject({ themeName: null, commands: [CMD] });
      // An ungrouped project reads its own.
      expect(await info(mgr, "mac-app")).toMatchObject({ themeName: null, commands: [] });
    });

    it("a new group takes its first member's theme and commands", async () => {
      seed({
        projects: [
          project("local-app", undefined, { themeName: "dracula", commands: [CMD] }),
          project("box-app", "box"),
          project("box-other", "box"),
          project("mac-app", "mac"),
        ],
      });
      const mgr = manager();

      mgr.linkProjects("box-app", "local-app");

      expect(await info(mgr, "box-app")).toMatchObject({ themeName: "dracula", commands: [CMD] });
    });

    it("writes group theme and commands to the group, not the members", async () => {
      seed();
      const mgr = manager();
      const { id } = mgr.linkProjects("box-app", "local-app");
      const before = readState().projects;

      const members = await mgr.updateGroup(id, { themeName: "dracula", commands: [CMD] });

      for (const p of members) expect(p).toMatchObject({ themeName: "dracula", commands: [CMD] });
      const after = readState() as { groups: Array<Record<string, unknown>>; projects: unknown[] };
      expect(after.groups[0]).toMatchObject({ themeName: "dracula", commands: [CMD] });
      expect(after.projects).toEqual(before);
    });

    it("sends a grouped project's theme and commands updates to its group", async () => {
      seed();
      const mgr = manager();
      mgr.linkProjects("box-app", "local-app");

      const updated = await mgr.updateProject("box-app", { themeName: "dracula", commands: [CMD] });

      expect(updated).toMatchObject({ themeName: "dracula", commands: [CMD] });
      // The other member shows the shared theme and commands too.
      expect(await info(mgr, "local-app")).toMatchObject({ themeName: "dracula", commands: [CMD] });
      const box = readState().projects.find((p) => p.id === "box-app")!;
      expect(box).not.toHaveProperty("themeName");
      expect(box).not.toHaveProperty("commands");
    });

    it("copies the group's theme and commands onto the project that leaves", async () => {
      seed();
      const mgr = manager();
      const { id } = mgr.linkProjects("box-app", "local-app");
      await mgr.updateGroup(id, { themeName: "dracula", commands: [CMD] });

      mgr.unlinkProject("box-app");

      expect(await info(mgr, "box-app")).toMatchObject({
        themeName: "dracula",
        commands: [CMD],
        group: null,
      });
      expect(readState().projects.find((p) => p.id === "box-app")).toMatchObject({
        themeName: "dracula",
        commands: [CMD],
      });
    });

    it("drops malformed custom commands on a group read from disk", async () => {
      seed({
        groups: [
          {
            id: "g1",
            name: "App",
            memberIds: ["local-app", "box-app"],
            lastUsedHostId: null,
            commands: [null, { id: "c1" }, CMD],
          },
        ],
      });

      expect((await info(manager(), "box-app")).commands).toEqual([CMD]);
    });

    it("loads a group's malformed theme and commands from disk, falling through to the member's own", async () => {
      seed({
        groups: [
          {
            id: "g1",
            name: "App",
            memberIds: ["local-app", "box-app"],
            lastUsedHostId: null,
            themeName: 7,
            commands: "nope",
          },
        ],
      });
      const mgr = manager();

      expect(await info(mgr, "local-app")).toMatchObject({ themeName: null, commands: [] });
    });
  });

  it("persists the host a group last made a workspace on", async () => {
    seed();
    const mgr = manager();
    const { id } = mgr.linkProjects("box-app", "local-app");

    mgr.setGroupLastUsedHost(id, "box");

    // A fresh manager reads it back from disk.
    expect((await groupOf(manager(), "local-app"))?.lastUsedHostId).toBe("box");
  });

  it("refuses a last-used host no member is on, or an unknown group", async () => {
    seed();
    const mgr = manager();
    const { id } = mgr.linkProjects("box-app", "local-app");

    expect(() => mgr.setGroupLastUsedHost(id, "mac")).toThrow(/has no project on me@mac/);
    expect(() => mgr.setGroupLastUsedHost("nope", "box")).toThrow(/Unknown project group/);
    expect((await groupOf(manager(), "local-app"))?.lastUsedHostId).toBe("local");
  });
});
