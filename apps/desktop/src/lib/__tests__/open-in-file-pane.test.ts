import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../layout/pane-tree";
import type { WorkspaceLayout } from "../layout/workspace-layout";

const app = vi.hoisted(() => ({
  workspaceLayouts: {} as Record<string, unknown>,
  filePaths: {} as Record<string, string>,
  focusPane: vi.fn(),
  setPaneFilePath: vi.fn(),
  splitPaneAt: vi.fn(() => "new-file-pane"),
  addFileTab: vi.fn(() => ({ tabId: "t-new", paneId: "tab-file-pane" })),
}));
const files = vi.hoisted(() => ({ dirty: new Set<string>(), dispatch: vi.fn() }));
const lines = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../../store/app-store", () => ({
  useAppStore: { getState: () => app },
  selectPaneFilePath: (_s: unknown, paneId: string) => app.filePaths[paneId] ?? null,
}));
vi.mock("../../store/open-file-store", () => ({
  hasUnsavedEdits: (paneId: string) => files.dirty.has(paneId),
  useOpenFileStore: { getState: () => ({ dispatch: files.dispatch }) },
}));
vi.mock("../../components/workspace-panes/FilePane/pending-line", () => ({
  pendingLines: lines,
}));

const { filePaneInTabOf, openFileBeside, openFileInNewTab } = await import(
  "../open-in-file-pane"
);

const leaf = (paneId: string, contentType?: "file" | "diff"): PaneNode => ({
  type: "leaf",
  paneId,
  ...(contentType ? { contentType } : {}),
});
const split = (first: PaneNode, second: PaneNode): PaneNode => ({
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  first,
  second,
});

function layoutWith(...tabs: PaneNode[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel" },
    panels: {
      panel: {
        id: "panel",
        pinnedTabIds: [],
        tabs: tabs.map((rootNode, i) => ({ id: `t${i}`, title: "", rootNode })),
      },
    },
  } as unknown as WorkspaceLayout;
}

beforeEach(() => {
  vi.clearAllMocks();
  app.filePaths = {};
  files.dirty.clear();
});

describe("filePaneInTabOf", () => {
  it("finds the file pane sharing the tab, not one in another tab", () => {
    const layouts = {
      "/repo": layoutWith(split(leaf("diff", "diff"), leaf("file", "file")), leaf("other", "file")),
    };
    expect(filePaneInTabOf(layouts, "diff")).toBe("file");
  });

  it("is null when the tab has no other file pane", () => {
    const layouts = { "/repo": layoutWith(leaf("diff", "diff"), leaf("other", "file")) };
    expect(filePaneInTabOf(layouts, "diff")).toBeNull();
    expect(filePaneInTabOf(layouts, "other")).toBeNull();
  });
});

describe("openFileBeside", () => {
  it("splits a new file pane after the source, with the line waiting", () => {
    app.workspaceLayouts = { "/repo": layoutWith(leaf("term")) };
    openFileBeside("term", "src/a.ts", "vertical", { line: 8 });
    expect(app.splitPaneAt).toHaveBeenCalledWith("term", "vertical", "second", {
      contentType: "file",
      filePath: "src/a.ts",
    });
    expect(lines.request).toHaveBeenCalledWith("new-file-pane", {
      path: "src/a.ts",
      line: 8,
      col: undefined,
    });
  });

  it("swaps the file in the tab's clean file pane", () => {
    app.workspaceLayouts = { "/repo": layoutWith(split(leaf("diff", "diff"), leaf("file", "file"))) };
    app.filePaths.file = "src/old.ts";
    openFileBeside("diff", "src/a.ts");
    expect(app.splitPaneAt).not.toHaveBeenCalled();
    expect(app.setPaneFilePath).toHaveBeenCalledWith("file", "src/a.ts");
    expect(app.focusPane).toHaveBeenCalledWith("file");
  });

  it("asks in the swap bar, rather than swapping, over unsaved edits", () => {
    app.workspaceLayouts = { "/repo": layoutWith(split(leaf("diff", "diff"), leaf("file", "file"))) };
    app.filePaths.file = "src/old.ts";
    files.dirty.add("file");
    openFileBeside("diff", "src/a.ts");
    expect(app.setPaneFilePath).not.toHaveBeenCalled();
    expect(files.dispatch).toHaveBeenCalledWith("file", { type: "ask-before-open", path: "src/a.ts" });
  });

  it("only moves the cursor when the pane already has the file", () => {
    app.workspaceLayouts = { "/repo": layoutWith(split(leaf("term"), leaf("file", "file"))) };
    app.filePaths.file = "src/a.ts";
    files.dirty.add("file");
    openFileBeside("term", "src/a.ts", "horizontal", { line: 3, col: 2 });
    expect(app.setPaneFilePath).not.toHaveBeenCalled();
    expect(files.dispatch).not.toHaveBeenCalled();
    expect(lines.request).toHaveBeenCalledWith("file", { path: "src/a.ts", line: 3, col: 2 });
  });
});

describe("openFileInNewTab", () => {
  it("opens a file tab, with the line waiting for its pane", () => {
    openFileInNewTab("src/a.ts", { line: 12 });
    expect(app.addFileTab).toHaveBeenCalledWith("src/a.ts");
    expect(lines.request).toHaveBeenCalledWith("tab-file-pane", {
      path: "src/a.ts",
      line: 12,
      col: undefined,
    });
  });
});
