import { create } from "zustand";
import type { WorkspaceKey } from "../lib/workspace-key";

/** What "Move to Workspace…" was picked for, and where to open the picker. */
export interface MoveToWorkspaceRequest {
  /** The workspace the tab or pane is in now. */
  from: WorkspaceKey;
  target: { paneId: string } | { tabId: string };
  /** Where the right-click happened, in viewport pixels. */
  point: { x: number; y: number };
}

interface MoveToWorkspaceState {
  request: MoveToWorkspaceRequest | null;
  close: () => void;
}

/**
 * The open "Move to Workspace…" picker, if any. A context menu item opens it
 * and is gone by the time it shows (the menu closes on select), so the one
 * `MoveToWorkspacePicker` the app mounts reads it from here.
 */
export const useMoveToWorkspaceStore = create<MoveToWorkspaceState>((set) => ({
  request: null,
  close: () => set({ request: null }),
}));

// The last right-click, recorded by the picker's host. A menu item only
// knows it was selected; the menu itself opened where this happened.
let lastContextMenuPoint = { x: 0, y: 0 };

/** Remember where a `contextmenu` event happened, for the next picker. */
export function rememberContextMenuPoint(e: MouseEvent): void {
  lastContextMenuPoint = { x: e.clientX, y: e.clientY };
}

/** Open the picker for `target` in `from`, where the last right-click was. */
export function openMoveToWorkspacePicker(
  from: WorkspaceKey,
  target: MoveToWorkspaceRequest["target"],
): void {
  useMoveToWorkspaceStore.setState({
    request: { from, target, point: lastContextMenuPoint },
  });
}
