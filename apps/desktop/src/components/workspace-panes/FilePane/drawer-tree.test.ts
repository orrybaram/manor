import { describe, it, expect } from "vitest";
import { buildFileTree } from "../FileTree/file-tree";
import {
  cursorIndex,
  expandedForFiles,
  expandedForOpenFile,
  treeKey,
  visibleTreeRows,
} from "./drawer-tree";

const tree = buildFileTree(
  [
    "README.md",
    "apps/desktop/package.json",
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/components/workspace-panes/LeafPane.tsx",
    "apps/desktop/src/components/workspace-panes/FilePane/FilePane.tsx",
    "apps/relay/src/index.ts",
    "docs/guide.md",
  ].map((path) => ({ path })),
);

describe("expandedForOpenFile", () => {
  it("opens only the folders on the way to the open file", () => {
    const expanded = expandedForOpenFile(
      tree,
      "apps/desktop/src/components/workspace-panes/FilePane/FilePane.tsx",
    );
    expect([...expanded]).toEqual([
      "apps",
      "apps/desktop",
      "apps/desktop/src",
      // A compressed chain is one folder, known by its deepest path.
      "apps/desktop/src/components/workspace-panes",
      "apps/desktop/src/components/workspace-panes/FilePane",
    ]);
  });

  it("starts every folder collapsed with no file open", () => {
    expect(expandedForOpenFile(tree, null).size).toBe(0);
  });

  it("opens nothing for a top-level file", () => {
    expect(expandedForOpenFile(tree, "README.md").size).toBe(0);
  });

  it("opens as far as the tree goes for a file it doesn't list", () => {
    expect([...expandedForOpenFile(tree, "apps/desktop/src/new/thing.ts")]).toEqual([
      "apps",
      "apps/desktop",
      "apps/desktop/src",
    ]);
  });

  it("does not mistake a sibling with a shared prefix for an ancestor", () => {
    const t = buildFileTree([{ path: "app/a.ts" }, { path: "apps/b.ts" }]);
    expect([...expandedForOpenFile(t, "apps/b.ts")]).toEqual(["apps"]);
  });
});

describe("visibleTreeRows", () => {
  it("shows the top level only when nothing is open", () => {
    const rows = visibleTreeRows(tree, new Set());
    expect(rows.map((r) => [r.kind, r.name, r.depth])).toEqual([
      ["dir", "apps", 0],
      ["dir", "docs", 0],
      ["file", "README.md", 0],
    ]);
  });

  it("walks into open folders, depth-first", () => {
    const rows = visibleTreeRows(tree, expandedForOpenFile(tree, "apps/desktop/src/App.tsx"));
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`)).toEqual([
      "apps",
      "  desktop",
      // Folders and files sort together, as the shared tree sorts them.
      "    package.json",
      "    src",
      "      App.tsx",
      "      components/workspace-panes",
      "  relay/src",
      "docs",
      "README.md",
    ]);
    expect(rows.find((r) => r.name === "src")).toMatchObject({ kind: "dir", expanded: true });
    expect(rows.find((r) => r.name === "App.tsx")).toMatchObject({
      kind: "file",
      path: "apps/desktop/src/App.tsx",
    });
  });
});

describe("expandedForFiles", () => {
  it("opens the folders on the way to the open file and to each changed file", () => {
    const expanded = expandedForFiles(tree, "docs/guide.md", ["apps/relay/src/index.ts"]);
    expect([...expanded].sort()).toEqual(["apps", "apps/relay/src", "docs"].sort());
  });

  it("opens nothing more for a changed file that is not in the tree", () => {
    expect(expandedForFiles(tree, null, ["gone/away.ts"]).size).toBe(0);
  });
});

describe("treeKey", () => {
  // apps/ (open), apps/desktop/ (closed), apps/relay/ (open), index.ts, docs/, README.md
  const rows = visibleTreeRows(tree, new Set(["apps", "apps/relay", "apps/relay/src"]));
  const at = (path: string) => rows.findIndex((r) => r.path === path);

  it("moves with the arrows, stopping at either end", () => {
    expect(treeKey(rows, 0, "ArrowDown")).toEqual({ kind: "move", index: 1 });
    expect(treeKey(rows, 0, "ArrowUp")).toEqual({ kind: "move", index: 0 });
    expect(treeKey(rows, rows.length - 1, "ArrowDown")).toEqual({
      kind: "move",
      index: rows.length - 1,
    });
    expect(treeKey(rows, 3, "Home")).toEqual({ kind: "move", index: 0 });
    expect(treeKey(rows, 0, "End")).toEqual({ kind: "move", index: rows.length - 1 });
  });

  it("opens a closed folder with →, then steps into it", () => {
    expect(treeKey(rows, at("apps/desktop"), "ArrowRight")).toEqual({
      kind: "toggle",
      index: at("apps/desktop"),
    });
    expect(treeKey(rows, at("apps"), "ArrowRight")).toEqual({
      kind: "move",
      index: at("apps") + 1,
    });
  });

  it("closes an open folder with ←, else steps out to its folder", () => {
    expect(treeKey(rows, at("apps"), "ArrowLeft")).toEqual({ kind: "toggle", index: at("apps") });
    expect(treeKey(rows, at("apps/relay/src/index.ts"), "ArrowLeft")).toEqual({
      kind: "move",
      index: at("apps/relay/src"),
    });
    expect(treeKey(rows, at("README.md"), "ArrowLeft")).toBeNull();
  });

  it("opens a file, and opens or closes a folder, with Enter or Space", () => {
    expect(treeKey(rows, at("README.md"), "Enter")).toEqual({
      kind: "open",
      index: at("README.md"),
    });
    expect(treeKey(rows, at("docs"), " ")).toEqual({ kind: "toggle", index: at("docs") });
  });

  it("leaves other keys alone", () => {
    expect(treeKey(rows, 0, "a")).toBeNull();
  });
});

describe("cursorIndex", () => {
  const rows = visibleTreeRows(tree, new Set(["apps"]));

  it("finds the cursor's row", () => {
    expect(cursorIndex(rows, "README.md")).toBe(rows.findIndex((r) => r.path === "README.md"));
  });

  it("falls back to the folder a hidden cursor is in", () => {
    expect(cursorIndex(rows, "apps/relay/src/index.ts")).toBe(
      rows.findIndex((r) => r.kind === "dir" && r.path.startsWith("apps/relay")),
    );
  });

  it("starts on the first row with no cursor", () => {
    expect(cursorIndex(rows, null)).toBe(0);
  });
});
