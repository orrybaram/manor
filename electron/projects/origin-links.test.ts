import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import { originKey } from "./origin-links";
import type { GitBackend, ShellBackend } from "../backend/types";
import { hostsOf } from "./test-fakes";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("originKey", () => {
  it("gives one key to the https, ssh and scp forms of a GitHub repo", () => {
    const key = "github.com/acme/app";
    expect(originKey("git@github.com:acme/app.git")).toBe(key);
    expect(originKey("https://github.com/Acme/App")).toBe(key);
    expect(originKey("ssh://git@github.com:22/acme/app.git/")).toBe(key);
    expect(originKey("github.com:acme/app\n")).toBe(key);
    expect(originKey("git://github.com/acme/app")).toBe(key);
  });

  it("matches with a trailing slash after .git", () => {
    expect(originKey("https://github.com/acme/app.git/")).toBe(originKey("https://github.com/acme/app"));
    expect(originKey("git@github.com:acme/app.git//")).toBe("github.com/acme/app");
  });

  it("falls back to the normalized URL for other remotes", () => {
    expect(originKey("ssh://git@git.example.com:2222/team/sub/app.git")).toBe(
      "git.example.com/team/sub/app",
    );
    expect(originKey("git@git.example.com:team/sub/app")).toBe(
      "git.example.com/team/sub/app",
    );
  });

  it("has no key for no URL or a path on disk", () => {
    expect(originKey(null)).toBeNull();
    expect(originKey("  ")).toBeNull();
    expect(originKey("/srv/git/app.git")).toBeNull();
    expect(originKey("../app")).toBeNull();
    expect(originKey("file:///srv/git/app")).toBeNull();
  });

  it("has no key for a bare relative path or a Windows drive path", () => {
    expect(originKey("repos/app")).toBeNull();
    expect(originKey("repos/app.git")).toBeNull();
    expect(originKey("C:/x/y")).toBeNull();
    expect(originKey("C:\\x")).toBeNull();
    expect(originKey("c:\\repos\\app.git")).toBeNull();
  });
});

describe("ProjectManager link suggestions by origin (ADR-192 ticket 5)", () => {
  let tmpDir: string;
  /** `origin` by `host:path`; a missing entry is a repo with no origin. */
  let origins: Record<string, string>;
  /** Hosts whose git fails, as an unreachable host's does. */
  let offline: Set<string>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-origin-links-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    offline = new Set();
    origins = {
      "local:/code/local-app": "git@github.com:acme/app.git",
      "local:/code/local-dup": "https://github.com/acme/app.git",
      "box:/code/box-app": "https://github.com/Acme/App",
      "box:/code/box-fork": "git@github.com:me/app.git",
      "mac:/code/mac-app": "ssh://git@github.com/acme/app.git",
      "mac:/code/mac-other": "https://gitlab.com/acme/other.git",
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function project(id: string, hostId: string) {
    return {
      id,
      name: `Project ${id}`,
      path: `/code/${id}`,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...(hostId === "local" ? {} : { hostId }),
    };
  }

  const ALL = ["local-app", "local-dup", "box-app", "box-fork", "mac-app", "mac-other"];

  function seed(ids: string[] = ALL, extra: Record<string, unknown> = {}): string {
    const state = {
      projects: ids.map((id) => project(id, id.split("-")[0])),
      selectedProjectIndex: 0,
      hosts: {
        box: { spec: { kind: "ssh", target: "me@box" } },
        mac: { spec: { kind: "ssh", target: "me@mac" } },
      },
      ...extra,
    };
    const text = JSON.stringify(state, null, 2);
    fs.writeFileSync(path.join(tmpDir, "projects.json"), text);
    return text;
  }

  function manager(): ProjectManager {
    const gitFor = (hostId: string) =>
      ({
        exec: vi.fn(async (cwd: string, args: string[]) => {
          if (offline.has(hostId)) throw new Error(`${hostId} is unavailable`);
          const origin = origins[`${hostId}:${cwd}`];
          if (args.join(" ") === "remote get-url origin" && origin) return `${origin}\n`;
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

  function fileText(): string {
    return fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8");
  }

  function readState(): {
    groups?: Array<Record<string, unknown>>;
    dismissedLinkSuggestions?: unknown;
  } {
    return JSON.parse(fileText());
  }

  async function suggestedIds(mgr: ProjectManager, projectId: string): Promise<string[]> {
    return (await mgr.suggestLinks(projectId)).map((s) => s.projectId).sort();
  }

  it("suggests projects on other hosts with the same origin, in any URL form", async () => {
    seed();
    const mgr = manager();

    const suggestions = await mgr.suggestLinks("local-app");

    expect(suggestions).toEqual([
      { projectId: "box-app", name: "Project box-app", hostLabel: "me@box" },
      { projectId: "mac-app", name: "Project mac-app", hostLabel: "me@mac" },
    ]);
  });

  it("never suggests a fork, a different repo, or a project on the same host", async () => {
    seed();
    const mgr = manager();

    // box-fork is the user's fork, mac-other another repo, local-dup a
    // second clone on this Mac: none is offered for local-app.
    expect(await suggestedIds(mgr, "local-app")).toEqual(["box-app", "mac-app"]);
    expect(await suggestedIds(mgr, "box-fork")).toEqual([]);
    expect(await suggestedIds(mgr, "mac-other")).toEqual([]);
  });

  it("matches non-GitHub remotes by their normalized URL", async () => {
    origins["local:/code/local-app"] = "ssh://git@git.example.com:2222/team/sub/app.git";
    origins["box:/code/box-app"] = "git@git.example.com:team/sub/app";
    seed(["local-app", "box-app"]);
    const mgr = manager();

    expect(await suggestedIds(mgr, "box-app")).toEqual(["local-app"]);
  });

  it("suggests nothing for a repo with no origin or a path origin", async () => {
    delete origins["local:/code/local-app"];
    seed(["local-app", "box-app"]);
    const mgr = manager();
    expect(await mgr.suggestLinks("local-app")).toEqual([]);

    origins["local:/code/local-app"] = "/srv/git/app.git";
    origins["box:/code/box-app"] = "/srv/git/app.git";
    expect(await mgr.suggestLinks("local-app")).toEqual([]);
    expect(await mgr.suggestLinks("box-app")).toEqual([]);
  });

  it("suggests a group once, only when it has room on the project's host", async () => {
    seed();
    const mgr = manager();
    const group = mgr.linkProjects("box-app", "local-app");

    // The group has no member on the mac: offered once, as the group.
    const forMac = await mgr.suggestLinks("mac-app");
    const asGroup = forMac.filter((s) => s.name === group.name);
    expect(asGroup).toEqual([
      { projectId: "local-app", name: group.name, hostLabel: "this Mac, me@box" },
    ]);
    // Its members aren't offered one by one as well.
    expect(forMac.map((s) => s.projectId)).not.toContain("box-app");

    // local-dup is on this Mac, where the group already has local-app.
    expect(await suggestedIds(mgr, "local-dup")).toEqual(["mac-app"]);
  });

  it("offers a grouped project only lone projects on hosts its group lacks", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");

    // local-dup is on a host the group has; mac-app is not.
    expect(await suggestedIds(mgr, "local-app")).toEqual(["mac-app"]);
  });

  it("only suggests: nothing is linked", async () => {
    seed();
    const mgr = manager();

    await mgr.suggestLinks("local-app");

    const projects = await mgr.getProjects();
    expect(projects.every((p) => p.group === null)).toBe(true);
    expect(readState().groups).toBeUndefined();
  });

  it("remembers a dismissed pair, from either side and across restarts", async () => {
    seed();
    const mgr = manager();

    mgr.dismissLinkSuggestion("local-app", "box-app");

    expect(await suggestedIds(mgr, "local-app")).toEqual(["mac-app"]);
    expect(await suggestedIds(mgr, "box-app")).toEqual(["local-dup", "mac-app"]);
    expect(readState().dismissedLinkSuggestions).toEqual([["box-app", "local-app"]]);

    const reloaded = manager();
    expect(await suggestedIds(reloaded, "local-app")).toEqual(["mac-app"]);
  });

  it("a dismissal with one member of a group covers the group", async () => {
    seed();
    const mgr = manager();
    const group = mgr.linkProjects("box-app", "local-app");
    const offered = (await mgr.suggestLinks("mac-app")).find((s) => s.name === group.name)!;

    mgr.dismissLinkSuggestion("mac-app", offered.projectId);

    expect((await mgr.suggestLinks("mac-app")).some((s) => s.name === group.name)).toBe(false);
  });

  it("drops a removed project's dismissals, and the key once none are left", async () => {
    seed();
    const mgr = manager();
    mgr.dismissLinkSuggestion("local-app", "box-app");

    mgr.removeProject("box-app");

    expect(readState()).not.toHaveProperty("dismissedLinkSuggestions");
  });

  it("drops stale or malformed dismissals when loading", async () => {
    seed(["local-app", "box-app"], {
      dismissedLinkSuggestions: [
        ["local-app", "gone"],
        ["local-app", "local-app"],
        "junk",
        ["local-app", "box-app"],
        ["box-app", "local-app"],
      ],
    });
    const mgr = manager();

    mgr.selectProject(0);

    expect(readState().dismissedLinkSuggestions).toEqual([["box-app", "local-app"]]);
  });

  it("leaves projects.json unchanged for users who never dismiss", async () => {
    const original = seed();
    const mgr = manager();

    await mgr.suggestLinks("local-app");
    await mgr.suggestLinks("box-app");
    expect(fileText()).toBe(original);

    // A write for another reason adds no dismissal key.
    mgr.selectProject(1);
    expect(readState()).not.toHaveProperty("dismissedLinkSuggestions");
  });

  it("a group stores its normalized origin when linked", async () => {
    seed();
    const mgr = manager();

    mgr.linkProjects("box-app", "local-app");

    await vi.waitFor(() =>
      expect(readState().groups?.[0].originKey).toBe("github.com/acme/app"),
    );
  });

  it("a group linked while its hosts were away gets its origin later", async () => {
    seed();
    offline = new Set(["local", "box"]);
    const mgr = manager();
    mgr.linkProjects("box-app", "local-app");
    // Let the attempt made on linking finish, with nothing to show for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readState().groups?.[0]).not.toHaveProperty("originKey");

    offline.clear();
    expect(await suggestedIds(mgr, "mac-app")).toContain("local-app");
    expect(readState().groups?.[0].originKey).toBe("github.com/acme/app");
  });

  it("still suggests a group while all its hosts are offline", async () => {
    seed();
    const linker = manager();
    const group = linker.linkProjects("box-app", "local-app");
    await vi.waitFor(() => expect(readState().groups?.[0].originKey).toBeDefined());

    offline = new Set(["local", "box"]);
    const mgr = manager();

    const suggestions = await mgr.suggestLinks("mac-app");
    expect(suggestions.map((s) => s.name)).toEqual([group.name]);
  });

  it("derives the group's origin again when the member it came from leaves", async () => {
    seed();
    const mgr = manager();
    // local-app is first, so the group takes its key; box-fork (a fork)
    // and mac-other (another repo) are linked by hand.
    mgr.linkProjects("box-fork", "local-app");
    mgr.linkProjects("local-app", "mac-other");
    await vi.waitFor(() =>
      expect(readState().groups?.[0].originKey).toBe("github.com/acme/app"),
    );

    mgr.unlinkProject("local-app");

    await vi.waitFor(() =>
      expect(readState().groups?.[0].originKey).toBe("github.com/me/app"),
    );
  });

  it("doesn't keep a departed member's key while the rest are away", async () => {
    seed();
    const mgr = manager();
    mgr.linkProjects("box-fork", "local-app");
    mgr.linkProjects("local-app", "mac-other");
    await vi.waitFor(() => expect(readState().groups?.[0].originKey).toBeDefined());
    offline = new Set(["box", "mac"]);

    mgr.removeProject("local-app");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readState().groups?.[0]).not.toHaveProperty("originKey");
  });

  it("keeps a group's stored origin across a load", async () => {
    seed(["local-app", "box-app"], {
      groups: [
        {
          id: "g1",
          name: "App",
          memberIds: ["local-app", "box-app"],
          lastUsedHostId: "local",
          originKey: "github.com/acme/app",
        },
      ],
    });
    const mgr = manager();

    mgr.selectProject(1);

    expect(readState().groups?.[0].originKey).toBe("github.com/acme/app");
  });
});
