import { beforeEach, describe, expect, it } from "vitest";
import { prEqual, useProjectStore } from "../project-store";
import type { PrInfo } from "../../lib/pr-info";
import { workspaceKey } from "../../lib/workspace-key";

function basePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    state: "open",
    title: "Rotate signing keys",
    url: "https://github.com/acme/app/pull/42",
    isDraft: false,
    additions: 10,
    deletions: 2,
    reviewDecision: "APPROVED",
    checks: { total: 2, passing: 2, failing: 0, pending: 0 },
    unresolvedThreads: 0,
    commentCount: 0,
    ...overrides,
  };
}

describe("prEqual", () => {
  // Arming auto-merge changes nothing else about the PR, so an equality check
  // that skips `queuedToMerge` drops the update and the badge never turns.
  it("sees a PR that only became queued to merge", () => {
    expect(prEqual(basePr(), basePr({ queuedToMerge: true }))).toBe(false);
  });

  // A base branch moving on can make a PR conflict without touching anything
  // else the store compares.
  it("sees a PR that only started conflicting", () => {
    expect(prEqual(basePr(), basePr({ hasConflicts: true }))).toBe(false);
  });

  it("treats identical PRs as equal", () => {
    expect(prEqual(basePr(), basePr())).toBe(true);
  });
});

describe("workspace updates by key", () => {
  const PATH = "/tmp/wt/feature";
  const local = workspaceKey("local", PATH);
  const box = workspaceKey("box", PATH);

  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        {
          id: "l",
          path: "/tmp/repo",
          name: "app",
          workspaces: [{ path: PATH, branch: "feature", diffStats: { added: 3, removed: 1 } }],
        },
        {
          id: "r",
          path: "/tmp/repo",
          name: "app",
          hostId: "box",
          workspaces: [{ path: PATH, branch: "feature" }],
        },
      ],
    } as never);
  });

  const ws = (i: number) => useProjectStore.getState().projects[i].workspaces[0];

  it("updates only the workspace on the key's host", () => {
    useProjectStore.getState().updateWorkspaceBranch(box, "other");
    useProjectStore.getState().updateWorkspacePr(box, basePr());
    expect(ws(0).branch).toBe("feature");
    expect(ws(0).pr).toBeUndefined();
    expect(ws(1).branch).toBe("other");
    expect(ws(1).pr?.number).toBe(42);
  });

  // useDiffWatcher re-applies cached stats whenever `projects` changes, so a
  // no-op update must keep the same state or it loops forever.
  it("keeps the projects reference on no-op updates", () => {
    const before = useProjectStore.getState().projects;
    const store = useProjectStore.getState();
    store.updateWorkspaceDiffStats(local, { added: 3, removed: 1 });
    store.updateWorkspaceBranch(local, "feature");
    store.updateWorkspaceDiffStats(box, null);
    store.updateWorkspaceBranch(workspaceKey("local", "/nope"), "x");
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("stores changed diff stats on that host only", () => {
    useProjectStore.getState().updateWorkspaceDiffStats(local, { added: 5, removed: 0 });
    expect(ws(0).diffStats).toEqual({ added: 5, removed: 0 });
    expect(ws(1).diffStats).toBeUndefined();
  });
});
