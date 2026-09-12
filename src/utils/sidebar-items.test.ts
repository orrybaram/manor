import { describe, it, expect } from "vitest";
import {
  applyDrop,
  buildSidebarItems,
  descendantWorkspaces,
  flattenRows,
  folderParentsOf,
  insertFolderBefore,
  isFolderDescendant,
  membershipOf,
  placeAfterFolder,
  placeInFolder,
  serializeOrder,
  type SidebarItem,
} from "./sidebar-items";
import type {
  ProjectInfo,
  WorkspaceFolder,
  WorkspaceInfo,
} from "../store/project-store";

function ws(
  path: string,
  folderId?: string | null,
  hidden?: boolean,
): WorkspaceInfo {
  return {
    path,
    branch: path,
    isMain: false,
    name: null,
    folderId: folderId ?? null,
    hidden,
  };
}

function folder(
  id: string,
  parentId: string | null = null,
  name = id.toUpperCase(),
): WorkspaceFolder {
  return { id, name, parentId };
}

type MinimalProject = Pick<
  ProjectInfo,
  "workspaces" | "folders" | "sidebarOrder"
>;

function project(
  workspaces: WorkspaceInfo[],
  folders: WorkspaceFolder[],
  sidebarOrder: string[],
): MinimalProject {
  return { workspaces, folders, sidebarOrder };
}

/** Compact shape of a tree: loose paths, folders as `id[children]`. */
function shape(items: SidebarItem[]): string[] {
  return items.map((item) =>
    item.kind === "workspace"
      ? item.ws.path
      : `${item.folder.id}[${shape(item.children).join(",")}]`,
  );
}

describe("buildSidebarItems", () => {
  it("respects sidebarOrder for loose workspaces and folders", () => {
    const p = project(
      [ws("/a"), ws("/b"), ws("/m", "f1")],
      [folder("f1")],
      ["/b", "f1", "/m", "/a"],
    );
    expect(shape(buildSidebarItems(p))).toEqual(["/b", "f1[/m]", "/a"]);
  });

  it("excludes hidden workspaces from loose rows and folder members", () => {
    const p = project(
      [ws("/a"), ws("/h", null, true), ws("/m", "f1"), ws("/hm", "f1", true)],
      [folder("f1")],
      ["/a", "/h", "f1", "/m", "/hm"],
    );
    expect(shape(buildSidebarItems(p))).toEqual(["/a", "f1[/m]"]);
  });

  it("keeps folders with no members", () => {
    const p = project([ws("/a")], [folder("f1")], ["f1", "/a"]);
    expect(shape(buildSidebarItems(p))).toEqual(["f1[]", "/a"]);
  });

  it("treats a workspace with a stale folder id as loose", () => {
    const p = project([ws("/a", "gone")], [folder("f1")], ["/a", "f1"]);
    expect(shape(buildSidebarItems(p))).toEqual(["/a", "f1[]"]);
  });

  it("orders folder members by their sidebarOrder index", () => {
    const p = project(
      [ws("/m1", "f1"), ws("/m2", "f1"), ws("/m3", "f1")],
      [folder("f1")],
      ["f1", "/m3", "/m1", "/m2"],
    );
    expect(shape(buildSidebarItems(p))).toEqual(["f1[/m3,/m1,/m2]"]);
  });

  it("puts members missing from the order last, in project order", () => {
    const p = project(
      [ws("/m1", "f1"), ws("/m2", "f1"), ws("/m3", "f1")],
      [folder("f1")],
      ["f1", "/m3"],
    );
    expect(shape(buildSidebarItems(p))).toEqual(["f1[/m3,/m1,/m2]"]);
  });

  it("appends entries missing from the order: workspaces then folders", () => {
    const p = project([ws("/a"), ws("/b")], [folder("f1")], ["/b"]);
    expect(shape(buildSidebarItems(p))).toEqual(["/b", "/a", "f1[]"]);
  });

  it("nests folders by parentId, ordered by sidebarOrder", () => {
    const p = project(
      [ws("/a"), ws("/api", "f-api"), ws("/ui", "f-ui"), ws("/top", "f-epic")],
      [folder("f-epic"), folder("f-api", "f-epic"), folder("f-ui", "f-epic")],
      ["f-epic", "/top", "f-api", "/api", "f-ui", "/ui", "/a"],
    );
    expect(shape(buildSidebarItems(p))).toEqual([
      "f-epic[/top,f-api[/api],f-ui[/ui]]",
      "/a",
    ]);
  });

  it("interleaves a nested folder with its siblings by order index", () => {
    const p = project(
      [ws("/m1", "f1"), ws("/m2", "f1"), ws("/deep", "f2")],
      [folder("f1"), folder("f2", "f1")],
      ["f1", "/m1", "f2", "/deep", "/m2"],
    );
    expect(shape(buildSidebarItems(p))).toEqual(["f1[/m1,f2[/deep],/m2]"]);
  });

  it("surfaces a folder whose parent no longer exists", () => {
    const p = project([ws("/m", "f1")], [folder("f1", "gone")], ["f1", "/m"]);
    expect(shape(buildSidebarItems(p))).toEqual(["f1[/m]"]);
  });

  it("renders both folders of a parent cycle at the top level", () => {
    // Main normalizes a dangling or self-referential parent, but a
    // hand-corrupted file can still hold A → B → A. Neither folder may
    // vanish, and the build must terminate.
    const p = project(
      [ws("/a", "fa"), ws("/b", "fb")],
      [folder("fa", "fb"), folder("fb", "fa")],
      ["fa", "/a", "fb", "/b"],
    );
    expect(shape(buildSidebarItems(p))).toEqual(["fa[/a]", "fb[/b]"]);
  });
});

describe("flattenRows", () => {
  const items = buildSidebarItems(
    project(
      [ws("/a"), ws("/m1", "f1"), ws("/m2", "f1"), ws("/b")],
      [folder("f1")],
      ["/a", "f1", "/m1", "/m2", "/b"],
    ),
  );

  const nested = buildSidebarItems(
    project(
      [ws("/a"), ws("/m1", "f1"), ws("/deep", "f2")],
      [folder("f1"), folder("f2", "f1")],
      ["/a", "f1", "/m1", "f2", "/deep"],
    ),
  );

  it("emits one row per top-level item when dragging a folder", () => {
    expect(flattenRows(items, new Set(), "folder", "f1")).toEqual([
      { key: "/a", kind: "workspace", parentFolderId: null, depth: 0 },
      { key: "f1", kind: "folder", parentFolderId: null, depth: 0 },
      { key: "/b", kind: "workspace", parentFolderId: null, depth: 0 },
    ]);
  });

  it("emits header plus member rows in tree order when dragging a workspace", () => {
    expect(flattenRows(items, new Set(), "workspace")).toEqual([
      { key: "/a", kind: "workspace", parentFolderId: null, depth: 0 },
      { key: "f1", kind: "folder", parentFolderId: null, depth: 0 },
      { key: "/m1", kind: "workspace", parentFolderId: "f1", depth: 1 },
      { key: "/m2", kind: "workspace", parentFolderId: "f1", depth: 1 },
      { key: "/b", kind: "workspace", parentFolderId: null, depth: 0 },
    ]);
  });

  it("hides members of a collapsed folder", () => {
    expect(
      flattenRows(items, new Set(["f1"]), "workspace").map((r) => r.key),
    ).toEqual(["/a", "f1", "/b"]);
  });

  it("recurses into nested folders for a workspace drag", () => {
    expect(flattenRows(nested, new Set(), "workspace")).toEqual([
      { key: "/a", kind: "workspace", parentFolderId: null, depth: 0 },
      { key: "f1", kind: "folder", parentFolderId: null, depth: 0 },
      { key: "/m1", kind: "workspace", parentFolderId: "f1", depth: 1 },
      { key: "f2", kind: "folder", parentFolderId: "f1", depth: 1 },
      { key: "/deep", kind: "workspace", parentFolderId: "f2", depth: 2 },
    ]);
  });

  it("offers other folders' headers to a folder drag, members aside", () => {
    expect(flattenRows(nested, new Set(), "folder", "f2")).toEqual([
      { key: "/a", kind: "workspace", parentFolderId: null, depth: 0 },
      { key: "f1", kind: "folder", parentFolderId: null, depth: 0 },
      { key: "f2", kind: "folder", parentFolderId: "f1", depth: 1 },
    ]);
  });

  it("keeps the dragged folder's row but not its subtree", () => {
    expect(
      flattenRows(nested, new Set(), "folder", "f1").map((r) => r.key),
    ).toEqual(["/a", "f1"]);
  });
});

describe("applyDrop — workspace source", () => {
  const nested = () =>
    buildSidebarItems(
      project(
        [ws("/a"), ws("/m1", "f1"), ws("/m2", "f1"), ws("/b")],
        [folder("f1")],
        ["/a", "f1", "/m1", "/m2", "/b"],
      ),
    );

  it("reorders loose workspaces", () => {
    const items = buildSidebarItems(
      project([ws("/a"), ws("/b"), ws("/c")], [], ["/a", "/b", "/c"]),
    );
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "slot", rowIndex: 2 }, rows)),
    ).toEqual(["/b", "/c", "/a"]);
  });

  it("moves a loose workspace into a folder via an `into` target", () => {
    const items = nested();
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "into", folderId: "f1" }, rows)),
    ).toEqual(["f1[/m1,/m2,/a]", "/b"]);
  });

  it("lands first inside an expanded folder when dropped after its header", () => {
    const items = nested();
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "slot", rowIndex: 1 }, rows)),
    ).toEqual(["f1[/a,/m1,/m2]", "/b"]);
  });

  it("stays inside the folder when dropped after its last member", () => {
    const items = nested();
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "slot", rowIndex: 3 }, rows)),
    ).toEqual(["f1[/m1,/m2,/a]", "/b"]);
  });

  it("lands loose after a collapsed folder header", () => {
    const items = nested();
    const rows = flattenRows(items, new Set(["f1"]), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "slot", rowIndex: 1 }, rows)),
    ).toEqual(["f1[/m1,/m2]", "/a", "/b"]);
  });

  it("pulls a member out of its folder when dropped at index 0", () => {
    const items = nested();
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/m1", { type: "slot", rowIndex: 0 }, rows)),
    ).toEqual(["/m1", "/a", "f1[/m2]", "/b"]);
  });

  it("keeps the folder open when its only member is dragged within it", () => {
    const items = buildSidebarItems(
      project([ws("/a"), ws("/m1", "f1")], [folder("f1")], ["/a", "f1", "/m1"]),
    );
    const rows = flattenRows(items, new Set(), "workspace");
    // Landing right after f1's header: the source is the folder's only
    // member, so the folder must still count as expanded and keep it.
    expect(
      shape(applyDrop(items, "/m1", { type: "slot", rowIndex: 2 }, rows)),
    ).toEqual(["/a", "f1[/m1]"]);
  });

  it("moves a member into another folder", () => {
    const items = buildSidebarItems(
      project(
        [ws("/m1", "f1"), ws("/m2", "f1"), ws("/x", "f2")],
        [folder("f1"), folder("f2")],
        ["f1", "/m1", "/m2", "f2", "/x"],
      ),
    );
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/m1", { type: "slot", rowIndex: 4 }, rows)),
    ).toEqual(["f1[/m2]", "f2[/x,/m1]"]);
    // One slot higher lands on f2's header, i.e. as its first member.
    expect(
      shape(applyDrop(items, "/m1", { type: "slot", rowIndex: 3 }, rows)),
    ).toEqual(["f1[/m2]", "f2[/m1,/x]"]);
  });

  it("moves a workspace into a nested folder", () => {
    const items = buildSidebarItems(
      project(
        [ws("/a"), ws("/m1", "f1"), ws("/deep", "f2")],
        [folder("f1"), folder("f2", "f1")],
        ["/a", "f1", "/m1", "f2", "/deep"],
      ),
    );
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "into", folderId: "f2" }, rows)),
    ).toEqual(["f1[/m1,f2[/deep,/a]]"]);
    // Row 3 is f2's header, so the slot after it is f2's first child.
    expect(
      shape(applyDrop(items, "/a", { type: "slot", rowIndex: 3 }, rows)),
    ).toEqual(["f1[/m1,f2[/a,/deep]]"]);
  });

  it("lands beside a nested folder when dropped after its last child", () => {
    const items = buildSidebarItems(
      project(
        [ws("/a"), ws("/m1", "f1"), ws("/deep", "f2")],
        [folder("f1"), folder("f2", "f1")],
        ["/a", "f1", "/m1", "f2", "/deep"],
      ),
    );
    const rows = flattenRows(items, new Set(), "workspace");
    expect(
      shape(applyDrop(items, "/a", { type: "slot", rowIndex: 4 }, rows)),
    ).toEqual(["f1[/m1,f2[/deep,/a]]"]);
  });

  it("ignores a drop into a folder that does not exist", () => {
    const items = nested();
    const rows = flattenRows(items, new Set(), "workspace");
    expect(applyDrop(items, "/a", { type: "into", folderId: "nope" }, rows)).toBe(
      items,
    );
  });
});

describe("applyDrop — folder source", () => {
  const items = () =>
    buildSidebarItems(
      project(
        [ws("/local"), ws("/m1", "f1"), ws("/m2", "f1"), ws("/x", "f2")],
        [folder("f1"), folder("f2")],
        ["/local", "f1", "/m1", "/m2", "f2", "/x"],
      ),
    );

  const deep = () =>
    buildSidebarItems(
      project(
        [ws("/m1", "f1"), ws("/deep", "f2"), ws("/x", "f3")],
        [folder("f1"), folder("f2", "f1"), folder("f3")],
        ["f1", "/m1", "f2", "/deep", "f3", "/x"],
      ),
    );

  it("reorders folders among top-level items", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder", "f1");
    expect(
      shape(applyDrop(tree, "f1", { type: "slot", rowIndex: 2 }, rows)),
    ).toEqual(["/local", "f2[/x]", "f1[/m1,/m2]"]);
  });

  it("moves a folder above the first workspace, members in tow", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder", "f1");
    const next = applyDrop(tree, "f1", { type: "slot", rowIndex: 0 }, rows);
    expect(shape(next)).toEqual(["f1[/m1,/m2]", "/local", "f2[/x]"]);
    expect(membershipOf(next).get("/m1")).toBe("f1");
  });

  it("drops a folder into another folder", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder", "f1");
    const next = applyDrop(tree, "f1", { type: "into", folderId: "f2" }, rows);
    expect(shape(next)).toEqual(["/local", "f2[/x,f1[/m1,/m2]]"]);
    expect(folderParentsOf(next).get("f1")).toBe("f2");
  });

  it("refuses to drop a folder into itself", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder", "f1");
    expect(applyDrop(tree, "f1", { type: "into", folderId: "f1" }, rows)).toBe(
      tree,
    );
  });

  it("refuses to drop a folder into one of its descendants", () => {
    const tree = deep();
    const rows = flattenRows(tree, new Set(), "folder", "f1");
    expect(applyDrop(tree, "f1", { type: "into", folderId: "f2" }, rows)).toBe(
      tree,
    );
  });

  it("promotes a nested folder back to the top level", () => {
    const tree = deep();
    const rows = flattenRows(tree, new Set(), "folder", "f2");
    // Rows: f1, f2, f3. Landing after f3 (index 2 of the rows minus f2's
    // subtree) makes f2 a top-level sibling again.
    const next = applyDrop(tree, "f2", { type: "slot", rowIndex: 2 }, rows);
    expect(shape(next)).toEqual(["f1[/m1]", "f3[/x]", "f2[/deep]"]);
    expect(folderParentsOf(next).get("f2")).toBe(null);
  });
});

describe("serializeOrder", () => {
  it("produces the canonical depth-first order", () => {
    const p = project(
      [ws("/a"), ws("/m1", "f1"), ws("/m2", "f1"), ws("/b")],
      [folder("f1")],
      ["/a", "f1", "/m1", "/m2", "/b"],
    );
    expect(serializeOrder(buildSidebarItems(p), p)).toEqual([
      "/a",
      "f1",
      "/m1",
      "/m2",
      "/b",
    ]);
  });

  it("emits a nested folder inside its parent's run", () => {
    const p = project(
      [ws("/m1", "f1"), ws("/deep", "f2"), ws("/b")],
      [folder("f1"), folder("f2", "f1")],
      ["f1", "/m1", "f2", "/deep", "/b"],
    );
    expect(serializeOrder(buildSidebarItems(p), p)).toEqual([
      "f1",
      "/m1",
      "f2",
      "/deep",
      "/b",
    ]);
  });

  it("appends hidden paths and keeps them stable across successive edits", () => {
    const workspaces = [
      ws("/a"),
      ws("/h1", null, true),
      ws("/b"),
      ws("/h2", null, true),
    ];
    const p1 = project(workspaces, [], ["/a", "/h1", "/b", "/h2"]);
    const items1 = buildSidebarItems(p1);
    const rows = flattenRows(items1, new Set(), "workspace");
    const order1 = serializeOrder(
      applyDrop(items1, "/a", { type: "slot", rowIndex: 1 }, rows),
      p1,
    );
    expect(order1).toEqual(["/b", "/a", "/h1", "/h2"]);

    const p2 = project(workspaces, [], order1);
    const items2 = buildSidebarItems(p2);
    const order2 = serializeOrder(
      applyDrop(
        items2,
        "/b",
        { type: "slot", rowIndex: 1 },
        flattenRows(items2, new Set(), "workspace"),
      ),
      p2,
    );
    expect(order2).toEqual(["/a", "/b", "/h1", "/h2"]);
  });

  it("round-trips a two-level tree through buildSidebarItems", () => {
    const workspaces = [
      ws("/a"),
      ws("/m1", "f1"),
      ws("/deep", "f2"),
      ws("/b"),
      ws("/x", "f3"),
    ];
    const folders = [folder("f1"), folder("f2", "f1"), folder("f3")];
    const p = project(workspaces, folders, [
      "/a",
      "f1",
      "/m1",
      "f2",
      "/deep",
      "f3",
      "/x",
      "/b",
    ]);
    const items = buildSidebarItems(p);
    const rows = flattenRows(items, new Set(), "workspace");
    // /b into f2, the nested folder.
    const next = applyDrop(items, "/b", { type: "into", folderId: "f2" }, rows);
    const order = serializeOrder(next, p);

    const membership = membershipOf(next);
    const parents = folderParentsOf(next);
    const rebuilt = buildSidebarItems({
      workspaces: workspaces.map((w) =>
        membership.has(w.path) ? { ...w, folderId: membership.get(w.path)! } : w,
      ),
      folders: folders.map((f) => ({
        ...f,
        parentId: parents.get(f.id) ?? null,
      })),
      sidebarOrder: order,
    });
    expect(shape(rebuilt)).toEqual(shape(next));
    expect(serializeOrder(rebuilt, { workspaces, sidebarOrder: order })).toEqual(
      order,
    );
  });
});

describe("membershipOf", () => {
  it("maps every workspace in the tree to its folder or null", () => {
    const items = buildSidebarItems(
      project(
        [ws("/a"), ws("/m1", "f1"), ws("/deep", "f2")],
        [folder("f1"), folder("f2", "f1")],
        ["/a", "f1", "/m1", "f2", "/deep"],
      ),
    );
    expect([...membershipOf(items)]).toEqual([
      ["/a", null],
      ["/m1", "f1"],
      ["/deep", "f2"],
    ]);
  });
});

describe("folderParentsOf", () => {
  it("maps every folder to its parent, parents before children", () => {
    const items = buildSidebarItems(
      project(
        [ws("/m1", "f1")],
        [folder("f1"), folder("f2", "f1"), folder("f3", "f2")],
        ["f1", "/m1", "f2", "f3"],
      ),
    );
    expect([...folderParentsOf(items)]).toEqual([
      ["f1", null],
      ["f2", "f1"],
      ["f3", "f2"],
    ]);
  });
});

describe("descendantWorkspaces", () => {
  const items = buildSidebarItems(
    project(
      [ws("/a"), ws("/m1", "f1"), ws("/deep", "f2"), ws("/deeper", "f3")],
      [folder("f1"), folder("f2", "f1"), folder("f3", "f2")],
      ["/a", "f1", "/m1", "f2", "/deep", "f3", "/deeper"],
    ),
  );

  it("collects a folder's whole subtree of workspaces", () => {
    expect(descendantWorkspaces(items[1]).map((w) => w.path)).toEqual([
      "/m1",
      "/deep",
      "/deeper",
    ]);
  });

  it("returns the workspace itself for a loose row", () => {
    expect(descendantWorkspaces(items[0]).map((w) => w.path)).toEqual(["/a"]);
  });
});

describe("isFolderDescendant", () => {
  const items = buildSidebarItems(
    project(
      [ws("/m1", "f1")],
      [folder("f1"), folder("f2", "f1"), folder("f3")],
      ["f1", "/m1", "f2", "f3"],
    ),
  );

  it("counts the folder itself and anything below it", () => {
    expect(isFolderDescendant(items, "f1", "f1")).toBe(true);
    expect(isFolderDescendant(items, "f1", "f2")).toBe(true);
  });

  it("is false for a sibling, an unknown id and null", () => {
    expect(isFolderDescendant(items, "f1", "f3")).toBe(false);
    expect(isFolderDescendant(items, "f1", "gone")).toBe(false);
    expect(isFolderDescendant(items, "f1", null)).toBe(false);
  });
});

describe("placement helpers", () => {
  const tree = () =>
    buildSidebarItems(
      project(
        [ws("/a"), ws("/m1", "f1"), ws("/b")],
        [folder("f1"), folder("f2")],
        ["/a", "f1", "/m1", "/b", "f2"],
      ),
    );

  it("placeInFolder appends the workspace to the folder", () => {
    expect(shape(placeInFolder(tree(), "/a", "f1"))).toEqual([
      "f1[/m1,/a]",
      "/b",
      "f2[]",
    ]);
  });

  it("placeInFolder moves a member between folders", () => {
    expect(shape(placeInFolder(tree(), "/m1", "f2"))).toEqual([
      "/a",
      "f1[]",
      "/b",
      "f2[/m1]",
    ]);
  });

  it("placeInFolder nests a folder inside another folder", () => {
    expect(shape(placeInFolder(tree(), "f2", "f1"))).toEqual([
      "/a",
      "f1[/m1,f2[]]",
      "/b",
    ]);
  });

  it("placeInFolder refuses to nest a folder inside itself", () => {
    const items = tree();
    expect(placeInFolder(items, "f1", "f1")).toBe(items);
  });

  it("placeInFolder ignores an unknown folder", () => {
    const items = tree();
    expect(placeInFolder(items, "/a", "nope")).toBe(items);
  });

  it("placeAfterFolder drops the workspace loose right after the folder", () => {
    expect(shape(placeAfterFolder(tree(), "/m1", "f1"))).toEqual([
      "/a",
      "f1[]",
      "/m1",
      "/b",
      "f2[]",
    ]);
  });

  it("placeAfterFolder lands one level up for a nested folder", () => {
    const items = buildSidebarItems(
      project(
        [ws("/m1", "f1"), ws("/deep", "f2")],
        [folder("f1"), folder("f2", "f1")],
        ["f1", "/m1", "f2", "/deep"],
      ),
    );
    expect(shape(placeAfterFolder(items, "/deep", "f2"))).toEqual([
      "f1[/m1,f2[],/deep]",
    ]);
  });

  it("insertFolderBefore takes a loose anchor's top-level slot", () => {
    expect(shape(insertFolderBefore(tree(), folder("f3"), "/b"))).toEqual([
      "/a",
      "f1[/m1]",
      "f3[]",
      "/b",
      "f2[]",
    ]);
  });

  it("insertFolderBefore claims the anchor's slot inside its own folder", () => {
    expect(shape(insertFolderBefore(tree(), folder("f3", "f1"), "/m1"))).toEqual([
      "/a",
      "f1[f3[],/m1]",
      "/b",
      "f2[]",
    ]);
  });

  it("insertFolderBefore appends when the anchor is unknown", () => {
    expect(shape(insertFolderBefore(tree(), folder("f3"), "/gone"))).toEqual([
      "/a",
      "f1[/m1]",
      "/b",
      "f2[]",
      "f3[]",
    ]);
  });

  it("insertFolderBefore moves an already-present folder instead of duplicating it", () => {
    const items = insertFolderBefore(tree(), folder("f2"), "/a");
    expect(shape(items)).toEqual(["f2[]", "/a", "f1[/m1]", "/b"]);
  });

  it("composes into the New Folder flow: folder in the row's slot, row inside", () => {
    const f3 = folder("f3");
    const items = placeInFolder(
      insertFolderBefore(tree(), f3, "/b"),
      "/b",
      "f3",
    );
    expect(shape(items)).toEqual(["/a", "f1[/m1]", "f3[/b]", "f2[]"]);
  });

  it("composes into the New Folder flow one level down: the group stays nested", () => {
    const f3 = folder("f3", "f1");
    const items = placeInFolder(
      insertFolderBefore(tree(), f3, "/m1"),
      "/m1",
      "f3",
    );
    expect(shape(items)).toEqual(["/a", "f1[f3[/m1]]", "/b", "f2[]"]);
    expect(folderParentsOf(items).get("f3")).toBe("f1");
  });
});
