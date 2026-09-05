import { describe, it, expect } from "vitest";
import {
  applyDrop,
  buildSidebarItems,
  flattenRows,
  insertFolderBefore,
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

function folder(id: string, name = id.toUpperCase()): WorkspaceFolder {
  return { id, name };
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

/** Compact shape of a tree: loose paths, folders as `id[members]`. */
function shape(items: SidebarItem[]): string[] {
  return items.map((item) =>
    item.kind === "workspace"
      ? item.ws.path
      : `${item.folder.id}[${item.workspaces.map((w) => w.path).join(",")}]`,
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
});

describe("flattenRows", () => {
  const items = buildSidebarItems(
    project(
      [ws("/a"), ws("/m1", "f1"), ws("/m2", "f1"), ws("/b")],
      [folder("f1")],
      ["/a", "f1", "/m1", "/m2", "/b"],
    ),
  );

  it("emits one row per top-level item when dragging a folder", () => {
    expect(flattenRows(items, new Set(), "folder")).toEqual([
      { key: "/a", kind: "workspace", parentFolderId: null },
      { key: "f1", kind: "folder", parentFolderId: null },
      { key: "/b", kind: "workspace", parentFolderId: null },
    ]);
  });

  it("emits header plus member rows in tree order when dragging a workspace", () => {
    expect(flattenRows(items, new Set(), "workspace")).toEqual([
      { key: "/a", kind: "workspace", parentFolderId: null },
      { key: "f1", kind: "folder", parentFolderId: null },
      { key: "/m1", kind: "workspace", parentFolderId: "f1" },
      { key: "/m2", kind: "workspace", parentFolderId: "f1" },
      { key: "/b", kind: "workspace", parentFolderId: null },
    ]);
  });

  it("hides members of a collapsed folder", () => {
    expect(
      flattenRows(items, new Set(["f1"]), "workspace").map((r) => r.key),
    ).toEqual(["/a", "f1", "/b"]);
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

  it("reorders folders among top-level items", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder");
    expect(
      shape(applyDrop(tree, "f1", { type: "slot", rowIndex: 2 }, rows)),
    ).toEqual(["/local", "f2[/x]", "f1[/m1,/m2]"]);
  });

  it("moves a folder above the first workspace, members in tow", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder");
    const next = applyDrop(tree, "f1", { type: "slot", rowIndex: 0 }, rows);
    expect(shape(next)).toEqual(["f1[/m1,/m2]", "/local", "f2[/x]"]);
    expect(membershipOf(next).get("/m1")).toBe("f1");
  });

  it("never nests a folder inside another folder", () => {
    const tree = items();
    const rows = flattenRows(tree, new Set(), "folder");
    expect(applyDrop(tree, "f1", { type: "into", folderId: "f2" }, rows)).toBe(
      tree,
    );
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

  it("round-trips through buildSidebarItems", () => {
    const workspaces = [
      ws("/a"),
      ws("/m1", "f1"),
      ws("/m2", "f1"),
      ws("/b"),
      ws("/x", "f2"),
    ];
    const folders = [folder("f1"), folder("f2")];
    const p = project(workspaces, folders, [
      "/a",
      "f1",
      "/m1",
      "/m2",
      "f2",
      "/x",
      "/b",
    ]);
    const items = buildSidebarItems(p);
    const rows = flattenRows(items, new Set(), "workspace");
    const next = applyDrop(items, "/b", { type: "slot", rowIndex: 2 }, rows);
    const order = serializeOrder(next, p);

    const membership = membershipOf(next);
    const rebuilt = buildSidebarItems({
      workspaces: workspaces.map((w) =>
        membership.has(w.path) ? { ...w, folderId: membership.get(w.path)! } : w,
      ),
      folders,
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
        [ws("/a"), ws("/m1", "f1")],
        [folder("f1")],
        ["/a", "f1", "/m1"],
      ),
    );
    expect([...membershipOf(items)]).toEqual([
      ["/a", null],
      ["/m1", "f1"],
    ]);
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

  it("insertFolderBefore takes the anchor row's top-level slot", () => {
    expect(shape(insertFolderBefore(tree(), folder("f3"), "/b"))).toEqual([
      "/a",
      "f1[/m1]",
      "f3[]",
      "/b",
      "f2[]",
    ]);
  });

  it("insertFolderBefore uses the folder holding the anchor", () => {
    expect(shape(insertFolderBefore(tree(), folder("f3"), "/m1"))).toEqual([
      "/a",
      "f3[]",
      "f1[/m1]",
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
});
