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

describe("ProjectManager.autoJoin / keepSeparate (ADR-214)", () => {
  let tmpDir: string;
  /** `origin` by `host:path`; a missing entry is a repo with no origin. */
  let origins: Record<string, string>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-auto-join-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    origins = {};
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const APP = "git@github.com:acme/app.git";

  /** A project `id` on the host its id starts with, a clone of `origin`. */
  function project(id: string, origin: string | null = APP, extra: Record<string, unknown> = {}) {
    const hostId = id.split("-")[0];
    const p = `/code/${id}`;
    if (origin) origins[`${hostId}:${p}`] = origin;
    return {
      id,
      name: `Project ${id}`,
      path: p,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...(hostId === "local" ? {} : { hostId }),
      ...extra,
    };
  }

  function seed(projects: unknown[], extra: Record<string, unknown> = {}): void {
    const state = {
      projects,
      selectedProjectIndex: 0,
      hosts: {
        box: { spec: { kind: "ssh", target: "me@box" } },
        mac: { spec: { kind: "ssh", target: "me@mac" } },
      },
      ...extra,
    };
    fs.writeFileSync(path.join(tmpDir, "projects.json"), JSON.stringify(state, null, 2));
  }

  function manager(): ProjectManager {
    const gitFor = (hostId: string) =>
      ({
        exec: vi.fn(async (cwd: string, args: string[]) => {
          const origin = origins[`${hostId}:${cwd}`];
          if (args.join(" ") === "config --get remote.origin.url" && origin) return `${origin}\n`;
          throw new Error("error: No such remote 'origin'");
        }),
        worktreeList: vi.fn(async () => []),
      }) as unknown as GitBackend;
    const shell = {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => "/home/me"),
      exec: vi.fn(async () => ""),
    } as unknown as ShellBackend;
    return new ProjectManager(hostsOf(gitFor, shell), tmpDir);
  }

  function readState(): {
    projects: Array<Record<string, unknown> & { id: string }>;
    groups?: Array<Record<string, unknown> & { memberIds: string[] }>;
    dismissedLinkSuggestions?: unknown;
  } {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
  }

  it("joins a same-origin pair on two hosts, the later-added one joining", async () => {
    seed([project("local-app"), project("box-app")]);
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([{ joinedId: "box-app", intoId: "local-app" }]);

    const groups = readState().groups!;
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(["local-app", "box-app"]);
  });

  it("takes the settings of the project that was there first", async () => {
    seed([
      project("local-app", APP, { color: "blue", agentCommand: "claude" }),
      project("box-app", APP, { color: "red", agentCommand: "codex" }),
    ]);
    const mgr = manager();

    await mgr.autoJoin();

    expect(readState().groups![0]).toMatchObject({
      name: "Project local-app",
      color: "blue",
      agentCommand: "claude",
    });
  });

  it("joins a lone project into an existing group, which keeps its settings", async () => {
    seed([project("local-app"), project("box-app"), project("mac-app", APP, { color: "red" })], {
      groups: [
        {
          id: "g1",
          name: "App",
          memberIds: ["box-app", "local-app"],
          lastUsedHostId: null,
          color: "green",
        },
      ],
    });
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([{ joinedId: "mac-app", intoId: "box-app" }]);

    const groups = readState().groups!;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "App", color: "green" });
    expect(groups[0].memberIds).toEqual(["box-app", "local-app", "mac-app"]);
  });

  it("joins nothing across a different origin, or on one host", async () => {
    seed([
      project("local-app"),
      project("local-dup"),
      project("box-other", "https://github.com/acme/other.git"),
    ]);
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([]);
    expect(readState().groups).toBeUndefined();
  });

  it("respects a dismissed pair", async () => {
    seed([project("local-app"), project("box-app")], {
      dismissedLinkSuggestions: [["box-app", "local-app"]],
    });
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([]);
    expect(readState().groups).toBeUndefined();
  });

  it("never joins two groups", async () => {
    seed([project("local-app"), project("box-app"), project("local-two"), project("mac-two")], {
      groups: [
        { id: "g1", name: "A", memberIds: ["local-app", "box-app"], lastUsedHostId: null },
        { id: "g2", name: "B", memberIds: ["local-two", "mac-two"], lastUsedHostId: null },
      ],
    });
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([]);
    expect(readState().groups!.map((g) => g.memberIds)).toEqual([
      ["local-app", "box-app"],
      ["local-two", "mac-two"],
    ]);
  });

  it("skips a pair an earlier join in the batch made impossible", async () => {
    // Two clones on the box: once one has joined local-app, the box is
    // taken in that group and the other stays alone.
    seed([project("local-app"), project("box-app"), project("box-dup")]);
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([{ joinedId: "box-app", intoId: "local-app" }]);

    const groups = readState().groups!;
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(["local-app", "box-app"]);
  });

  it("joins three hosts into one group in one batch", async () => {
    seed([project("local-app"), project("box-app"), project("mac-app")]);
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([
      { joinedId: "box-app", intoId: "local-app" },
      { joinedId: "mac-app", intoId: "local-app" },
    ]);
    expect(readState().groups!.map((g) => g.memberIds)).toEqual([
      ["local-app", "box-app", "mac-app"],
    ]);
  });

  it("doesn't join a newcomer into a group holding a project it was kept apart from", async () => {
    // mac-app was dismissed with box-app; once box-app joins local-app,
    // mac-app must not join that group through local-app.
    seed([project("local-app"), project("box-app"), project("mac-app")], {
      dismissedLinkSuggestions: [["box-app", "mac-app"]],
    });
    const mgr = manager();

    expect(await mgr.autoJoin()).toEqual([{ joinedId: "box-app", intoId: "local-app" }]);
    expect(readState().groups!.map((g) => g.memberIds)).toEqual([["local-app", "box-app"]]);
  });

  it("undoes a join for good with unlink then dismiss", async () => {
    seed([project("local-app"), project("box-app")]);
    const mgr = manager();
    const [{ joinedId, intoId }] = await mgr.autoJoin();

    mgr.unlinkProject(joinedId);
    mgr.dismissLinkSuggestion(joinedId, intoId);

    expect(await mgr.autoJoin()).toEqual([]);
    expect(readState().groups).toBeUndefined();
  });

  it("undoAutoJoin gives the newcomer back its own name and color", async () => {
    seed([
      project("local-app", APP, { name: "Local App", color: "red" }),
      project("box-app", APP, { name: "Box App", color: "blue" }),
    ]);
    const mgr = manager();
    const [{ joinedId, intoId }] = await mgr.autoJoin();

    mgr.undoAutoJoin(joinedId, intoId);

    const state = readState();
    expect(state.groups).toBeUndefined();
    const byId = (id: string) => state.projects.find((p) => p.id === id)!;
    expect(byId("box-app")).toMatchObject({ name: "Box App", color: "blue" });
    expect(byId("local-app")).toMatchObject({ name: "Local App", color: "red" });
    expect(state.dismissedLinkSuggestions).toEqual([["box-app", "local-app"]]);
    expect(await mgr.autoJoin()).toEqual([]);
  });

  it("keepSeparate splits the group and stops a re-join", async () => {
    seed([project("local-app"), project("box-app"), project("mac-app")]);
    const mgr = manager();
    await mgr.autoJoin();

    mgr.keepSeparate("box-app");

    const state = readState();
    expect(state.groups).toBeUndefined();
    expect(state.dismissedLinkSuggestions).toEqual([
      ["box-app", "local-app"],
      ["local-app", "mac-app"],
      ["box-app", "mac-app"],
    ]);
    expect(await mgr.autoJoin()).toEqual([]);
    expect(readState().groups).toBeUndefined();
  });

  it("keepSeparate on a lone project changes nothing", async () => {
    seed([project("local-app"), project("box-app")]);
    const mgr = manager();

    mgr.keepSeparate("local-app");

    expect(readState()).not.toHaveProperty("dismissedLinkSuggestions");
  });
});
