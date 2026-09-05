import React from "react";
import type { WorkspaceInfo } from "../../store/project-store";
import { useWorkspaceDrag } from "../../hooks/useWorkspaceDrag";
import styles from "./ProjectItem.module.css";

/**
 * Everything a rendered workspace row needs from the drag hook that owns it.
 * `idx` is *section-local* — the index inside this list, not the index into
 * `project.workspaces`. Callers that need a global index recover it
 * themselves.
 */
export type WorkspaceDragProps = {
  idx: number;
  isDragging: boolean;
  getTransformStyle: (idx: number) => React.CSSProperties | undefined;
  justDragged: React.RefObject<boolean>;
  itemRefCallback: (el: HTMLDivElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
};

type WorkspaceListProps = {
  /** Visible members of this section, in render order. */
  workspaces: WorkspaceInfo[];
  editingPath: string | null;
  /** Receives this section's paths in their new order. */
  onReorder: (sectionPaths: string[]) => void;
  renderWorkspace: (
    ws: WorkspaceInfo,
    drag: WorkspaceDragProps,
  ) => React.ReactNode;
  className?: string;
};

/**
 * One drag-orderable section of workspaces (the loose list, or one folder's
 * members). Owns a single `useWorkspaceDrag` instance scoped to its own
 * array, so dragging inside a folder never disturbs the other sections.
 */
export function WorkspaceList(props: WorkspaceListProps) {
  const { workspaces, editingPath, onReorder, renderWorkspace, className } =
    props;

  const {
    dragIndex,
    handleDragStart,
    getTransformStyle,
    justDragged,
    itemRefs,
  } = useWorkspaceDrag({
    workspaces,
    onReorderWorkspaces: onReorder,
    editingPath,
  });

  return (
    <div
      className={`${styles.workspaces}${className ? ` ${className}` : ""}`}
    >
      {workspaces.map((ws, idx) =>
        renderWorkspace(ws, {
          idx,
          isDragging: dragIndex === idx,
          getTransformStyle,
          justDragged,
          itemRefCallback: (el) => {
            if (el) itemRefs.current.set(idx, el);
            else itemRefs.current.delete(idx);
          },
          onPointerDown: (e) => handleDragStart(idx, e),
        }),
      )}
    </div>
  );
}
