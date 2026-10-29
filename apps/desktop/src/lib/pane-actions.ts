/**
 * Pane actions that act on whatever pane currently has focus.
 *
 * Extracted from the command palette so the native menu's Pane ›
 * Split With / Convert To items and the palette run the exact same code. Every
 * function reads `getState()` rather than React state, so it can be called from
 * outside the render cycle.
 */

import {
  useAppStore,
  selectActiveWorkspaceKey,
  selectFocusedPaneOfActiveTab,
  selectPaneContentType,
  sendPendingCommand,
} from "../store/app-store";
import { getAgentCommand } from "../agent-defaults";
import { guardUnsavedEdits } from "../store/unsaved-guard-store";
import { requestSourceControl } from "./source-control-request";

/** What a pane can be split with or converted to. `scm` is a file pane on
 *  Source Control; `agent`, a terminal running the agent command. */
export type PaneContentType = "terminal" | "browser" | "scm" | "agent";

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
  splitPaneWith(focusedPaneId, direction, contentType, paneCommand);
}

/** Split `paneId`, giving the new half `contentType`'s content. */
export function splitPaneWith(
  paneId: string,
  direction: "horizontal" | "vertical",
  contentType?: PaneContentType,
  paneCommand?: string,
): void {
  useAppStore.getState().splitPaneAt(
    paneId,
    direction,
    "second",
    contentType === "scm"
      ? { contentType: "file", startsOn: "scm" }
      : { contentType, paneCommand },
  );
}

/**
 * Turn the focused pane into another content type.
 *
 * "agent" is not a content type the store persists — an agent pane is a
 * terminal running the workspace's agent command. A pane that is already a
 * terminal just gets the command typed into it; anything else is converted
 * back to a terminal and the command queued on the server for the fresh
 * session that pane is about to get.
 */
export function convertFocusedPaneTo(contentType: PaneContentType): void {
  const focusedPaneId = getFocusedPaneId();
  if (focusedPaneId) convertPaneTo(focusedPaneId, contentType);
}

/**
 * Turn `paneId` into another content type (see `convertFocusedPaneTo`). A
 * file pane asked for Source Control only opens it: it is already one.
 */
export function convertPaneTo(paneId: string, contentType: PaneContentType): void {
  if (contentType === "scm" && selectPaneContentType(useAppStore.getState(), paneId) === "file") {
    requestSourceControl(paneId);
    return;
  }
  // A file pane's unsaved edits ask first: converting drops them.
  guardUnsavedEdits([paneId], "convert", () => convertNow(paneId, contentType));
}

function convertNow(focusedPaneId: string, contentType: PaneContentType): void {
  const state = useAppStore.getState();

  if (contentType === "scm") {
    state.setPaneContentType(focusedPaneId, "file", { startsOn: "scm" });
    return;
  }
  if (contentType !== "agent") {
    state.setPaneContentType(focusedPaneId, contentType);
    return;
  }

  const command = getAgentCommand(selectActiveWorkspaceKey(state));
  const currentType = selectPaneContentType(state, focusedPaneId);
  if (currentType === "terminal") {
    window.electronAPI.pty.write(focusedPaneId, command + "\n");
    return;
  }
  // Queued before the conversion, not after: the pane remounts as a terminal
  // when the change lands, and its `pty.create` is what types this.
  sendPendingCommand(focusedPaneId, command, "agent-startup");
  state.setPaneContentType(focusedPaneId, "terminal");
}
