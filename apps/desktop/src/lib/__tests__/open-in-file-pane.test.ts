import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../layout/pane-tree";
import type { WorkspaceLayout } from "../layout/workspace-layout";

/** A store's `subscribe`, for the fakes below. */
const subscribable = vi.hoisted(() => () => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
  };
});

const app = vi.hoisted(() => ({
  workspaceLayouts: {} as Record<string, unknown>,
  filePaths: {} as Record<string, string>,
  focusPane: vi.fn(),
  setPaneFilePath: vi.fn(),
  splitPaneAt: vi.fn(() => "new-file-pane"),
  addFileTab: vi.fn(() => ({ tabId: "t-new", paneId: "tab-file-pane" })),
}));
const appStore = vi.hoisted(() => subscribable());
type FakePane = { dirty: boolean; pendingOpen: string | null };
const files = vi.hoisted(() => ({
  byPane: {} as Record<string, FakePane>,
  dispatch: vi.fn(),
}));
const fileStore = vi.hoisted(() => subscribable());

vi.mock("../../store/app-store", () => ({
  useAppStore: { getState: () => app, subscribe: appStore.subscribe },
  selectPaneFilePath: (_s: unknown, paneId: string) => app.filePaths[paneId] ?? null,
}));
vi.mock("../../store/open-file-store", () => ({
  hasUnsavedEdits: (paneId: string) => files.byPane[paneId]?.dirty ?? false,
  useOpenFileStore: {
    getState: () => ({ byPane: files.byPane, dispatch: files.dispatch }),
    subscribe: (listener: (state: { byPane: Record<string, FakePane> }) => void) =>
      fileStore.subscribe(() => listener({ byPane: files.byPane })),
  },
}));

const { pendingLines } = await import("../../components/workspace-panes/FilePane/pending-line");
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
  files.byPane = {};
  for (const paneId of ["new-file-pane", "file", "tab-file-pane"]) pendingLines.clearLine(paneId);
});

/** A file pane with unsaved edits to `path`. */
function dirtyPane(paneId: string, path: string) {
  app.filePaths[paneId] = path;
  files.byPane[paneId] = { dirty: true, pendingOpen: null };
  files.dispatch.mockImplementation((id: string, event: { type: string; path: string }) => {
    if (event.type === "ask-before-open") files.byPane[id].pendingOpen = event.path;
  });
}

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
    expect(pendingLines.take("new-file-pane", "src/a.ts")).toEqual({
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
    dirtyPane("file", "src/old.ts");
    openFileBeside("diff", "src/a.ts");
    expect(app.setPaneFilePath).not.toHaveBeenCalled();
    expect(files.dispatch).toHaveBeenCalledWith("file", { type: "ask-before-open", path: "src/a.ts" });
  });

  it("only moves the cursor when the pane already has the file", () => {
    app.workspaceLayouts = { "/repo": layoutWith(split(leaf("term"), leaf("file", "file"))) };
    dirtyPane("file", "src/a.ts");
    openFileBeside("term", "src/a.ts", "horizontal", { line: 3, col: 2 });
    expect(app.setPaneFilePath).not.toHaveBeenCalled();
    expect(files.dispatch).not.toHaveBeenCalled();
    expect(pendingLines.take("file", "src/a.ts")).toEqual({ path: "src/a.ts", line: 3, col: 2 });
  });

  describe("a line waiting on the swap bar", () => {
    const tab = () => ({
      "/repo": layoutWith(split(leaf("term"), leaf("file", "file"))),
    });

    it("is dropped when the swap bar is cancelled", () => {
      app.workspaceLayouts = tab();
      dirtyPane("file", "src/old.ts");
      openFileBeside("term", "src/a.ts", "horizontal", { line: 9 });
      expect(pendingLines.waiting("file")).toMatchObject({ path: "src/a.ts", line: 9 });
      files.byPane.file.pendingOpen = null; // Cancel: still dirty
      fileStore.emit();
      expect(pendingLines.waiting("file")).toBeNull();
    });

    it("waits out a slow Discard, then is the opened file's", () => {
      app.workspaceLayouts = tab();
      dirtyPane("file", "src/old.ts");
      openFileBeside("term", "src/a.ts", "horizontal", { line: 9 });
      files.byPane.file = { dirty: false, pendingOpen: null }; // Discard
      fileStore.emit();
      app.filePaths.file = "src/a.ts"; // the layout broadcast, later
      appStore.emit();
      expect(pendingLines.take("file", "src/a.ts")).toMatchObject({ line: 9 });
    });

    it("is dropped when the pane opens another file instead", () => {
      app.workspaceLayouts = tab();
      dirtyPane("file", "src/old.ts");
      openFileBeside("term", "src/a.ts", "horizontal", { line: 9 });
      files.byPane.file = { dirty: false, pendingOpen: null };
      fileStore.emit();
      app.filePaths.file = "src/other.ts";
      appStore.emit();
      expect(pendingLines.waiting("file")).toBeNull();
    });

    it("is dropped when the swap bar is asked for another file", () => {
      app.workspaceLayouts = tab();
      dirtyPane("file", "src/old.ts");
      openFileBeside("term", "src/a.ts", "horizontal", { line: 9 });
      files.byPane.file.pendingOpen = "src/tree-pick.ts";
      fileStore.emit();
      expect(pendingLines.waiting("file")).toBeNull();
    });
  });
});

describe("openFileInNewTab", () => {
  it("opens a file tab in the terminal's own workspace and panel, with the line waiting", () => {
    app.workspaceLayouts = { "/repo": layoutWith(leaf("x")), "box:/other": layoutWith(leaf("term")) };
    openFileInNewTab("term", "src/a.ts", { line: 12 });
    expect(app.addFileTab).toHaveBeenCalledWith("src/a.ts", {
      workspaceKey: "box:/other",
      panelId: "panel",
    });
    expect(pendingLines.take("tab-file-pane", "src/a.ts")).toEqual({
      path: "src/a.ts",
      line: 12,
      col: undefined,
    });
  });

  it("falls back to the active workspace for a pane no layout has", () => {
    openFileInNewTab("gone", "src/a.ts");
    expect(app.addFileTab).toHaveBeenCalledWith("src/a.ts", undefined);
  });
});
