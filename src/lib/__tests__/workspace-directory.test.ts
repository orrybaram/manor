import { describe, it, expect } from "vitest";
import {
  find,
  hostForPath,
  keyOf,
  ownerOf,
  patch,
  reconcile,
} from "../workspace-directory";
import { workspaceKey } from "../workspace-key";
import { HOME_PATH } from "../home-path";

// The same repo at the same paths on this machine and on "box", as two
// projects (same username, same default roots).
const SHARED = "/home/me/.manor/worktrees/app/feat";
const MAIN = "/home/me/app";

interface Ws {
  path: string;
  branch: string | null;
  pr?: { number: number } | null;
  diffStats?: { added: number } | null;
}

function project(id: string, hostId: string, workspaces: Ws[]) {
  return { id, path: MAIN, hostId, workspaces };
}

function shared() {
  return [
    project("p-local", "local", [
      { path: MAIN, branch: "main" },
      { path: SHARED, branch: "feat" },
    ]),
    project("p-box", "box", [
      { path: MAIN, branch: "main" },
      { path: SHARED, branch: "feat" },
    ]),
  ];
}

const LOCAL_KEY = workspaceKey("local", SHARED);
const BOX_KEY = workspaceKey("box", SHARED);

describe("keyOf", () => {
  it("keys a workspace by its project's host", () => {
    const [local, box] = shared();
    expect(keyOf(local, local.workspaces[1])).toBe(SHARED);
    expect(keyOf(box, box.workspaces[1])).toBe(`box:${SHARED}`);
  });

  it("reads a project with no host as local", () => {
    expect(keyOf({ hostId: undefined }, { path: SHARED })).toBe(SHARED);
  });
});

describe("find", () => {
  it("finds the workspace on the key's host, with its index", () => {
    const projects = shared();
    const found = find(projects, BOX_KEY);
    expect(found?.project.id).toBe("p-box");
    expect(found?.workspace).toBe(projects[1].workspaces[1]);
    expect(found?.index).toBe(1);
    expect(find(projects, LOCAL_KEY)?.project.id).toBe("p-local");
  });

  it("is undefined for a host no project is on", () => {
    expect(find(shared(), workspaceKey("other", SHARED))).toBeUndefined();
  });
});

describe("ownerOf", () => {
  it("finds the project on the key's host, whichever is listed first", () => {
    const projects = shared();
    expect(ownerOf(projects, LOCAL_KEY)?.id).toBe("p-local");
    expect(ownerOf(projects, BOX_KEY)?.id).toBe("p-box");
  });

  it("matches the main checkout path even when it isn't listed", () => {
    const bare = { id: "p-bare", path: MAIN, hostId: "box", workspaces: [] };
    expect(ownerOf([bare], workspaceKey("box", MAIN))).toBe(bare);
  });

  it("reads a project with no host as local", () => {
    const hostless = { id: "p", path: MAIN, workspaces: [{ path: SHARED }] };
    expect(ownerOf([hostless], SHARED)).toBe(hostless);
  });

  it("is undefined for Home, no key, or a host no project is on", () => {
    const projects = shared();
    expect(ownerOf(projects, HOME_PATH)).toBeUndefined();
    expect(ownerOf(projects, null)).toBeUndefined();
    expect(ownerOf(projects, `other:${SHARED}`)).toBeUndefined();
  });
});

describe("patch", () => {
  it("same path on two hosts: patching one leaves the other alone", () => {
    const projects = shared();
    const next = patch(projects, BOX_KEY, (ws) => ({ ...ws, pr: { number: 7 } }));
    expect(next[1].workspaces[1].pr).toEqual({ number: 7 });
    expect(next[0]).toBe(projects[0]);
    expect(next[0].workspaces[1].pr).toBeUndefined();
    // Other workspaces of the patched project keep their identity.
    expect(next[1].workspaces[0]).toBe(projects[1].workspaces[0]);
  });

  it("patches a local key on the local project only", () => {
    const projects = shared();
    const next = patch(projects, LOCAL_KEY, (ws) => ({ ...ws, branch: "renamed" }));
    expect(next[0].workspaces[1].branch).toBe("renamed");
    expect(next[1]).toBe(projects[1]);
  });

  it("returns the same array when fn returns the workspace unchanged", () => {
    const projects = shared();
    expect(patch(projects, BOX_KEY, (ws) => ws)).toBe(projects);
  });

  it("returns the same array when no workspace has the key", () => {
    const projects = shared();
    const fn = (ws: Ws) => ({ ...ws, branch: "x" });
    expect(patch(projects, workspaceKey("other", SHARED), fn)).toBe(projects);
    expect(patch(projects, workspaceKey("box", "/nowhere"), fn)).toBe(projects);
  });
});

describe("reconcile", () => {
  const pr = { number: 1 };
  const stats = { added: 3 };

  function withWatched(hostId: string) {
    return shared().map((p) =>
      p.hostId === hostId
        ? {
            ...p,
            workspaces: p.workspaces.map((w) =>
              w.path === SHARED ? { ...w, pr, diffStats: stats } : w,
            ),
          }
        : p,
    );
  }

  it("keeps the PR and diff stats when key and branch match", () => {
    const next = reconcile(shared(), withWatched("box"));
    expect(next[1].workspaces[1].pr).toBe(pr);
    expect(next[1].workspaces[1].diffStats).toBe(stats);
  });

  it("doesn't carry one host's PR to the other host's same path", () => {
    const next = reconcile(shared(), withWatched("box"));
    expect(next[0].workspaces[1].pr).toBeUndefined();
    expect(next[0].workspaces[1].diffStats).toBeUndefined();
  });

  it("drops the PR when the branch changed", () => {
    const fresh = shared();
    fresh[1].workspaces[1].branch = "other";
    const next = reconcile(fresh, withWatched("box"));
    expect(next[1].workspaces[1].pr).toBeUndefined();
  });

  it("matches branches case-insensitively", () => {
    const fresh = shared();
    fresh[1].workspaces[1].branch = "FEAT";
    expect(reconcile(fresh, withWatched("box"))[1].workspaces[1].pr).toBe(pr);
  });

  it("keeps a value the fresh list already has", () => {
    const fresh = shared();
    const newer = { number: 2 };
    fresh[1].workspaces[1].pr = newer;
    expect(reconcile(fresh, withWatched("box"))[1].workspaces[1].pr).toBe(newer);
  });
});

describe("hostForPath", () => {
  const projects = shared();

  it("follows the selected project when two hosts have the path", () => {
    expect(hostForPath({ projects, selectedProjectIndex: 1 }, SHARED)).toBe("box");
    expect(hostForPath({ projects, selectedProjectIndex: 0 }, SHARED)).toBe("local");
  });

  it("falls back to the first project with the path", () => {
    const other = { id: "p-x", path: "/x", hostId: "box", workspaces: [] };
    expect(hostForPath({ projects: [...projects, other], selectedProjectIndex: 2 }, SHARED)).toBe(
      "local",
    );
  });

  it("puts Home on this machine", () => {
    expect(hostForPath({ projects, selectedProjectIndex: 1 }, HOME_PATH)).toBe("local");
  });

  it("is undefined for a path no project has, so main guesses from it", () => {
    expect(hostForPath({ projects, selectedProjectIndex: 1 }, "/tmp")).toBeUndefined();
    expect(hostForPath({ projects, selectedProjectIndex: 1 }, null)).toBeUndefined();
  });
});
