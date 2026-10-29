import { describe, expect, it } from "vitest";
import type { ChangeStatus, FileChange } from "../file-changes";
import {
  branchEntries,
  localGroups,
  scmLetter,
  scmTree,
  withStaged,
  type ScmNode,
} from "./scm-entries";

const change = (
  path: string,
  status: ChangeStatus = "modified",
): FileChange => ({
  path,
  status,
  ranges: [],
});

describe("scmLetter", () => {
  it("reads a new, unstaged file in the Local view as untracked", () => {
    expect(scmLetter(change("a.ts", "added"), false, "local")).toBe("U");
    expect(scmLetter(change("a.ts", "added"), true, "local")).toBe("A");
  });

  it("reads a new file on the branch as added", () => {
    expect(scmLetter(change("a.ts", "added"), false, "branch")).toBe("A");
  });

  it("reads the other statuses by their badge", () => {
    expect(scmLetter(change("a.ts", "modified"), false, "local")).toBe("M");
    expect(scmLetter(change("a.ts", "deleted"), true, "local")).toBe("D");
    expect(scmLetter(change("a.ts", "renamed"), false, "branch")).toBe("R");
  });
});

describe("localGroups", () => {
  it("puts staged files in Staged and the rest in Changes, each by path", () => {
    const groups = localGroups(
      [
        change("z.ts"),
        change("b.ts", "added"),
        change("a.ts", "added"),
        change("c.ts"),
      ],
      new Set(["c.ts", "a.ts"]),
    );
    expect(groups.staged.map((e) => [e.change.path, e.letter])).toEqual([
      ["a.ts", "A"],
      ["c.ts", "M"],
    ]);
    expect(groups.changes.map((e) => [e.change.path, e.letter])).toEqual([
      ["b.ts", "U"],
      ["z.ts", "M"],
    ]);
  });

  it("keeps a staged path the working diff no longer lists, as M, so it can be unstaged", () => {
    const groups = localGroups(
      [change("a.ts"), change("c.ts")],
      new Set(["c.ts", "b.ts"]),
    );
    expect(groups.staged.map((e) => [e.change.path, e.letter])).toEqual([
      ["b.ts", "M"],
      ["c.ts", "M"],
    ]);
    expect(groups.changes.map((e) => e.change.path)).toEqual(["a.ts"]);
  });
});

describe("branchEntries", () => {
  it("lists every file by path", () => {
    expect(
      branchEntries([change("b.ts", "added"), change("a.ts")]).map(
        (e) => e.letter,
      ),
    ).toEqual(["M", "A"]);
  });
});

describe("withStaged", () => {
  it("stages and unstages without touching the set it was given", () => {
    const before = new Set(["a.ts"]);
    expect([...withStaged(before, ["b.ts"], true)].sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect([...withStaged(before, ["a.ts"], false)]).toEqual([]);
    expect([...before]).toEqual(["a.ts"]);
  });
});

describe("scmTree", () => {
  const shape = (nodes: ScmNode[]): unknown[] =>
    nodes.map((n) =>
      n.kind === "dir" ? { [n.name]: shape(n.children) } : n.entry.change.path,
    );

  it("nests files under folders, folders first, and folds single-folder chains", () => {
    const entries = branchEntries([
      change("README.md"),
      change("apps/desktop/electron/b.ts"),
      change("apps/desktop/electron/a.ts"),
      change("apps/desktop/electron/__tests__/a.test.ts"),
      change("apps/web/x.ts"),
    ]);
    expect(shape(scmTree(entries))).toEqual([
      {
        apps: [
          {
            "desktop/electron": [
              { __tests__: ["apps/desktop/electron/__tests__/a.test.ts"] },
              "apps/desktop/electron/a.ts",
              "apps/desktop/electron/b.ts",
            ],
          },
          { web: ["apps/web/x.ts"] },
        ],
      },
      "README.md",
    ]);
  });

  it("gives a folded folder its full path", () => {
    const [dir] = scmTree(branchEntries([change("a/b/c/d.ts")]));
    expect(dir).toMatchObject({ kind: "dir", path: "a/b/c", name: "a/b/c" });
  });
});
