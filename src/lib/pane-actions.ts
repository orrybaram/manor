/**
 * Pane actions that act on whatever pane currently has focus.
 *
 * Extracted from the command palette (ADR-170) so the native menu's Pane ›
 * Split With / Convert To items and the palette run the exact same code. Every
 * function reads `getState()` rather than React state, so it can be called from
 * outside the render cycle.
 */

import {
  useAppStore,
  selectFocusedPaneOfActiveTab,
  sendPendingCommand,
} from "../store/app-store";
import { getAgentCommand } from "../agent-defaults";

export type PaneContentType = "terminal" | "browser" | "diff" | "agent";

/** The focused pane of the active workspace's selected tab, if any. */
export function getFocusedPaneId(): string | null {
  return selectFocusedPaneOfActiveTab(useAppStore.getState());
}

/**
 * Split the focused pane along its long axis and give the new half the
 * requested content. `paneCommand` seeds the new pane's terminal (used for
 * "split with agent").
 */
export function splitFocusedPaneWith(
  contentType?: PaneContentType,
  paneCommand?: string,
): void {
  const focusedPaneId = getFocusedPaneId();
  if (!focusedPaneId) return;
  const el = document.querySelector<HTMLElement>(
    `[data-pane-id="${focusedPaneId}"]`,
  );
  const direction =
    el && el.offsetWidth >= el.offsetHeight ? "horizontal" : "vertical";
  useAppStore.getState().splitPaneAt(focusedPaneId, direction, "second", {
    contentType,
    paneCommand,
  });
}

/**
 * Turn the focused pane into another content type.
 *
 * "agent" is not a content type the store persists — an agent pane is a
 * terminal running the workspace's agent command. A pane that is already a
 * terminal just gets the command typed into it; anything else is converted
 * back to a terminal and the command queued on the server for the fresh
 * session that pane is about to get (ADR-179 ticket 11).
 */
export function convertFocusedPaneTo(contentType: PaneContentType): void {
  const focusedPaneId = getFocusedPaneId();
  if (!focusedPaneId) return;
  const state = useAppStore.getState();

  if (contentType !== "agent") {
    state.setPaneContentType(focusedPaneId, contentType);
    return;
  }

  const command = getAgentCommand(state.activeWorkspacePath);
  const currentType = state.paneContentType[focusedPaneId] ?? "terminal";
  if (currentType === "terminal") {
    window.electronAPI.pty.write(focusedPaneId, command + "\n");
    return;
  }
  // Queued before the conversion, not after: the pane remounts as a terminal
  // when the change lands, and its `pty.create` is what types this.
  sendPendingCommand(focusedPaneId, command, "agent-startup");
  state.setPaneContentType(focusedPaneId, "terminal");
}
