import { describe, it, expect } from "vitest";
import { buildFileTree } from "../FileTree/file-tree";
import { expandedForOpenFile, visibleTreeRows } from "./drawer-tree";

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
