import { useRef } from "react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { usePaneDrag } from "../contexts/PaneDragContext";
import { TerminalPane } from "./TerminalPane";
import { PaneDropZone } from "./PaneDropZone";

import styles from "./PaneLayout.module.css";

export function LeafPane({
  paneId,
  workspacePath,
}: {
  paneId: string;
  workspacePath?: string;
}) {
  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === ws.selectedSessionId);
    return session?.focusedPaneId;
  });
  const paneTitle = useAppStore((s) => s.paneTitle[paneId]);
  const paneCwd = useAppStore((s) => s.paneCwd[paneId]);

  const focusPane = useAppStore((s) => s.focusPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const { drag, startDrag, endDrag } = usePaneDrag();
  const isFocused = focusedPaneId === paneId;

  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);

  const showDropZone =
    drag !== null &&
    !(drag.type === "pane" && drag.paneId === paneId);

  let title =
    paneTitle || (paneCwd ? paneCwd.split("/").pop() : "") || "Terminal";
  // Strip "user@host:" prefix from default shell titles
  title = title.replace(/^.+@.+:/, "");

  const handleSplit = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    splitPane("horizontal");
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    closePane();
  };

  const handleStatusBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Don't start drag when clicking a button
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;

    const statusBarEl = e.currentTarget;
    const pointerId = e.pointerId;
    dragStartX.current = e.clientX;
    dragStartY.current = e.clientY;
    dragActive.current = false;

    statusBarEl.setPointerCapture(pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - dragStartX.current;
      const dy = ev.clientY - dragStartY.current;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!dragActive.current && dist < 4) return;

      if (!dragActive.current) {
        dragActive.current = true;
        // Release pointer capture so drop zones on other panes can receive events
        try { statusBarEl.releasePointerCapture(pointerId); } catch { /* may already be released */ }
        startDrag({ type: "pane", paneId });
      }
    };

    const onUp = () => {
      statusBarEl.removeEventListener("pointermove", onMove);
      statusBarEl.removeEventListener("pointerup", onUp);
      statusBarEl.removeEventListener("lostpointercapture", onUp);

      if (dragActive.current) {
        // Global cleanup handles endDrag if drop zone didn't
      }
      dragActive.current = false;
    };

    statusBarEl.addEventListener("pointermove", onMove);
    statusBarEl.addEventListener("pointerup", onUp);
    statusBarEl.addEventListener("lostpointercapture", onUp);

    // Global listener to end drag if user drops outside any pane/tab bar
    const globalCleanup = (_ev: PointerEvent) => {
      if (!dragActive.current) {
        document.removeEventListener("pointerup", globalCleanup);
        return;
      }
      requestAnimationFrame(() => {
        endDrag();
      });
      document.removeEventListener("pointerup", globalCleanup);
    };
    document.addEventListener("pointerup", globalCleanup);
  };

  const isThisPaneDragging = drag?.type === "pane" && drag.paneId === paneId;

  return (
    <div
      className={`${styles.leaf} ${isFocused ? styles.leafFocused : ""} ${isThisPaneDragging ? styles.leafDragging : ""}`}
      onMouseDown={() => focusPane(paneId)}
    >
      <div
        className={`${styles.paneStatusBar} ${isFocused ? styles.paneStatusBarFocused : ""} ${isThisPaneDragging ? styles.paneStatusBarDragging : ""}`}
        onPointerDown={handleStatusBarPointerDown}
      >
        <span className={styles.paneStatusTitle}>{title}</span>
        <div className={styles.paneStatusActions}>
          <button
            className={styles.paneStatusBtn}
            onClick={handleSplit}
            title="Split pane"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect
                x="1"
                y="1"
                width="14"
                height="14"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
              <line
                x1="8"
                y1="1.5"
                x2="8"
                y2="14.5"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
          <button
            className={styles.paneStatusBtn}
            onClick={handleClose}
            title="Close pane"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <line
                x1="3"
                y1="3"
                x2="13"
                y2="13"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <line
                x1="13"
                y1="3"
                x2="3"
                y2="13"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </div>
      </div>
      <div className={styles.leafTerminal}>
        <TerminalPane paneId={paneId} cwd={workspacePath} />
      </div>
      {showDropZone && <PaneDropZone paneId={paneId} />}
    </div>
  );
}
