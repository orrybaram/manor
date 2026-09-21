/**
 * The layout command reducer (ADR-179 D1/D2, ADR-182 D6).
 *
 * Every structural change to a workspace — split, close, move, pin, reorder —
 * is a `LayoutCommand`. `applyLayoutCommand` is the one place that turns a
 * command into a new `WorkspaceLayout`. It is pure: no store, no
 * `window.electronAPI`, no side maps, and no `crypto.randomUUID`. What the
 * host must *do* afterwards comes back beside the layout, in `killPanes`.
 *
 * Two rules make it usable from a server that has no idea what any window is
 * looking at:
 *
 * 1. **Ids come in the command.** The sender mints every new pane/tab/panel id
 *    before sending, so it can focus the new pane when the broadcast lands.
 * 2. **"Current" is resolved by the sender.** "Split the focused pane" is
 *    `{ type: "split-pane-at", paneId }`. The reducer cannot read a selection
 *    and does not have one: selection is viewport, per renderer (D3). The
 *    handful of optional command fields documented as "viewport default"
 *    exist only so a command is still applicable when a sender omits them;
 *    the desktop store always passes them.
 *
 * What a command *implies* about the sender's selection — a new tab is
 * selected, a closed tab hands over to a neighbour, a split focuses the pane
 * it made — comes back as a {@link LayoutHint} in `hint`. Only the renderer
 * that sent the command applies it; every other one keeps looking where it
 * was looking.
 *
 * A command naming an id that is not in the tree is a no-op, not a throw: a
 * stale command from a slow renderer is normal.
 *
 * Every move is `take` + `graft` (see `./graft.ts`), which is also where the
 * one rule for an emptied panel lives.
 */

import {
  closePanel,
  moveTabToPanel,
  splitPanel,
  splitPanelWithNewTab,
  splitPanelWithTab,
  updatePanelRatio,
} from "./panels";
import {
  closePane,
  extractPaneToTab,
  movePane,
  reopenClosedPane,
  setPaneContentType,
  splitPaneAt,
  updateSplitRatio,
} from "./panes";
import {
  closeManyTabs,
  closeTab,
  duplicateTab,
  mergeTabIntoTab,
  moveTabToPane,
  newTab,
  reorderTabs,
  togglePinTab,
} from "./tabs";
import type {
  CommandOf,
  Handler,
  LayoutCommand,
  LayoutResult,
  LayoutState,
} from "./types";

export { findLeaf } from "./graft";
export {
  type ClosedPane,
  type LayoutCommand,
  type LayoutResult,
  type LayoutState,
  MAX_CLOSED_STACK,
} from "./types";

/** One reducer per command type; the compiler holds the table to the union. */
const HANDLERS: {
  [K in LayoutCommand["type"]]: Handler<CommandOf<K>>;
} = {
  "new-tab": newTab,
  "close-tab": (state, command) => closeTab(state, command.tabId),
  "duplicate-tab": duplicateTab,
  "close-other-tabs": closeManyTabs,
  "close-tabs-to-right": closeManyTabs,
  "reorder-tabs": reorderTabs,
  "toggle-pin-tab": togglePinTab,
  "split-pane-at": splitPaneAt,
  "move-pane": movePane,
  "move-tab-to-pane": moveTabToPane,
  "extract-pane-to-tab": extractPaneToTab,
  "close-pane": closePane,
  "reopen-closed-pane": reopenClosedPane,
  "set-pane-content-type": setPaneContentType,
  "split-panel": splitPanel,
  "close-panel": closePanel,
  "merge-tab-into-tab": mergeTabIntoTab,
  "update-panel-ratio": updatePanelRatio,
  "move-tab-to-panel": moveTabToPanel,
  "split-panel-with-tab": splitPanelWithTab,
  "split-panel-with-new-tab": splitPanelWithNewTab,
  "update-split-ratio": updateSplitRatio,
};

/** Whether the reducer answers to `type`. An unknown one is refused, not run. */
export function isLayoutCommandType(
  type: unknown,
): type is LayoutCommand["type"] {
  return (
    typeof type === "string" &&
    Object.prototype.hasOwnProperty.call(HANDLERS, type)
  );
}

export function applyLayoutCommand(
  state: LayoutState,
  command: LayoutCommand,
): LayoutResult {
  const handler = HANDLERS[command.type] as Handler<LayoutCommand>;
  return handler(state, command);
}
