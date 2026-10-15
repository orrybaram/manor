import { describe, expect, it } from "vitest";
import { posixJoin, type MachineFacts } from "../backend/machine-facts";
import { LastKnownWorkspaces, seedCommands } from "./project-info";
import type { PersistedProject } from "./types";

function project(overrides: Partial<PersistedProject>): PersistedProject {
  return {
    id: "p1",
    name: "App",
    path: "/home/me/app",
    hostId: "box",
    selectedWorkspaceIndex: 0,
    workspaces: [],
    defaultBranch: "main",
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    ...overrides,
  } as PersistedProject;
}

const listing = [
  { path: "/home/me/app", branch: "main", isMain: true, name: null },
  { path: "/home/me/.wt/app-feat", branch: "feat", isMain: false, name: null },
];

describe("LastKnownWorkspaces", () => {
  it("recalls a remote project's listing only while its host is away", () => {
    let away = false;
    const cache = new LastKnownWorkspaces(() => away);
    cache.remember(project({}), listing);
    expect(cache.recall(project({}))).toBeUndefined();
    away = true;
    expect(cache.recall(project({}))).toEqual(listing);
  });

  it("hands out copies, so callers can't change what it keeps", () => {
    const cache = new LastKnownWorkspaces(() => true);
    cache.remember(project({}), listing);
    const first = cache.recall(project({}))!;
    first[0].branch = "changed";
    first.reverse();
    expect(cache.recall(project({}))).toEqual(listing);
  });

  it("ignores the entry once the project lives on another host or path", () => {
    const cache = new LastKnownWorkspaces(() => true);
    cache.remember(project({}), listing);
    expect(cache.recall(project({ hostId: "vm" }))).toBeUndefined();
    expect(cache.recall(project({ path: "/srv/app" }))).toBeUndefined();
  });

  it("drops the entry on forget", () => {
    const cache = new LastKnownWorkspaces(() => true);
    cache.remember(project({}), listing);
    cache.forget("p1");
    expect(cache.recall(project({}))).toBeUndefined();
  });

  it("never keeps a local project or one whose path can't be keyed", () => {
    const cache = new LastKnownWorkspaces(() => true);
    cache.remember(project({ hostId: "local" }), listing);
    expect(cache.recall(project({ hostId: "local" }))).toBeUndefined();
    cache.remember(project({ path: "relative/app" }), listing);
    expect(cache.recall(project({ path: "relative/app" }))).toBeUndefined();
  });
});

/** Facts over an in-memory file tree: `exists` and `readFile` answer from `files`. */
function factsOf(files: Record<string, string>): MachineFacts {
  return {
    platform: async () => "linux",
    uid: async () => 1000,
    homeDir: async () => "/home/me",
    kill: async () => {},
    exists: async (p) => p in files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readlinks: async () => new Map(),
    join: posixJoin,
    defaultWorktreeRoot: async (name) =>
      posixJoin("/home/me", ".manor", "worktrees", name),
  };
}

const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scripts: { dev: "vite", test: "vitest" }, ...extra });

describe("seedCommands", () => {
  const commandsOf = async (files: Record<string, string>) =>
    (await seedCommands(factsOf(files), "/app")).map((c) => c.command);

  it("returns nothing without a package.json or scripts", async () => {
    expect(await commandsOf({})).toEqual([]);
    expect(await commandsOf({ "/app/package.json": "{}" })).toEqual([]);
    expect(await commandsOf({ "/app/package.json": "not json" })).toEqual([]);
  });

  it("runs scripts with bun when bun's lockfile is present", async () => {
    expect(
      await commandsOf({ "/app/package.json": pkg(), "/app/bun.lock": "" }),
    ).toEqual(["bun run dev", "bun run test"]);
    expect(
      await commandsOf({ "/app/package.json": pkg(), "/app/bun.lockb": "" }),
    ).toEqual(["bun run dev", "bun run test"]);
  });

  it("picks the package manager by lockfile, falling back to npm", async () => {
    expect(
      await commandsOf({
        "/app/package.json": pkg(),
        "/app/pnpm-lock.yaml": "",
      }),
    ).toEqual(["pnpm run dev", "pnpm run test"]);
    expect(
      await commandsOf({ "/app/package.json": pkg(), "/app/yarn.lock": "" }),
    ).toEqual(["yarn dev", "yarn test"]);
    expect(
      await commandsOf({
        "/app/package.json": pkg(),
        "/app/package-lock.json": "",
      }),
    ).toEqual(["npm run dev", "npm run test"]);
    expect(await commandsOf({ "/app/package.json": pkg() })).toEqual([
      "npm run dev",
      "npm run test",
    ]);
  });

  it("prefers package.json's packageManager field over lockfiles", async () => {
    expect(
      await commandsOf({
        "/app/package.json": pkg({ packageManager: "bun@1.2.0" }),
        "/app/pnpm-lock.yaml": "",
      }),
    ).toEqual(["bun run dev", "bun run test"]);
    expect(
      await commandsOf({
        "/app/package.json": pkg({ packageManager: "yarn@4.1.0" }),
      }),
    ).toEqual(["yarn dev", "yarn test"]);
  });

  it("ignores an unknown packageManager and falls through to lockfiles", async () => {
    expect(
      await commandsOf({
        "/app/package.json": pkg({ packageManager: "deno@2.0.0" }),
        "/app/bun.lock": "",
      }),
    ).toEqual(["bun run dev", "bun run test"]);
  });
});
