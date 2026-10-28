import { useState, type DragEvent } from "react";
import { usePaneDrag } from "../workspace-panes/PaneDragContext";
import { useProjectStore } from "../../store/project-store";
import { moveToWorkspaceAndFollow } from "../../store/workspace-actions";
import { canMoveToWorkspace } from "../../lib/workspace-move-targets";
import { find } from "../../lib/workspace-directory";
import type { WorkspaceKey } from "../../lib/workspace-key";

/**
 * Sidebar rows as drop targets for a pane or tab drag (the HTML5 one that
 * starts in a pane's status bar or on a tab, `PaneDragContext`), which moves
 * it to that workspace. Separate from the sidebar's own pointer drag, which
 * reorders rows and never fires a `drop`.
 *
 * Only a workspace `workspaceMoveTargets` offers takes the drop. While the
 * drag is live everything else in the sidebar fades back: the source row,
 * other projects, other hosts' sections and Home (`useMoveDragActive`).
 */

/**
 * The project the pane or tab being dragged belongs to, while one is: its
 * id, or null when its workspace is no project's (Home). Undefined when no
 * pane or tab is being dragged.
 */
export function useMoveDragSourceProject(): string | null | undefined {
  const { drag } = usePaneDrag();
  const from = drag?.workspaceKey;
  const projectId = useProjectStore((s) =>
    from ? (find(s.projects, from)?.project.id ?? null) : null,
  );
  if (!drag) return undefined;
  return projectId;
}

/** What one workspace row is during a pane or tab drag. */
interface WorkspaceMoveDrop {
  /** `off`: no drag. `valid`: takes the drop. `invalid`: fades back. */
  state: "off" | "valid" | "invalid";
  /** A valid row with the drag over it. */
  hot: boolean;
  handlers: {
    onDragEnter: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
}

/** The drop target for the workspace row keyed `key`. */
export function useWorkspaceMoveDrop(key: WorkspaceKey): WorkspaceMoveDrop {
  const { drag, endDrag } = usePaneDrag();
  const from = drag?.workspaceKey;
  const valid = useProjectStore((s) =>
    from ? canMoveToWorkspace(s.projects, from, key) : false,
  );
  const [over, setOver] = useState(false);
  // A drag that ended anywhere leaves no row lit.
  const accepting = drag !== null && valid;
  const hot = over && accepting;
  if (over && drag === null) setOver(false);

  return {
    state: drag === null ? "off" : valid ? "valid" : "invalid",
    hot,
    handlers: {
      onDragEnter: (e) => {
        if (!accepting) return;
        e.preventDefault();
        setOver(true);
      },
      onDragOver: (e) => {
        // Not preventing the default is what refuses the drop, and leaves the
        // source's `dropEffect` "none".
        if (!accepting) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDragLeave: (e) => {
        // Leaving for one of the row's own children is still over the row.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (e) => {
        if (!drag || !from || !valid) return;
        e.preventDefault();
        setOver(false);
        const target = drag.type === "pane" ? { paneId: drag.paneId } : { tabId: drag.tabId };
        // Ended here as well as on the source's dragend: the move unmounts the
        // source, and Chromium may then never fire it (as `TabBar`'s drop).
        endDrag();
        void moveToWorkspaceAndFollow(from, target, key);
      },
    },
  };
}
