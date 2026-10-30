/**
 * Opening a workspace file in a file pane from somewhere else: a path
 * printed in a terminal, or Go to File.
 */

import { hasUnsavedEdits, useOpenFileStore } from "../store/open-file-store";
import {
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  selectPaneFilePath,
  useAppStore,
} from "../store/app-store";
import { pendingLines } from "../components/workspace-panes/FilePane/pending-line";
import type { PaneNode, SplitDirection } from "./layout/pane-tree";
import type { WorkspaceLayout } from "./layout/workspace-layout";
import type { WorkspaceKey } from "./workspace-key";

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

/** The workspace, panel and tab `paneId` is in, or null when no layout has it. */
function placeOf(layouts: Record<string, WorkspaceLayout>, paneId: string) {
  for (const [workspaceKey, layout] of Object.entries(layouts)) {
    for (const panel of Object.values(layout.panels)) {
      const tab = panel.tabs.find((t) => hasPane(t.rootNode, paneId));
      if (tab) return { workspaceKey: workspaceKey as WorkspaceKey, panelId: panel.id, tab };
    }
  }
  return null;
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
  const place = placeOf(layouts, paneId);
  if (!place) return null;
  return fileLeaves(place.tab.rootNode).find((id) => id !== paneId) ?? null;
}

/** Side by side beside a wide pane, stacked under a tall one, as "Split with" does. */
export function splitDirectionBeside(el: HTMLElement | null): SplitDirection {
  return el && el.offsetWidth >= el.offsetHeight ? "horizontal" : "vertical";
}

/**
 * Ask `paneId` to show `at.line`, or with none just to take the keyboard,
 * once it has `path` open, and drop the ask
 * once it can't: the pane opens another file instead, or its swap bar stops
 * asking to open `path` without opening it (Cancel, or a save that failed).
 */
function requestLine(paneId: string, path: string, at: At): void {
  const request = pendingLines.request(paneId, { path, line: at.line, col: at.col });
  let shown = selectPaneFilePath(useAppStore.getState(), paneId);
  let asking = useOpenFileStore.getState().byPane[paneId]?.pendingOpen === path;
  const waiting = () => pendingLines.waiting(paneId) === request;
  const stop = () => {
    stopApp();
    stopFiles();
  };
  const stopApp = useAppStore.subscribe((state) => {
    if (!waiting()) return stop();
    const now = selectPaneFilePath(state, paneId);
    if (now === shown) return;
    shown = now;
    // Opened: the editor takes the line. Anything else: it never will.
    if (now !== path) pendingLines.clearLine(paneId);
    stop();
  });
  const stopFiles = useOpenFileStore.subscribe((state) => {
    if (!waiting()) return stop();
    const pane = state.byPane[paneId];
    const was = asking;
    asking = pane?.pendingOpen === path;
    if (!was || asking) return;
    // The swap bar stopped asking. Discard clears the edits and opens the file
    // (the app store says when); still dirty is Cancel or a failed save, and
    // another path is another open.
    if (pane && !pane.dirty && pane.pendingOpen === null) return;
    pendingLines.clearLine(paneId);
    stop();
  });
  if (!waiting()) stop();
}

/**
 * Show `path` in the file pane `paneId`. Unsaved edits to another file ask
 * first, in the pane's swap bar, as picking from its tree does; the line, if
 * any, waits for the file to open, and is dropped if it doesn't.
 */
function showFileInPane(paneId: string, path: string, at: At): void {
  const app = useAppStore.getState();
  app.focusPane(paneId);
  pendingLines.nudge(paneId);
  if (selectPaneFilePath(app, paneId) === path) {
    requestLine(paneId, path, at);
    return;
  }
  if (hasUnsavedEdits(paneId)) {
    useOpenFileStore.getState().dispatch(paneId, { type: "ask-before-open", path });
    requestLine(paneId, path, at);
    return;
  }
  requestLine(paneId, path, at);
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

/**
 * Open `path` in a file pane of a new tab beside `sourcePaneId`'s, in its
 * workspace and panel: not the active workspace's, which a detached window's
 * terminal need not be in.
 */
export function openFileInNewTab(sourcePaneId: string, path: string, at: At = {}): void {
  const app = useAppStore.getState();
  const place = placeOf(app.workspaceLayouts, sourcePaneId);
  const opened = app.addFileTab(
    path,
    place ? { workspaceKey: place.workspaceKey, panelId: place.panelId } : undefined,
  );
  if (opened) requestLine(opened.paneId, path, at);
}

/**
 * Open `path` (relative to the active workspace) from Go to File: in the
 * focused pane when it is a file pane, else in a file pane of the active tab,
 * else in a new tab's.
 */
export function openFileInActiveWorkspace(path: string): void {
  const app = useAppStore.getState();
  const focused = selectFocusedPaneOfActiveTab(app);
  if (focused) {
    const target =
      selectPaneContentType(app, focused) === "file"
        ? focused
        : filePaneInTabOf(app.workspaceLayouts, focused);
    if (target) {
      showFileInPane(target, path, {});
      return;
    }
  }
  const opened = app.addFileTab(path);
  if (opened) requestLine(opened.paneId, path, {});
}
