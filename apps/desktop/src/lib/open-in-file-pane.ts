/**
 * Opening a workspace file in a file pane from somewhere else: a changed
 * file's header in the diff pane, or a path printed in a terminal.
 */

import { hasUnsavedEdits, useOpenFileStore } from "../store/open-file-store";
import { selectPaneFilePath, useAppStore } from "../store/app-store";
import { pendingLines } from "../components/workspace-panes/FilePane/pending-line";
import type { PaneNode, SplitDirection } from "./layout/pane-tree";
import type { WorkspaceLayout } from "./layout/workspace-layout";

/** Where in the file to put the cursor, 1-based. */
type At = { line?: number; col?: number };

function fileLeaves(node: PaneNode): string[] {
  if (node.type === "leaf") return node.contentType === "file" ? [node.paneId] : [];
  return [...fileLeaves(node.first), ...fileLeaves(node.second)];
}

function hasPane(node: PaneNode, paneId: string): boolean {
  if (node.type === "leaf") return node.paneId === paneId;
  return hasPane(node.first, paneId) || hasPane(node.second, paneId);
}

/**
 * A file pane in the same tab as `paneId`, other than it: the one an open
 * from that pane reuses. A tab is one workspace's, so it is that pane's
 * workspace too. Null when the tab has none.
 */
export function filePaneInTabOf(
  layouts: Record<string, WorkspaceLayout>,
  paneId: string,
): string | null {
  for (const layout of Object.values(layouts)) {
    for (const panel of Object.values(layout.panels)) {
      const tab = panel.tabs.find((t) => hasPane(t.rootNode, paneId));
      if (tab) return fileLeaves(tab.rootNode).find((id) => id !== paneId) ?? null;
    }
  }
  return null;
}

/** Side by side beside a wide pane, stacked under a tall one, as "Split with" does. */
export function splitDirectionBeside(el: HTMLElement | null): SplitDirection {
  return el && el.offsetWidth >= el.offsetHeight ? "horizontal" : "vertical";
}

function requestLine(paneId: string, path: string, at: At): void {
  if (at.line) pendingLines.request(paneId, { path, line: at.line, col: at.col });
}

/**
 * Show `path` in the file pane `paneId`. Unsaved edits to another file ask
 * first, in the pane's swap bar, as picking from its tree does; the line, if
 * any, waits for the file to open.
 */
function showFileInPane(paneId: string, path: string, at: At): void {
  const app = useAppStore.getState();
  requestLine(paneId, path, at);
  app.focusPane(paneId);
  if (selectPaneFilePath(app, paneId) === path) return;
  if (hasUnsavedEdits(paneId)) {
    useOpenFileStore.getState().dispatch(paneId, { type: "ask-before-open", path });
    return;
  }
  app.setPaneFilePath(paneId, path);
}

/**
 * Open `path` (workspace-relative) beside `sourcePaneId`: in the file pane
 * already in its tab, or else in a new one split off it, after it.
 */
export function openFileBeside(
  sourcePaneId: string,
  path: string,
  direction: SplitDirection = "horizontal",
  at: At = {},
): void {
  const app = useAppStore.getState();
  const existing = filePaneInTabOf(app.workspaceLayouts, sourcePaneId);
  if (existing) {
    showFileInPane(existing, path, at);
    return;
  }
  const paneId = app.splitPaneAt(sourcePaneId, direction, "second", {
    contentType: "file",
    filePath: path,
  });
  if (paneId) requestLine(paneId, path, at);
}

/** Open `path` in a file pane of a new tab, in the active workspace. */
export function openFileInNewTab(path: string, at: At = {}): void {
  const opened = useAppStore.getState().addFileTab(path);
  if (opened) requestLine(opened.paneId, path, at);
}
