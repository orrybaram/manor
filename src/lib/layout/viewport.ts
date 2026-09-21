/**
 * What one renderer is *looking at* (ADR-179 D3).
 *
 * The tab set is shared — it is structure, it lives in `WorkspaceLayout`, and
 * the Manor server owns it. The *selection* is not: which tab a panel shows,
 * which pane a tab focuses and which panel has the keyboard are facts about
 * one window, and sharing them means flipping a tab on a phone flips the desk.
 * So they live here, keyed by workspace, persisted per renderer.
 *
 * A viewport is therefore always *about* a layout without being *in* it, and
 * the two drift: another renderer closes the tab this one was showing, a
 * command adds a panel this one has never selected in. {@link
 * reconcileViewport} is the repair — run on every `layout.changed`, it drops
 * every id the layout no longer has and fills every gap the layout now has, so
 * a viewport never points at nothing.
 */

import { allPaneIds, hasPaneId } from "./pane-tree";
import { allPanelIds } from "./panel-tree";
import type { WorkspaceLayout } from "./workspace-layout";

/**
 * One renderer's view of one workspace.
 *
 * `activePanelId` is nullable because a workspace with no panels is a real
 * state (a freshly created one, or the moment after the last panel closed);
 * the two maps simply have no entry for a panel or tab with nothing to point
 * at.
 */
export interface WorkspaceViewport {
  activePanelId: string | null;
  /** panelId → tabId */
  selectedTabIds: Record<string, string>;
  /** tabId → paneId */
  focusedPaneIds: Record<string, string>;
  /**
   * The one tab this renderer holds, if it is a detached window (D4).
   *
   * A detached window is not a second authority any more; it is a viewport
   * with a **claim**. Set only by a non-primary desktop window — a browser is
   * never a claimant, and the primary never claims, because it is the window
   * that shows everything nobody else has. The server reads it out of the
   * viewport report and tells every renderer who holds what.
   */
  claim?: string;
}

/** A viewport that has not looked at anything yet. */
export const EMPTY_VIEWPORT: WorkspaceViewport = Object.freeze({
  activePanelId: null,
  selectedTabIds: Object.freeze({}) as Record<string, string>,
  focusedPaneIds: Object.freeze({}) as Record<string, string>,
});

export function emptyViewport(): WorkspaceViewport {
  return { activePanelId: null, selectedTabIds: {}, focusedPaneIds: {} };
}

/**
 * What a command *implies* about the sender's selection.
 *
 * A new tab is selected, a closed tab hands the selection to a neighbour, a
 * split focuses the pane it made. None of that is structure, so the reducer
 * cannot do it — but only the reducer knows which neighbour. So it says so,
 * and the hint rides back to the renderer that sent the command on the same
 * `layout.changed` that carries the new layout. Every *other* renderer
 * ignores it: its own selection is its own business (D3).
 */
export interface LayoutHint {
  selectTab?: { panelId: string; tabId: string };
  focusPane?: { tabId: string; paneId: string };
  activatePanel?: string;
}

/** The first pane a tab would focus if it had no opinion. */
function firstPaneOf(layout: WorkspaceLayout, tabId: string): string | null {
  for (const panel of Object.values(layout.panels)) {
    const tab = panel.tabs.find((t) => t.id === tabId);
    if (tab) return allPaneIds(tab.rootNode)[0] ?? null;
  }
  return null;
}

/** Panels in tree order, so "the first panel" means the leftmost one. */
function orderedPanelIds(layout: WorkspaceLayout): string[] {
  const inTree = allPanelIds(layout.panelTree).filter(
    (id) => layout.panels[id] !== undefined,
  );
  const extra = Object.keys(layout.panels).filter((id) => !inTree.includes(id));
  return [...inTree, ...extra];
}

function sameRecord(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** The panel holding a tab, or null when the layout no longer has it. */
function panelOfTab(layout: WorkspaceLayout, tabId: string): string | null {
  for (const [panelId, panel] of Object.entries(layout.panels)) {
    if (panel.tabs.some((t) => t.id === tabId)) return panelId;
  }
  return null;
}

/**
 * The tabs a claiming window does not show: all of them but its own (D4).
 *
 * Derived here rather than passed in, because the claim is already in the
 * viewport — a window that holds one tab is showing exactly that tab, and
 * every call site would otherwise have to say so again.
 */
function tabsHiddenByClaim(
  layout: WorkspaceLayout,
  claim: string,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      if (tab.id !== claim) hidden.add(tab.id);
    }
  }
  return hidden;
}

const NOTHING_HIDDEN: ReadonlySet<string> = new Set<string>();

/**
 * Point a viewport back at a layout it may have drifted from.
 *
 * Two directions, both mechanical: a reference to a panel, tab or pane the
 * layout no longer has is dropped, and a panel or tab the viewport says
 * nothing about takes the obvious default (its first tab, its first pane).
 * The active panel survives if it still exists and otherwise becomes the
 * first one.
 *
 * `hiddenTabIds` is the third direction, and it is the one claims added (D4):
 * a tab another window has popped out is still in the layout, still rendered
 * by a browser, and simply not something *this* renderer may select. A
 * viewport with a `claim` of its own derives its hidden set from the claim
 * instead, and loses the claim when the tab it named leaves the tree — which
 * is how a detached window learns its tab was closed elsewhere.
 *
 * Returns the viewport it was given when nothing needed repairing, so a store
 * can skip the write — this runs on every broadcast.
 */
export function reconcileViewport(
  layout: WorkspaceLayout,
  viewport: WorkspaceViewport,
  hiddenTabIds: ReadonlySet<string> = NOTHING_HIDDEN,
): WorkspaceViewport {
  const panelIds = orderedPanelIds(layout);

  const claim =
    viewport.claim !== undefined && panelOfTab(layout, viewport.claim) !== null
      ? viewport.claim
      : undefined;
  const hidden = claim !== undefined ? tabsHiddenByClaim(layout, claim) : hiddenTabIds;

  // A claiming window has the keyboard in the panel its tab lives in; there is
  // nothing else on its screen to have it in.
  const claimPanelId = claim !== undefined ? panelOfTab(layout, claim) : null;
  const activePanelId =
    claimPanelId ??
    (viewport.activePanelId !== null && layout.panels[viewport.activePanelId]
      ? viewport.activePanelId
      : (panelIds[0] ?? null));

  const selectedTabIds: Record<string, string> = {};
  const focusedPaneIds: Record<string, string> = {};

  for (const panelId of panelIds) {
    const panel = layout.panels[panelId];
    const current = viewport.selectedTabIds[panelId];
    const selectable = panel.tabs.filter((t) => !hidden.has(t.id));
    const selected =
      current !== undefined && selectable.some((t) => t.id === current)
        ? current
        : selectable[0]?.id;
    if (selected !== undefined) selectedTabIds[panelId] = selected;

    for (const tab of panel.tabs) {
      const focused = viewport.focusedPaneIds[tab.id];
      const paneId =
        focused !== undefined && hasPaneId(tab.rootNode, focused)
          ? focused
          : allPaneIds(tab.rootNode)[0];
      if (paneId !== undefined) focusedPaneIds[tab.id] = paneId;
    }
  }

  if (
    claim === viewport.claim &&
    activePanelId === viewport.activePanelId &&
    sameRecord(selectedTabIds, viewport.selectedTabIds) &&
    sameRecord(focusedPaneIds, viewport.focusedPaneIds)
  ) {
    return viewport;
  }
  const next: WorkspaceViewport = {
    ...viewport,
    activePanelId,
    selectedTabIds,
    focusedPaneIds,
  };
  if (claim === undefined) delete next.claim;
  else next.claim = claim;
  return next;
}

/**
 * Fold a command's selection hint into the sender's own viewport.
 *
 * Applied *before* {@link reconcileViewport}, and only by the renderer whose
 * command produced it: a hint naming a tab another renderer just closed is
 * repaired by the reconcile that follows, not guarded against here.
 */
export function applyHint(
  layout: WorkspaceLayout,
  viewport: WorkspaceViewport,
  hint: LayoutHint,
  hiddenTabIds?: ReadonlySet<string>,
): WorkspaceViewport {
  let next = viewport;

  if (hint.activatePanel !== undefined) {
    next = { ...next, activePanelId: hint.activatePanel };
  }
  if (hint.selectTab) {
    const { panelId, tabId } = hint.selectTab;
    next = {
      ...next,
      selectedTabIds: { ...next.selectedTabIds, [panelId]: tabId },
    };
    // A tab selected by a command is a tab this window is now looking at, so
    // the panel holding it is the one with the keyboard.
    if (hint.activatePanel === undefined) {
      next = { ...next, activePanelId: panelId };
    }
    const pane = next.focusedPaneIds[tabId] ?? firstPaneOf(layout, tabId);
    if (pane !== null && pane !== undefined) {
      next = {
        ...next,
        focusedPaneIds: { ...next.focusedPaneIds, [tabId]: pane },
      };
    }
  }
  if (hint.focusPane) {
    const { tabId, paneId } = hint.focusPane;
    next = {
      ...next,
      focusedPaneIds: { ...next.focusedPaneIds, [tabId]: paneId },
    };
  }

  return next === viewport
    ? viewport
    : reconcileViewport(layout, next, hiddenTabIds);
}

/** The tab a renderer holds, or null when it holds none. */
export function claimOf(
  viewport: WorkspaceViewport | undefined,
): string | null {
  return viewport?.claim ?? null;
}

/** The tab a panel is showing, or null while it has none. */
export function selectedTabOf(
  viewport: WorkspaceViewport | undefined,
  panelId: string | null | undefined,
): string | null {
  if (!viewport || !panelId) return null;
  return viewport.selectedTabIds[panelId] ?? null;
}

/** The pane a tab focuses, or null while it has none. */
export function focusedPaneOf(
  viewport: WorkspaceViewport | undefined,
  tabId: string | null | undefined,
): string | null {
  if (!viewport || !tabId) return null;
  return viewport.focusedPaneIds[tabId] ?? null;
}
