import { useCallback, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  flattenRows,
  type DropTarget,
  type Row,
  type SidebarItem,
} from "../utils/sidebar-items";
import { useDragOverlayStore } from "../store/drag-overlay-store";
import { useLayoutMode } from "./useLayoutMode";

/** Vertical gap between sidebar rows, from `ProjectItem.module.css`. */
const ROW_GAP = 8;
/** Fallback row height when an element never registered (never rendered). */
const FALLBACK_HEIGHT = 36;
/**
 * Share of a folder header, trimmed from each edge, that still reorders
 * rather than drops into the folder. The middle of the header is "into"; its
 * edges are the slots before and after it, so two folders side by side always
 * leave a reorder gap between them.
 */
const INTO_EDGE = 0.25;
/** Prefix for the `rowRefs` entry holding a folder's header element. */
const HEADER_PREFIX = "header:";

/** `rowRefs` key for a folder's header element (its block registers by id). */
export function headerRefKey(folderId: string): string {
  return `${HEADER_PREFIX}${folderId}`;
}

/**
 * The sidebar's single drag: one instance per project, keyed by `Row.key`
 * rather than by index so a workspace, a folder header and a folder block can
 * all take part in the same gesture.
 *
 * The hook only measures geometry and turns the pointer into a `DropTarget`;
 * every placement decision lives in `applyDrop` (see `utils/sidebar-items.ts`).
 */
export function useSidebarDrag({
  items,
  collapsedFolderIds,
  disabled,
  onDrop,
}: {
  items: SidebarItem[];
  collapsedFolderIds: Set<string>;
  /** Blocks new drags, e.g. while an inline rename input is open. */
  disabled: boolean;
  onDrop: (sourceKey: string, target: DropTarget, rows: Row[]) => void;
}) {
  // ADR-181 D5: a pointerdown-driven reorder like `Sidebar.tsx`'s project
  // drag — `setPointerCapture` below claims the gesture the instant a finger
  // lands on a workspace or folder row, ahead of both the drawer's own
  // scroll and a long-press opening that row's context menu. No touch idiom
  // needs reordering the sidebar, so it is off in phone mode.
  const isPhone = useLayoutMode() === "phone";
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [intoFolderId, setIntoFolderId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  const dropIndexRef = useRef<number | null>(null);
  const intoFolderIdRef = useRef<string | null>(null);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);
  const dragCleanedUp = useRef(false);
  const justDragged = useRef(false);

  /** key → element. Workspaces by path, folder blocks by id, headers by
   * `headerRefKey(id)`. */
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const rowsRef = useRef<Row[]>([]);
  const rowHeights = useRef<number[]>([]);
  const sourceIndexRef = useRef(0);
  /** Folders whose children are rows of the current drag: they measure and
   * move by their header alone, every other folder by its whole block. */
  const openFolderIds = useRef<Set<string>>(new Set());

  const handleDragStart = useCallback(
    (key: string, kind: "workspace" | "folder", e: ReactPointerEvent) => {
      if (disabled || isPhone) return;
      if (e.button !== 0) return;

      // The dragged key goes in so a folder drag never offers a slot inside
      // the block that is moving with the pointer (ADR-172).
      const rows = flattenRows(items, collapsedFolderIds, kind, key);
      const sourceIndex = rows.findIndex((row) => row.key === key);
      if (sourceIndex === -1) return;

      const target = e.currentTarget as HTMLElement;
      dragStartY.current = e.clientY;
      dragActive.current = false;
      dragCleanedUp.current = false;
      rowsRef.current = rows;
      sourceIndexRef.current = sourceIndex;

      // A folder whose children are rows is measured by its header, since each
      // child is measured on its own; any other folder — collapsed, a block
      // of a folder drag, or the dragged folder itself — is one row spanning
      // its whole block. No pixel is counted twice, and since a block's
      // contents are never rows, no transform ever compounds with an
      // ancestor's.
      const open = new Set<string>();
      for (const row of rows) {
        if (row.parentFolderId !== null) open.add(row.parentFolderId);
      }
      openFolderIds.current = open;
      const elementFor = (row: Row): HTMLElement | undefined =>
        row.kind === "folder" && open.has(row.key)
          ? rowRefs.current.get(headerRefKey(row.key))
          : rowRefs.current.get(row.key);

      const sourceParentId = rows[sourceIndex].parentFolderId;
      const heights: number[] = [];
      // Header height of every folder the source may be dropped into, 0 for
      // any other row. Dropping a row onto the header of the folder it is
      // already directly inside would change nothing, and for a member it
      // would make dragging the first member up to the top impossible, so
      // that header is skipped — as is the dragged folder's own. Its subtree
      // needs no skipping: `flattenRows` never emitted it.
      const intoHeights: number[] = [];
      rows.forEach((row, i) => {
        const rect = elementFor(row)?.getBoundingClientRect();
        heights[i] = rect ? rect.height + ROW_GAP : FALLBACK_HEIGHT;
        intoHeights[i] =
          row.kind === "folder" && i !== sourceIndex && row.key !== sourceParentId
            ? (rowRefs.current.get(headerRefKey(row.key))?.getBoundingClientRect()
                .height ?? 0)
            : 0;
      });
      rowHeights.current = heights;

      target.setPointerCapture(e.pointerId);

      const onMove = (ev: globalThis.PointerEvent) => {
        const dy = ev.clientY - dragStartY.current;
        if (!dragActive.current && Math.abs(dy) < 4) return;

        if (!dragActive.current) {
          dragActive.current = true;
          useDragOverlayStore.getState().incrementDragCount();
          setDragKey(key);
          setDropIndex(sourceIndex);
        }

        setDragOffset(dy);

        // Walk outward from the source, one row at a time. Crossing a row's
        // midpoint moves the slot past it; crossing the middle of a folder's
        // header targets that folder instead, and the slot stays where it was
        // before the folder, so the header sits still under the dragged row.
        //
        // Both are decided from `dy` alone against the heights measured at
        // drag start, never from where a shift has since moved a row, so the
        // target cannot flicker as neighbours slide out from under the
        // pointer. Going down the dragged row's leading edge meets a folder's
        // header first; going up it meets the block's bottom first and the
        // header last.
        let offset = 0;
        let targetIdx = sourceIndex;
        let into: string | null = null;
        if (dy < 0) {
          for (let i = sourceIndex - 1; i >= 0; i--) {
            offset -= heights[i];
            const header = intoHeights[i];
            if (
              header > 0 &&
              dy >= offset + header * INTO_EDGE &&
              dy <= offset + header * (1 - INTO_EDGE)
            ) {
              into = rows[i].key;
              break;
            }
            if (dy < offset + heights[i] / 2) targetIdx = i;
            else break;
          }
        } else {
          for (let i = sourceIndex + 1; i < rows.length; i++) {
            const start = offset;
            offset += heights[i];
            const header = intoHeights[i];
            if (
              header > 0 &&
              dy >= start + header * INTO_EDGE &&
              dy <= start + header * (1 - INTO_EDGE)
            ) {
              into = rows[i].key;
              break;
            }
            if (dy > offset - heights[i] / 2) targetIdx = i;
            else break;
          }
        }

        if (intoFolderIdRef.current !== into) {
          intoFolderIdRef.current = into;
          setIntoFolderId(into);
        }
        if (dropIndexRef.current !== targetIdx) {
          dropIndexRef.current = targetIdx;
          setDropIndex(targetIdx);
        }
      };

      const onUp = () => {
        if (dragCleanedUp.current) return;
        dragCleanedUp.current = true;

        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("lostpointercapture", onUp);

        if (dragActive.current) {
          useDragOverlayStore.getState().decrementDragCount();
          // Swallows the click the browser fires after the drag.
          justDragged.current = true;
          const into = intoFolderIdRef.current;
          const finalDrop = dropIndexRef.current ?? sourceIndex;
          if (into) {
            onDrop(key, { type: "into", folderId: into }, rows);
          } else if (finalDrop !== sourceIndex) {
            onDrop(key, { type: "slot", rowIndex: finalDrop }, rows);
          }
          requestAnimationFrame(() => {
            justDragged.current = false;
          });
        }
        dragActive.current = false;
        dropIndexRef.current = null;
        intoFolderIdRef.current = null;
        setDragKey(null);
        setDropIndex(null);
        setIntoFolderId(null);
        setDragOffset(0);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("lostpointercapture", onUp);
    },
    [items, collapsedFolderIds, disabled, isPhone, onDrop],
  );

  /**
   * The transform for one rendered element. Workspaces pass their path; a
   * folder passes its id for the block and `headerRefKey(id)` for the header,
   * and only the one the current drag measures gets a transform — an open
   * folder's header shifts on its own while its children shift individually,
   * any other folder moves as a whole block.
   */
  const getTransformStyle = useCallback(
    (key: string): CSSProperties | undefined => {
      if (dragKey === null || dropIndex === null) return undefined;

      const isHeaderKey = key.startsWith(HEADER_PREFIX);
      const rowKey = isHeaderKey ? key.slice(HEADER_PREFIX.length) : key;
      const rows = rowsRef.current;
      const idx = rows.findIndex((row) => row.key === rowKey);
      if (idx === -1) return undefined;
      if (rows[idx].kind === "folder") {
        if (isHeaderKey !== openFolderIds.current.has(rowKey)) return undefined;
      } else if (isHeaderKey) {
        return undefined;
      }

      const dragIndex = sourceIndexRef.current;
      if (idx === dragIndex) {
        return { transform: `translateY(${dragOffset}px)`, zIndex: 10 };
      }
      if (dragIndex === dropIndex) return { transition: "transform 150ms ease" };

      const h = rowHeights.current[dragIndex] || FALLBACK_HEIGHT;
      if (
        (dropIndex > dragIndex && idx > dragIndex && idx <= dropIndex) ||
        (dropIndex < dragIndex && idx < dragIndex && idx >= dropIndex)
      ) {
        const direction = dropIndex > dragIndex ? -1 : 1;
        return {
          transform: `translateY(${direction * h}px)`,
          transition: "transform 150ms ease",
        };
      }
      return { transition: "transform 150ms ease" };
    },
    [dragKey, dropIndex, dragOffset],
  );

  return {
    dragKey,
    intoFolderId,
    justDragged,
    rowRefs,
    handleDragStart,
    getTransformStyle,
  };
}
