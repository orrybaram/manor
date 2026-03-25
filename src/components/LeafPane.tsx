import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Crosshair } from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { usePaneDrag } from "../contexts/PaneDragContext";
import { TerminalPane } from "./TerminalPane";
import { BrowserPane, type BrowserPaneRef, type BrowserPaneNavState } from "./BrowserPane";
import { PaneDropZone } from "./PaneDropZone";
import { Tooltip } from "./Tooltip";

import styles from "./PaneLayout.module.css";
import browserStyles from "./BrowserPane.module.css";

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
  const contentType = useAppStore((s) => s.paneContentType[paneId]);
  const paneUrl = useAppStore((s) => s.paneUrl[paneId]);

  const focusPane = useAppStore((s) => s.focusPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const { drag, startDrag, endDrag } = usePaneDrag();
  const isFocused = focusedPaneId === paneId;

  const browserRef = useRef<BrowserPaneRef>(null);
  const [navState, setNavState] = useState<BrowserPaneNavState | null>(null);

  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);

  const showDropZone =
    drag !== null && !(drag.type === "pane" && drag.paneId === paneId);

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

  const handleStatusBarPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (e.button !== 0) return;
    // Don't start drag when clicking a button
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;

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
        try {
          statusBarEl.releasePointerCapture(pointerId);
        } catch {
          /* may already be released */
        }
        startDrag({ type: "pane", paneId });
      }
    };

    const cleanup = () => {
      statusBarEl.removeEventListener("pointermove", onMove);
      statusBarEl.removeEventListener("pointerup", onUp);
      statusBarEl.removeEventListener("lostpointercapture", onCaptureLost);
    };

    const onUp = () => {
      cleanup();
      dragActive.current = false;
    };

    // When pointer capture is released to start the drag, clean up status bar
    // listeners but keep dragActive true so the global cleanup can handle
    // drops that land outside any drop zone.
    const onCaptureLost = () => {
      cleanup();
    };

    statusBarEl.addEventListener("pointermove", onMove);
    statusBarEl.addEventListener("pointerup", onUp);
    statusBarEl.addEventListener("lostpointercapture", onCaptureLost);

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
        {contentType === "browser" ? (
          <div className={styles.paneNavControls}>
            <Tooltip label="Back">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.goBack()}
                disabled={!navState?.canGoBack}
                title="Back"
              >
                <ArrowLeft size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Forward">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.goForward()}
                disabled={!navState?.canGoForward}
                title="Forward"
              >
                <ArrowRight size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Reload">
              <button
                className={styles.paneStatusBtn}
                onClick={() => browserRef.current?.reload()}
                title="Reload"
              >
                <RotateCw size={12} />
              </button>
            </Tooltip>
            <input
              className={styles.paneUrlInput}
              value={navState?.url ?? ""}
              onChange={browserRef.current?.urlInputHandlers.onChange ?? (() => {})}
              onKeyDown={browserRef.current?.urlInputHandlers.onKeyDown}
              onBlur={browserRef.current?.urlInputHandlers.onBlur}
              onFocus={browserRef.current?.urlInputHandlers.onFocus}
              placeholder="Enter URL"
              spellCheck={false}
            />
            <Tooltip label="Pick element">
              <button
                className={`${styles.paneStatusBtn} ${navState?.pickerActive ? styles.paneStatusBtnActive : ""}`}
                onClick={() => browserRef.current?.startPicker()}
                title="Pick element"
              >
                <Crosshair size={12} />
              </button>
            </Tooltip>
          </div>
        ) : (
          <span className={styles.paneStatusTitle}>{title}</span>
        )}
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
      {contentType === "browser" && navState && navState.suggestions.length > 0 && (
        <div className={browserStyles.autocompleteDropdown}>
          {navState.suggestions.map((entry, idx) => (
            <div
              key={entry.url}
              className={`${browserStyles.autocompleteItem} ${idx === navState.highlightIndex ? browserStyles.autocompleteItemHighlighted : ""}`}
              onMouseDown={() => browserRef.current?.onSuggestionMouseDown(entry)}
            >
              <span className={browserStyles.autocompleteTitle}>{entry.title || entry.url}</span>
              <span className={browserStyles.autocompleteUrl}>{entry.url}</span>
            </div>
          ))}
        </div>
      )}
      <div className={styles.leafTerminal}>
        {contentType === "browser" ? (
          <BrowserPane
            ref={browserRef}
            paneId={paneId}
            initialUrl={paneUrl ?? "about:blank"}
            onNavStateChange={setNavState}
          />
        ) : (
          <TerminalPane paneId={paneId} cwd={workspacePath} />
        )}
      </div>
      {showDropZone && <PaneDropZone paneId={paneId} />}
    </div>
  );
}
