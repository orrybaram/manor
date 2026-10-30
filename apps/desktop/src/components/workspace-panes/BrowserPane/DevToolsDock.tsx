import { useCallback, useState } from "react";
import PanelBottom from "lucide-react/dist/esm/icons/panel-bottom";
import PanelRight from "lucide-react/dist/esm/icons/panel-right";
import X from "lucide-react/dist/esm/icons/x";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { dockFractionAt, type DevToolsDockSide } from "../../../lib/devtools-dock";
import { useDevToolsDockBounds } from "./useDevToolsDockBounds";

import styles from "./BrowserPane.module.css";

type DevToolsDockProps = {
  paneId: string;
  side: DevToolsDockSide;
  /** DevTools' share of the pane, already clamped. */
  fraction: number;
  /** The box holding the page and DevTools, measured while dragging. */
  splitRef: React.RefObject<HTMLDivElement | null>;
  onFractionChange: (fraction: number) => void;
  onSideChange: (side: DevToolsDockSide) => void;
  /** While the split is being dragged, so the page can stop taking the pointer. */
  onResizingChange: (resizing: boolean) => void;
};

/**
 * The drag handle and DevTools region of a browser pane. Rendered after the
 * page's box inside the split, so opening DevTools never remounts the
 * `<webview>`. The slot is empty: main lays a native view over it
 * (`useDevToolsDockBounds`).
 */
export function DevToolsDock(props: DevToolsDockProps) {
  const { paneId, side, fraction, splitRef, onFractionChange, onSideChange, onResizingChange } =
    props;
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const snapshot = useDevToolsDockBounds(paneId, slot, resizing);

  const setResizingBoth = useCallback(
    (next: boolean) => {
      setResizing(next);
      onResizingChange(next);
    },
    [onResizingChange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizingBoth(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing || !splitRef.current) return;
    const box = splitRef.current.getBoundingClientRect();
    onFractionChange(
      dockFractionAt(
        side,
        { x: e.clientX, y: e.clientY },
        { x: box.left, y: box.top, width: box.width, height: box.height },
      ),
    );
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setResizingBoth(false);
  };

  const nextSide: DevToolsDockSide = side === "bottom" ? "right" : "bottom";
  const sideLabel = nextSide === "right" ? "Dock to right" : "Dock to bottom";

  return (
    <>
      <div
        className={`${styles.devToolsHandle} ${resizing ? styles.devToolsHandleActive : ""}`}
        role="separator"
        aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
        aria-label="Resize DevTools"
        data-testid="devtools-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={() => resizing && setResizingBoth(false)}
      />
      <section
        className={styles.devTools}
        style={{ flex: `${fraction} 1 0` }}
        aria-label="DevTools"
        data-devtools-dock={side}
      >
        {/* Tooltips go up: below, they would cover DevTools and hide them. */}
        <div className={styles.devToolsHeader}>
          <span className={styles.devToolsTitle}>DevTools</span>
          <Tooltip label={sideLabel} side="top">
            <button
              className={styles.devToolsBtn}
              onClick={() => onSideChange(nextSide)}
              aria-label={sideLabel}
              data-testid="devtools-dock-side"
            >
              {nextSide === "right" ? <PanelRight size={12} /> : <PanelBottom size={12} />}
            </button>
          </Tooltip>
          <Tooltip label="Close DevTools" side="top">
            <button
              className={styles.devToolsBtn}
              onClick={() => void window.electronAPI.webview.closeDevTools(paneId)}
              aria-label="Close DevTools"
            >
              <X size={12} />
            </button>
          </Tooltip>
        </div>
        <div ref={setSlot} className={styles.devToolsSlot} data-testid="devtools-slot">
          {snapshot && (
            <img
              alt=""
              src={snapshot.url}
              className={styles.devToolsSnapshot}
              style={{ width: snapshot.width, height: snapshot.height }}
            />
          )}
        </div>
      </section>
    </>
  );
}
