/**
 * Id minting for layout commands (ADR-179 D1/D2).
 *
 * `applyLayoutCommand` never mints an id: a `LayoutCommand`'s ids come from
 * whoever sends it, so the sender can act on the result the moment the
 * broadcast lands (`commands.ts`). Two senders need the same minting — the
 * desktop store (`src/store/app-store.ts`), which used to keep these
 * private, and the structural routes (`electron/routes/panes.ts`), which
 * bypass a renderer entirely (ADR-179 D5) — so it lives here instead of
 * being duplicated in both.
 */

import type { PaneNode } from "./pane-tree";
import type { Tab } from "./workspace-layout";

export function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

export function newTabId(): string {
  return `tab-${crypto.randomUUID()}`;
}

export function newPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

/**
 * A fresh single-pane tab. `fallbackTab` on `move-pane`, `move-tab-to-pane`,
 * `extract-pane-to-tab` and `merge-tab-into-tab` all want exactly this: a
 * seed for the panel a structural change is about to empty out.
 */
export function createTab(title?: string, paneId?: string): Tab {
  const id = paneId ?? newPaneId();
  const rootNode: PaneNode = { type: "leaf", paneId: id };
  return { id: newTabId(), title: title ?? "Terminal", rootNode };
}
