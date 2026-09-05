import { useCallback, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  flattenRows,
  type DropTarget,
  type Row,
  type SidebarItem,
} from "../utils/sidebar-items";
import { useDragOverlayStore } from "../store/drag-overlay-store";

/** Vertical gap between sidebar rows, from `ProjectItem.module.css`. */
const ROW_GAP = 8;
/** Fallback row height when an element never registered (never rendered). */
const FALLBACK_HEIGHT = 36;
/**
 * Extra pixels above and below a folder header that still read as "drop into
 * this folder". Rows shift out from under the pointer as it approaches, so
 * the header's own box is a narrow target; the buffer makes it forgiving.
 */
const INTO_BUFFER = 8;
/** Additional buffer while already targeting a folder, so the band does not
 * flicker off when the pointer drifts a few pixels. */
const INTO_STICKY = 10;
/** Prefix for the `rowRefs` entry holding a folder's header element. */
const HEADER_PREFIX = "header:";

/** `rowRefs` key for a folder's header element (its block registers by id). */
export function headerRefKey(folderId: string): string {
  return `${HEADER_PREFIX}${folderId}`;
}

type HeaderRect = { folderId: string; rowIndex: number; top: number; height: number };

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
  const dragKindRef = useRef<"workspace" | "folder">("workspace");
  /** Folder header rects as measured at drag start (workspace drags only). */
  const headerRects = useRef<HeaderRect[]>([]);

  const handleDragStart = useCallback(
    (key: string, kind: "workspace" | "folder", e: ReactPointerEvent) => {
      if (disabled) return;
      if (e.button !== 0) return;

      const rows = flattenRows(items, collapsedFolderIds, kind);
      const sourceIndex = rows.findIndex((row) => row.key === key);
      if (sourceIndex === -1) return;

      const target = e.currentTarget as HTMLElement;
      dragStartY.current = e.clientY;
      dragActive.current = false;
      dragCleanedUp.current = false;
      rowsRef.current = rows;
      sourceIndexRef.current = sourceIndex;
      dragKindRef.current = kind;

      // A folder drag moves whole blocks, so it measures `.folder`; a
      // workspace drag walks past headers and members, so a folder row is
      // just its header.
      const elementFor = (row: Row): HTMLElement | undefined =>
        row.kind === "folder" && kind === "workspace"
          ? rowRefs.current.get(headerRefKey(row.key))
          : rowRefs.current.get(row.key);

      const heights: number[] = [];
      const headers: HeaderRect[] = [];
      const sourceParentId = rows[sourceIndex].parentFolderId;
      rows.forEach((row, i) => {
        const el = elementFor(row);
        const rect = el?.getBoundingClientRect();
        heights[i] = rect ? rect.height + ROW_GAP : FALLBACK_HEIGHT;
        // Dropping a member onto its own folder's header would only append it
        // to the folder it is already in, and it would make dragging the first
        // member up to the top impossible. Skip that header.
        if (
          kind === "workspace" &&
          row.kind === "folder" &&
          rect &&
          row.key !== sourceParentId
        ) {
          headers.push({
            folderId: row.key,
            rowIndex: i,
            top: rect.top,
            height: rect.height,
          });
        }
      });
      rowHeights.current = heights;
      headerRects.current = headers;

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

        let offset = 0;
        let targetIdx = sourceIndex;
        if (dy < 0) {
          for (let i = sourceIndex - 1; i >= 0; i--) {
            offset -= heights[i];
            if (dy < offset + heights[i] / 2) targetIdx = i;
            else break;
          }
        } else {
          for (let i = sourceIndex + 1; i < rows.length; i++) {
            offset += heights[i];
            if (dy > offset - heights[i] / 2) targetIdx = i;
            else break;
          }
        }

        // Into-detection runs against the rects measured at drag start, not
        // against wherever a neighbour shift has pushed a header. That is
        // exact while `into` is active (it suppresses every shift, so headers
        // sit at their start rects) and only slightly generous on the way in,
        // where the band is at most one row height off.
        // Into-detection. A header sits at its start rect while nothing has
        // shifted, and one dragged-row height away once the slot search has
        // moved it aside; the pointer may be over either, so the band is the
        // union of both boxes plus a buffer. While a folder is already the
        // target the rows are pinned (no shift) and the band grows a little
        // more so it does not flicker off.
        let into: string | null = null;
        const sourceH = heights[sourceIndex];
        for (const header of headerRects.current) {
          const i = header.rowIndex;
          let shift = 0;
          if (targetIdx > sourceIndex && i > sourceIndex && i <= targetIdx) {
            shift = -sourceH;
          } else if (targetIdx < sourceIndex && i < sourceIndex && i >= targetIdx) {
            shift = sourceH;
          }
          const top = Math.min(header.top, header.top + shift);
          const bottom = Math.max(
            header.top + header.height,
            header.top + header.height + shift,
          );
          const pad =
            INTO_BUFFER +
            (intoFolderIdRef.current === header.folderId ? INTO_STICKY : 0);
          if (ev.clientY >= top - pad && ev.clientY <= bottom + pad) {
            into = header.folderId;
            break;
          }
        }
        // Landing "into" a folder moves no neighbours.
        if (into) targetIdx = sourceIndex;

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
    [items, collapsedFolderIds, disabled, onDrop],
  );

  /**
   * The transform for one rendered element. Workspaces pass their path; a
   * folder passes its id for the block and `headerRefKey(id)` for the header,
   * and only the one the current drag measures gets a transform — during a
   * workspace drag the header shifts on its own while its members shift
   * individually, during a folder drag the whole block moves.
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
        if (isHeaderKey !== (dragKindRef.current === "workspace")) {
          return undefined;
        }
      } else if (isHeaderKey) {
        return undefined;
      }

      const dragIndex = sourceIndexRef.current;
      if (idx === dragIndex) {
        return { transform: `translateY(${dragOffset}px)`, zIndex: 10 };
      }
      // Hovering a folder header lifts the row out of the list entirely.
      if (intoFolderId) return { transition: "transform 150ms ease" };
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
    [dragKey, dropIndex, dragOffset, intoFolderId],
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
