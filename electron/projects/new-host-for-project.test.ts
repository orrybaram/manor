import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./project-manager";
import { LOCAL_HOST_ID, type GitBackend, type ShellBackend } from "../backend/types";
import { readRecipe } from "../backend/providers/recipes";
import { hostsOf } from "./test-fakes";
import type { ProjectHostResolver } from "./types";
import {
  openInNewHost,
  podNameFor,
  repoNameOf,
  type NewHostDeps,
} from "./new-host-for-project";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("repoNameOf", () => {
  it("reads the last segment, without .git", () => {
    expect(repoNameOf("https://github.com/org/app.git")).toBe("app");
    expect(repoNameOf("git@github.com:org/My_Repo.git")).toBe("My_Repo");
    expect(repoNameOf("https://example.com/org/app/")).toBe("app");
    expect(repoNameOf("git@host:app")).toBe("app");
  });
});

describe("podNameFor (ADR-235 D3)", () => {
  const free = () => false;

  it("slugs the repo name into a DNS label", () => {
    expect(podNameFor("My App", { maxLength: 40, isTaken: free })).toBe("my-app");
    expect(podNameFor("foo.js", { maxLength: 40, isTaken: free })).toBe("foojs");
  });

  it("starts with a letter", () => {
    expect(podNameFor("9lives", { maxLength: 40, isTaken: free })).toBe("p-9lives");
    expect(podNameFor("___", { maxLength: 40, isTaken: free })).toBe("project");
  });

  it("cuts to the limit without a trailing dash", () => {
    expect(podNameFor("abcde-fghij", { maxLength: 6, isTaken: free })).toBe("abcde");
    expect(podNameFor("a".repeat(80), { maxLength: 64, isTaken: free })).toHaveLength(40);
  });

  it("adds -2, -3 to a taken name, cut to fit", () => {
    const taken = new Set(["app", "app-2"]);
    expect(podNameFor("app", { maxLength: 40, isTaken: (n) => taken.has(n) })).toBe("app-3");
    const long = new Set(["abcdef"]);
    expect(podNameFor("abcdef", { maxLength: 6, isTaken: (n) => long.has(n) })).toBe("abcd-2");
  });

  it("always matches the templates' NAME_PATTERN", () => {
    const pattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
    for (const repo of ["X", "-a-", "a--b", "Ünïcode", "1", "x".repeat(100)]) {
      for (const max of [1, 5, 12, 40]) {
        const name = podNameFor(repo, { maxLength: max, isTaken: free });
        expect(name).toMatch(pattern);
        expect(name).toMatch(/^[a-z]/);
        expect(name.length).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("openInNewHost (ADR-235 D3)", () => {
  let tmpDir: string;
  let recipesDir: string;

  const REPO = "https://github.com/org/app.git";
  const REMOTE_HOME = "/home/u";
  const SRC = "/Users/me/Code/app";

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-new-host-test-${crypto.randomUUID()}`);
    recipesDir = path.join(tmpDir, "host-recipes");
    fs.mkdirSync(recipesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(projects: Array<Record<string, unknown>> = []) {
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({ projects, selectedProjectIndex: 0 }),
    );
  }

  /** Git answering `origin` per checkout path, and a clone that succeeds unless told. */
  function fakeGit(origins: Record<string, string> = {}) {
    const cloneCalls: Array<[string, string]> = [];
    let cloneFails = false;
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
        (
          repoUrl: string,
          targetDir: string,
          callbacks: { onDone: (r: { exitCode: number | null; stderr: string }) => void },
        ) => {
          cloneCalls.push([repoUrl, targetDir]);
          callbacks.onDone(
            cloneFails
              ? { exitCode: 128, stderr: "fatal: could not read from remote" }
              : { exitCode: 0, stderr: "" },
          );
          return { cancel: vi.fn() };
        },
      ),
    };
    return {
      git: git as unknown as GitBackend,
      cloneCalls,
      failClones: (on: boolean) => {
        cloneFails = on;
      },
    };
  }

  /** The pod's shell: nothing exists yet. */
  function fakeShell(): ShellBackend {
    return {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => REMOTE_HOME),
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "test" && args[0] === "-e") throw new Error(`missing: ${args[1]}`);
        if (cmd === "sh" && args[0] === "-c") return "";
        if (cmd === "cat") throw new Error("no such file");
        throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
      }),
    } as unknown as ShellBackend;
  }

  function hosts(git: GitBackend, shell: ShellBackend): ProjectHostResolver {
    const base = hostsOf(git, shell);
    return (hostId) => {
      const h = base(hostId);
      if (hostId !== LOCAL_HOST_ID) return h;
      return { git: h.git, shell: h.shell, facts: { ...h.facts, homeDir: async () => "/Users/me" } };
    };
  }

  function setup(
    opts: {
      projects?: Array<Record<string, unknown>>;
      origins?: Record<string, string>;
      connect?: () => Promise<void>;
      idleStopMinutes?: number | null;
    } = {},
  ) {
    seed(opts.projects);
    const fake = fakeGit(opts.origins);
    const mgr = new ProjectManager(hosts(fake.git, fakeShell()), tmpDir);
    const profile = mgr.saveHostProfile(
      {
        name: "Work cluster",
        templateId: "kubernetes",
        values: { context: "kind-test", namespace: "team", image: "ghcr.io/x/y:1", storage: "20Gi" },
        ...(opts.idleStopMinutes !== undefined ? { idleStopMinutes: opts.idleStopMinutes } : {}),
      },
      { appVersion: "1.0.0" },
    );
    const registry = {
      version: "1.0.0",
      register: vi.fn(),
      ensureConnected: vi.fn(opts.connect ?? (async () => {})),
      recordChanged: vi.fn(),
    };
    const adoption = { whenAdopted: vi.fn(async () => true) };
    const deps: NewHostDeps = {
      projectManager: mgr,
      backendRegistry: registry as unknown as NewHostDeps["backendRegistry"],
      hostAdoption: adoption,
      recipesDir,
    };
    return { mgr, profile, registry, adoption, deps, ...fake };
  }

  function project(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: "App",
      path: SRC,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...extra,
    };
  }

  it("names, writes the recipe, adds the host, waits, clones and marks it", async () => {
    const { mgr, profile, registry, adoption, deps, cloneCalls } = setup();
    // The wait comes before the clone.
    let clonesWhenWaited = -1;
    adoption.whenAdopted.mockImplementation(async () => {
      clonesWhenWaited = cloneCalls.length;
      return true;
    });
    const result = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });

    if (!result.ok) throw new Error(`expected ok: ${result.error}`);
    const { hostId } = result;
    expect(mgr.getHosts()).toEqual([
      { hostId, spec: { kind: "recipe", recipeId: "kubernetes-team-app" } },
    ]);
    const recipe = readRecipe("kubernetes-team-app", recipesDir);
    expect(recipe.name).toBe("app");
    expect(recipe.env?.MANOR_K8S_NAME).toBe("app");
    expect(recipe.idleStopMinutes).toBe(60);
    expect(mgr.hostProfileId(hostId)).toBe(profile.id);
    expect(mgr.hostSupervised(hostId)).toBe(true);
    expect(registry.register).toHaveBeenCalledWith(hostId, {
      kind: "recipe",
      recipeId: "kubernetes-team-app",
    });
    expect(registry.ensureConnected).toHaveBeenCalledWith(hostId);
    expect(adoption.whenAdopted).toHaveBeenCalledWith(hostId);
    expect(clonesWhenWaited).toBe(0);
    expect(cloneCalls).toEqual([[REPO, `${REMOTE_HOME}/code/app`]]);
    expect(result.project).toMatchObject({ name: "app", hostId, path: `${REMOTE_HOME}/code/app` });
    expect(mgr.hostForProject(hostId)).toBe(result.project.id);
    expect(registry.recordChanged).toHaveBeenCalledWith(hostId);
  });

  it("leaves idle stop out when the profile has it off", async () => {
    const { profile, deps } = setup({ idleStopMinutes: null });
    const result = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });
    expect(result.ok).toBe(true);
    expect(readRecipe("kubernetes-team-app", recipesDir).idleStopMinutes).toBeUndefined();
  });

  it("adds -2 when the name's recipe directory is taken", async () => {
    const { mgr, profile, deps } = setup();
    fs.mkdirSync(path.join(recipesDir, "kubernetes-team-app"));
    const first = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });
    if (!first.ok) throw new Error(first.error);
    expect(mgr.getHosts()[0].spec).toEqual({ kind: "recipe", recipeId: "kubernetes-team-app-2" });
    expect(readRecipe("kubernetes-team-app-2", recipesDir).env?.MANOR_K8S_NAME).toBe("app-2");
  });

  it("adds -2 when another host already uses the name", async () => {
    const { mgr, profile, deps } = setup();
    const first = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });
    if (!first.ok) throw new Error(first.error);
    // Its recipe directory is gone, but the host still names it.
    fs.rmSync(path.join(recipesDir, "kubernetes-team-app"), { recursive: true });
    const second = await openInNewHost(deps, {
      profileId: profile.id,
      repoUrl: "https://github.com/other/app",
    });
    expect(second.ok).toBe(true);
    expect(mgr.getHosts().map((h) => h.spec)).toEqual([
      { kind: "recipe", recipeId: "kubernetes-team-app" },
      { kind: "recipe", recipeId: "kubernetes-team-app-2" },
    ]);
  });

  it("keeps the host when up fails, and says so", async () => {
    const { mgr, profile, deps, cloneCalls } = setup({
      connect: async () => {
        throw new Error("kubectl: forbidden");
      },
    });
    const result = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });
    expect(result).toMatchObject({ ok: false, stage: "up", error: "kubectl: forbidden" });
    const hostId = (result as { hostId?: string }).hostId;
    expect(hostId).toBeDefined();
    expect(mgr.getHosts().map((h) => h.hostId)).toEqual([hostId]);
    expect(fs.existsSync(path.join(recipesDir, "kubernetes-team-app"))).toBe(true);
    expect(cloneCalls).toEqual([]);
    expect(mgr.hostForProject(hostId!)).toBeUndefined();
  });

  it("keeps the host and marks nothing when the clone fails", async () => {
    const { mgr, profile, deps, failClones, registry } = setup();
    failClones(true);
    const result = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });
    expect(result).toMatchObject({ ok: false, stage: "clone" });
    const hostId = (result as { hostId?: string }).hostId!;
    expect(mgr.getHosts().map((h) => h.hostId)).toEqual([hostId]);
    expect(mgr.hostForProject(hostId)).toBeUndefined();
    expect(registry.recordChanged).not.toHaveBeenCalled();
    expect(await mgr.getProjects()).toHaveLength(0);
  });

  it("retries from clone on the same host, making no second host", async () => {
    const { mgr, profile, deps, failClones, registry, cloneCalls } = setup();
    failClones(true);
    const failed = await openInNewHost(deps, { profileId: profile.id, repoUrl: REPO });
    const hostId = (failed as { hostId?: string }).hostId!;
    failClones(false);
    registry.register.mockClear();

    const result = await openInNewHost(deps, {
      profileId: profile.id,
      repoUrl: REPO,
      retryFrom: { hostId, stage: "clone" },
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.hostId).toBe(hostId);
    expect(registry.register).not.toHaveBeenCalled();
    expect(mgr.getHosts()).toHaveLength(1);
    expect(fs.readdirSync(recipesDir)).toEqual(["kubernetes-team-app"]);
    expect(cloneCalls).toHaveLength(2);
    expect(mgr.hostForProject(hostId)).toBe(result.project.id);
  });

  it("refuses to retry on an unknown host", async () => {
    const { profile, deps } = setup();
    await expect(
      openInNewHost(deps, {
        profileId: profile.id,
        repoUrl: REPO,
        retryFrom: { hostId: "nope", stage: "up" },
      }),
    ).rejects.toThrow();
  });

  it("Set up on copies the source project there, joining its group", async () => {
    const { mgr, profile, deps, cloneCalls } = setup({
      projects: [project("p1")],
      origins: { [SRC]: REPO },
    });
    const result = await openInNewHost(deps, {
      profileId: profile.id,
      repoUrl: REPO,
      sourceProjectId: "p1",
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.project.id).not.toBe("p1");
    expect(result.project.hostId).toBe(result.hostId);
    expect(result.project.group?.memberIds).toEqual(["p1", result.project.id]);
    expect(cloneCalls).toEqual([[REPO, `${REMOTE_HOME}/Code/app`]]);
    expect(mgr.hostForProject(result.hostId)).toBe(result.project.id);
  });

  it("answers what to ask when Set up on cannot plan the copy", async () => {
    const { mgr, profile, deps } = setup({ projects: [project("p1")] });
    const result = await openInNewHost(deps, {
      profileId: profile.id,
      repoUrl: REPO,
      sourceProjectId: "p1",
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "clone",
      needsInput: { kind: "needsInput", mode: "copy" },
    });
    const hostId = (result as { hostId?: string }).hostId!;
    expect(mgr.hostForProject(hostId)).toBeUndefined();
  });

  it("throws for an unknown profile, making nothing", async () => {
    const { mgr, deps } = setup();
    await expect(openInNewHost(deps, { profileId: "hp-nope", repoUrl: REPO })).rejects.toThrow(
      /Unknown host profile/,
    );
    expect(mgr.getHosts()).toEqual([]);
  });
});
