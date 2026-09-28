import { describe, expect, it } from "vitest";
import { LastKnownWorkspaces } from "./project-info";
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
