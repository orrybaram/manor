import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plus } from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { usePaneDrag } from "../contexts/PaneDragContext";
import { SessionButton } from "./SessionButton";
import styles from "./TabBar.module.css";

const EMPTY_STYLE: React.CSSProperties = {};
const TAB_GAP = 2; // matches .sessions CSS gap

export function TabBar() {
  const ws = useAppStore(selectActiveWorkspace);
  const sessions = useMemo(() => ws?.sessions ?? [], [ws?.sessions]);
  const selectedSessionId = ws?.selectedSessionId ?? null;
  const selectSession = useAppStore((s) => s.selectSession);
  const addSession = useAppStore((s) => s.addSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const reorderSessions = useAppStore((s) => s.reorderSessions);
  const togglePinSession = useAppStore((s) => s.togglePinSession);
  const pinnedSessionIds = useMemo(() => ws?.pinnedSessionIds ?? [], [ws?.pinnedSessionIds]);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const { startDrag, endDrag } = usePaneDrag();

  const sessionsRef = useRef<HTMLDivElement>(null);
  const handedOffToPaneDrop = useRef(false);
  const draggedPointerId = useRef(0);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartX = useRef(0);
  const dragActive = useRef(false);
  const dragCleanedUp = useRef(false);
  const dropIndexRef = useRef<number | null>(null);
  const justDragged = useRef(false);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const itemWidths = useRef<number[]>([]);

  const handleDragStart = useCallback(
    (idx: number, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      // Don't start drag when clicking the close button
      const target = e.target as HTMLElement;
      if (target.closest(`.${styles.sessionClose}`)) return;

      const tabEl = e.currentTarget as HTMLElement;
      dragStartX.current = e.clientX;
      dragActive.current = false;
      dragCleanedUp.current = false;
      draggedPointerId.current = e.pointerId;
      handedOffToPaneDrop.current = false;

      // Snapshot item widths
      const widths: number[] = [];
      for (let i = 0; i < sessions.length; i++) {
        const el = itemRefs.current.get(i);
        widths[i] = el ? el.getBoundingClientRect().width + TAB_GAP : 80;
      }
      itemWidths.current = widths;

      tabEl.setPointerCapture(e.pointerId);

      // Compute drag boundaries: pinned tabs stay in pinned zone, unpinned in unpinned zone
      const pinnedCount = pinnedSessionIds.length;
      const isDraggedPinned = pinnedSessionIds.includes(sessions[idx].id);
      const minIdx = isDraggedPinned ? 0 : pinnedCount;
      const maxIdx = isDraggedPinned ? pinnedCount - 1 : sessions.length - 1;

      const onMove = (ev: globalThis.PointerEvent) => {
        const dx = ev.clientX - dragStartX.current;
        if (!dragActive.current && Math.abs(dx) < 4) return;

        if (!dragActive.current) {
          dragActive.current = true;
          setDragIndex(idx);
          setDropIndex(idx);
        }

        setDragOffset(dx);

        let offset = 0;
        let targetIdx = idx;
        if (dx < 0) {
          for (let i = idx - 1; i >= minIdx; i--) {
            offset -= itemWidths.current[i];
            if (dx < offset + itemWidths.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        } else {
          for (let i = idx + 1; i <= maxIdx; i++) {
            offset += itemWidths.current[i];
            if (dx > offset - itemWidths.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        }
        targetIdx = Math.max(minIdx, Math.min(maxIdx, targetIdx));
        dropIndexRef.current = targetIdx;
        setDropIndex(targetIdx);

        // Check if pointer has left the tab bar area (dragged down into pane area)
        const sessionsEl = sessionsRef.current;
        if (sessionsEl && dragActive.current) {
          const barRect = sessionsEl.getBoundingClientRect();
          if (ev.clientY > barRect.bottom + 20) {
            // Release pointer capture so pane drop zones can receive events
            try { tabEl.releasePointerCapture(draggedPointerId.current); } catch {}
            startDrag({ type: "tab", sessionId: sessions[idx].id });
            handedOffToPaneDrop.current = true;
            // Clean up tab bar drag visuals
            setDragIndex(null);
            setDropIndex(null);
            setDragOffset(0);

            // Global listener to end drag if user drops outside any pane
            const globalCleanup = () => {
              requestAnimationFrame(() => {
                endDrag();
              });
              document.removeEventListener("pointerup", globalCleanup);
            };
            document.addEventListener("pointerup", globalCleanup);
          }
        }
      };

      const onUp = () => {
        if (handedOffToPaneDrop.current) {
          handedOffToPaneDrop.current = false;
          tabEl.removeEventListener("pointermove", onMove);
          tabEl.removeEventListener("pointerup", onUp);
          tabEl.removeEventListener("lostpointercapture", onUp);
          dragActive.current = false;
          dropIndexRef.current = null;
          setDragIndex(null);
          setDropIndex(null);
          setDragOffset(0);
          return;
        }

        if (dragCleanedUp.current) return;
        dragCleanedUp.current = true;

        tabEl.removeEventListener("pointermove", onMove);
        tabEl.removeEventListener("pointerup", onUp);
        tabEl.removeEventListener("lostpointercapture", onUp);

        if (dragActive.current) {
          justDragged.current = true;
          const finalDrop = dropIndexRef.current ?? idx;
          if (finalDrop !== idx) {
            const ids = sessions.map((s) => s.id);
            const [moved] = ids.splice(idx, 1);
            ids.splice(finalDrop, 0, moved);
            reorderSessions(ids);
          }
          requestAnimationFrame(() => {
            justDragged.current = false;
          });
        }
        dragActive.current = false;
        dropIndexRef.current = null;
        setDragIndex(null);
        setDropIndex(null);
        setDragOffset(0);
      };

      tabEl.addEventListener("pointermove", onMove);
      tabEl.addEventListener("pointerup", onUp);
      tabEl.addEventListener("lostpointercapture", onUp);
    },
    [sessions, reorderSessions, pinnedSessionIds, startDrag, endDrag],
  );

  const getTransformStyle = (idx: number): React.CSSProperties => {
    if (dragIndex === null || dropIndex === null) return EMPTY_STYLE;
    const w = itemWidths.current[dragIndex] || 80;
    if (idx === dragIndex) {
      return {
        transform: `translateX(${dragOffset}px)`,
        zIndex: 10,
      };
    }
    if (dragIndex === dropIndex) return { transition: "transform 150ms ease" };
    if (
      (dropIndex > dragIndex && idx > dragIndex && idx <= dropIndex) ||
      (dropIndex < dragIndex && idx < dragIndex && idx >= dropIndex)
    ) {
      const direction = dropIndex > dragIndex ? -1 : 1;
      return {
        transform: `translateX(${direction * w}px)`,
        transition: "transform 150ms ease",
      };
    }
    return { transition: "transform 150ms ease" };
  };

  return (
    <div
      className={`${styles.sessionBar} ${!sidebarVisible ? styles.noSidebar : ""}`}
    >
      <div ref={sessionsRef} className={styles.sessions}>
        {sessions.map((session, idx) => (
          <SessionButton
            key={session.id}
            sessionId={session.id}
            isActive={session.id === selectedSessionId}
            isPinned={pinnedSessionIds.includes(session.id)}
            canClose={true}
            isDragging={dragIndex === idx}
            onSelect={() => {
              if (!justDragged.current) selectSession(session.id);
            }}
            onClose={() => closeSession(session.id)}
            onTogglePin={() => togglePinSession(session.id)}
            onPointerDown={pinnedSessionIds.includes(session.id) ? undefined : (e) => handleDragStart(idx, e)}
            style={getTransformStyle(idx)}
            buttonRef={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
          />
        ))}
        <button className={styles.addButton} onClick={addSession}>
          <Plus size={14} />
        </button>
      </div>
      <div className={styles.spacer} />
    </div>
  );
}
