import { useEffect, useRef, useState } from "react";
import { useDragOverlayStore, selectIsDragActive } from "../../../store/drag-overlay-store";
import {
  dockViewState,
  dockViewStateKey,
  overlaysCover,
  type DockRect,
} from "../../../lib/devtools-dock";
import { overlaysAbove } from "./devtools-overlays";

/** The hidden view's last frame, painted in its slot while Manor UI covers it. */
export interface DevToolsSnapshot {
  url: string;
  width: number;
  height: number;
}

/**
 * Keep `paneId`'s docked DevTools, a native view painted above all HTML, over
 * `slot`. Under Manor UI, a pane drag or a resize of the split the view hides
 * and its last frame comes back to paint in its place; off screen (an
 * inactive tab or workspace) it just hides.
 *
 * Checked every frame while DevTools are open: a pane can move without
 * resizing (a split, a sidebar collapsing) and an overlay can open without
 * any event reaching here. Only changes cross to main.
 */
export function useDevToolsDockBounds(
  paneId: string,
  slot: HTMLElement | null,
  resizing: boolean,
): DevToolsSnapshot | null {
  const [snapshot, setSnapshot] = useState<DevToolsSnapshot | null>(null);
  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;

  useEffect(() => {
    if (!slot) return;
    const api = window.electronAPI.webview;
    let applied = "";
    let frame = 0;

    const sync = () => {
      frame = requestAnimationFrame(sync);
      const box = slot.getBoundingClientRect();
      const rect: DockRect = { x: box.left, y: box.top, width: box.width, height: box.height };
      const rendered =
        slot.closest("[data-hidden-layer]") === null &&
        slot.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const state = dockViewState({
        slot: rect,
        rendered,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dragging: selectIsDragActive(useDragOverlayStore.getState()),
        resizing: resizingRef.current,
        covered: rendered && overlaysCover(rect, overlaysAbove(slot)),
      });
      const key = dockViewStateKey(state, window.devicePixelRatio);
      if (key === applied) return;
      applied = key;

      if (state.kind === "shown") {
        setSnapshot(null);
        void api.setDevToolsBounds(paneId, state.rect);
        return;
      }
      if (state.kind === "hidden") setSnapshot(null);
      void api
        .setDevToolsBounds(paneId, null, state.kind === "covered")
        .then((url) => {
          // Still covered: a show since then must not be painted over.
          if (url && applied === key) {
            setSnapshot({ url, width: rect.width, height: rect.height });
          }
        });
    };

    sync();
    return () => {
      cancelAnimationFrame(frame);
      void api.setDevToolsBounds(paneId, null);
    };
  }, [paneId, slot]);

  return snapshot;
}
