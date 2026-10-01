/**
 * The layout command vocabulary (ADR-179 D1/D2, ADR-182 D6): every command,
 * the reopen stack's entries, and the reducer's input and output.
 */

import type { PaneNode, SplitDirection } from "../pane-tree";
import type { LayoutHint } from "../viewport";
import type { PaneContentType, Tab, WorkspaceLayout } from "../workspace-layout";

/** How many closed panes/tabs a workspace can restore, newest first. */
export const MAX_CLOSED_STACK = 10;

/** One leaf of a pane tree — a pane, with what it renders. */
export type PaneLeaf = Extract<PaneNode, { type: "leaf" }>;

/** Where a removed panel sat, so reopening its last tab can rebuild it. */
export interface PanelSplitContext {
  siblingId: string;
  direction: SplitDirection;
  ratio: number;
  position: "first" | "second";
}

/**
 * A pane closed out of a tab that kept other panes.
 *
 * The leaf is kept whole, so a reopened browser pane comes back with its url
 * and content type. `title` is the host's to fill in: the reducer does not
 * know a pane's terminal title, and `LayoutStore` does.
 */
export interface ClosedPaneEntry {
  kind: "pane";
  leaf: PaneLeaf;
  tabId: string;
  panelId: string;
  title?: string;
}

export interface ClosedTabEntry {
  kind: "tab";
  tab: Tab;
  panelId: string;
  /** Set when closing this tab also removed its panel. */
  panelSplitContext?: PanelSplitContext;
}

/** One entry of the reopen stack. */
export type ClosedPane = ClosedPaneEntry | ClosedTabEntry;

export type LayoutCommand =
  | { type: "new-tab"; tab: Tab; panelId?: string; select?: boolean }
  | { type: "close-tab"; tabId: string }
  | { type: "duplicate-tab"; tabId: string; newTab: Tab }
  | { type: "close-other-tabs"; tabId: string }
  | { type: "close-tabs-to-right"; tabId: string }
  | { type: "reorder-tabs"; panelId: string; tabIds: string[] }
  | { type: "toggle-pin-tab"; tabId: string }
  | {
      type: "split-pane-at";
      paneId: string;
      direction: SplitDirection;
      position: "first" | "second";
      newPaneId: string;
      contentType?: PaneContentType;
      url?: string;
    }
  | {
      type: "move-pane";
      sourcePaneId: string;
      targetPaneId: string;
      direction: SplitDirection;
      position: "first" | "second";
    }
  | {
      type: "move-tab-to-pane";
      tabId: string;
      targetPaneId: string;
      direction: SplitDirection;
      position: "first" | "second";
    }
  | {
      type: "extract-pane-to-tab";
      paneId: string;
      targetPanelId?: string;
      newTabId: string;
    }
  | { type: "close-pane"; paneId: string }
  | {
      type: "reopen-closed-pane";
      /** Tab to restore a pane into when its original tab is gone. */
      newTabId: string;
      /** Panel to restore into when the original panel is gone.
       *  Viewport default: the active panel. */
      panelId?: string;
      /** Pane the restored pane splits off.
       *  Viewport default: the target tab's focused pane. */
      anchorPaneId?: string;
    }
  | {
      type: "set-pane-content-type";
      paneId: string;
      contentType: PaneContentType;
      url?: string;
    }
  | {
      type: "split-panel";
      panelId: string;
      direction: SplitDirection;
      newPanelId: string;
      /** Tab to move into the new panel.
       *  Viewport default: the panel's selected tab. */
      tabId?: string;
    }
  | { type: "close-panel"; panelId: string }
  | {
      /**
       * Drag a tab onto another tab's pane tree: the source tab stops being a
       * tab and becomes a split of the target's. No ids are minted — the
       * source subtree keeps the panes it already has.
       */
      type: "merge-tab-into-tab";
      sourceTabId: string;
      targetTabId: string;
      /** Which side of the new split the source subtree lands on.
       *  Defaults to "second" — dropped tab goes right/below. */
      position?: "first" | "second";
    }
  | { type: "update-panel-ratio"; firstPanelId: string; ratio: number }
  | { type: "move-tab-to-panel"; tabId: string; targetPanelId: string }
  | {
      type: "split-panel-with-tab";
      tabId: string;
      targetPanelId: string;
      direction: SplitDirection;
      newPanelId: string;
    }
  | {
      /**
       * A new panel beside `sourcePanelId`, holding a brand-new tab — the
       * source panel keeps every tab it had.
       *
       * Deliberately not `new-tab` + `split-panel`: `split-panel` *moves* the
       * source panel's selected tab into the new panel, which is not what
       * "open the diff beside this" means.
       */
      type: "split-panel-with-new-tab";
      tab: Tab;
      direction: SplitDirection;
      newPanelId: string;
      sourcePanelId: string;
    }
  | { type: "update-split-ratio"; firstPaneId: string; ratio: number };

/** One command, by its `type`. */
export type CommandOf<K extends LayoutCommand["type"]> = Extract<
  LayoutCommand,
  { type: K }
>;

/** The reducer's whole state for one workspace. */
export interface LayoutState {
  layout: WorkspaceLayout;
  closedStack: ClosedPane[];
}

export interface LayoutResult extends LayoutState {
  /** Panes that left the tree for good; the host ends their sessions. */
  killPanes: string[];
  /** What the command implies about the sender's selection (ADR-179 D3). */
  hint?: LayoutHint;
}

/** One command type's reducer. */
export type Handler<C extends LayoutCommand> = (
  state: LayoutState,
  command: C,
) => LayoutResult;
