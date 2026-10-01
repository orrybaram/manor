/**
 * The tabs a sender builds for a `new-tab` or `duplicate-tab` command, and
 * the lookup that decides whether a diff tab is needed at all (ADR-182 D8).
 *
 * Both senders use these: the desktop store (`src/store/app-store.ts`) and
 * the structural routes (`electron/routes/panes-structural.ts`). Every id is
 * minted here, by the sender, never by the reducer (`./commands/`). The
 * terminal tab is `createTab` in `./ids.ts`.
 */

import { newPaneId, newTabId } from "./ids";
import { clonePaneTree } from "./pane-tree";
import { type Tab, type WorkspaceLayout, layoutLeaves } from "./workspace-layout";

/** A fresh single-pane browser tab, titled from the URL's host. */
export function createBrowserTab(url: string): Tab {
  let title: string;
  try {
    title = new URL(url).host || url;
  } catch {
    title = url;
  }
  return {
    id: newTabId(),
    title,
    rootNode: { type: "leaf", paneId: newPaneId(), contentType: "browser", url },
  };
}

/** A fresh single-pane diff tab. */
export function createDiffTab(): Tab {
  return {
    id: newTabId(),
    title: "Diff",
    rootNode: { type: "leaf", paneId: newPaneId(), contentType: "diff" },
  };
}

/**
 * A copy of `tab` for `duplicate-tab`. Every pane gets a fresh id: a
 * duplicated tab is a second set of sessions, not a second view of the first.
 * `idMap` is old → new paneId.
 */
export function cloneTabWithFreshIds(tab: Tab): {
  tab: Tab;
  idMap: Record<string, string>;
} {
  const { tree, idMap } = clonePaneTree(tab.rootNode, newPaneId);
  return { tab: { id: newTabId(), title: tab.title, rootNode: tree }, idMap };
}

/**
 * The workspace's diff pane, wherever it is — any pane of any tab, not only
 * a tab's root. There is at most one.
 */
export function findDiffPane(
  layout: WorkspaceLayout,
): { paneId: string; tabId: string } | null {
  for (const { tab, leaf } of layoutLeaves(layout)) {
    if (leaf.contentType === "diff") {
      return { paneId: leaf.paneId, tabId: tab.id };
    }
  }
  return null;
}
