/**
 * The Diff pane is retired (#495): a file pane's Source Control shows a
 * workspace's changes now. A leaf saved as `diff` — in a layout file written
 * before, or held by a host server still running an older bundle — reads as
 * an empty file pane that starts on Source Control.
 *
 * Both ends run it: the Manor server on every layout load, so the file and
 * what it broadcasts carry no `diff`, and the renderer on every layout it
 * adopts, for a host server that has not been upgraded. It is idempotent, and
 * a layout with no `diff` leaf comes back as the same object.
 */

import type { PaneNode } from "./pane-tree";

/** What the old content type was called on a leaf. */
const RETIRED_DIFF = "diff";

/** `node` with every `diff` leaf as a file pane on Source Control. */
function withoutDiffPanes(node: PaneNode): PaneNode {
  if (node.type === "leaf") {
    if ((node.contentType as string | undefined) !== RETIRED_DIFF) return node;
    // A diff leaf had no url or file of its own: only its id carries over.
    return { type: "leaf", paneId: node.paneId, contentType: "file", startsOn: "scm" };
  }
  const first = withoutDiffPanes(node.first);
  const second = withoutDiffPanes(node.second);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

type PanelOf = { tabs: ReadonlyArray<{ rootNode: PaneNode }> };

/**
 * `layout` with every `diff` leaf as a file pane on Source Control; the same
 * object when it has none. Generic over the panel's shape, so the layout
 * file's workspaces and the renderer's layouts keep their other fields.
 */
export function layoutWithoutDiffPanes<L extends { panels: Record<string, PanelOf> }>(
  layout: L,
): L {
  const panels = panelsWithoutDiffPanes(layout.panels);
  return panels === layout.panels ? layout : { ...layout, panels };
}

function panelsWithoutDiffPanes<P extends PanelOf>(
  panels: Record<string, P>,
): Record<string, P> {
  let changed = false;
  const next: Record<string, P> = {};
  for (const [id, panel] of Object.entries(panels)) {
    let tabsChanged = false;
    const tabs = panel.tabs.map((tab) => {
      const rootNode = withoutDiffPanes(tab.rootNode);
      if (rootNode === tab.rootNode) return tab;
      tabsChanged = true;
      return { ...tab, rootNode };
    });
    next[id] = tabsChanged ? { ...panel, tabs } : panel;
    changed ||= tabsChanged;
  }
  return changed ? next : panels;
}
