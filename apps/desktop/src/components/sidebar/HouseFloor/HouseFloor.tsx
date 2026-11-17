import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HouseFloor as HouseFloorModel } from "../../../store/house-floor-store";
import { useHouseFloorStore } from "../../../store/house-floor-store";
import { floorGridWidth, floorHeight, floorLabel, type FloorPhase } from "./floor-layout";
import { floorColors, FloorRenderer, frameLoop, type FrameLoop } from "./floor-renderer";
import styles from "./HouseFloor.module.css";

/**
 * The house floor at the end of the sidebar's Agents list: a whole-rows grid
 * of sockets that fills with dots as things end. It is at least tall enough
 * for every row, and grows to fill any room the agent rows leave, with the
 * floor sitting at its bottom.
 *
 * Full, it wakes; the mouse feeds it by hovering (touch and pen by
 * dragging), and a cleared floor plays Settle before the next floor starts.
 *
 * Drawing happens in frames only while something moves (a dot fading in,
 * the awake floor breathing, a feed, Settle); otherwise a change of dots,
 * theme or size paints once. Frames stop while the window is hidden or the
 * floor is scrolled out of view, and a folded section unmounts it.
 */
export function HouseFloor({ floor }: { floor: HouseFloorModel }) {
  const { dots, floorSize, cols, rows, seed, awake, meals, eat } = floor;
  const [phase, setPhase] = useState<FloorPhase>("filling");
  // Settle calls back from a frame; it eats with the latest stats.
  const eatRef = useRef(eat);
  useLayoutEffect(() => {
    eatRef.current = eat;
  }, [eat]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FloorRenderer | null>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  /** On screen: in view and the window not hidden. */
  const visibleRef = useRef(true);

  const requestDraw = useCallback(() => loopRef.current?.request(), []);

  // The renderer and its frames live as long as the canvas.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new FloorRenderer(canvas, {
      onPhase: setPhase,
      onFed: () => eatRef.current(),
    });
    const loop = frameLoop(renderer, () => visibleRef.current);
    rendererRef.current = renderer;
    loopRef.current = loop;
    return () => {
      loop.stop();
      rendererRef.current = null;
      loopRef.current = null;
    };
  }, []);

  // Colours: what the app is painted with right now (`--fg`, `--yellow` on
  // the root, which every theme change rewrites), followed as they change.
  useLayoutEffect(() => {
    const root = document.documentElement;
    let last = "";
    const apply = () => {
      const colors = floorColors(getComputedStyle(root));
      const key = `${colors.dot} ${colors.gold}`;
      if (key === last) return;
      last = key;
      rendererRef.current?.setColors(colors);
      requestDraw();
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => observer.disconnect();
  }, [requestDraw]);

  useLayoutEffect(() => {
    rendererRef.current?.setModel({ dots, cols, rows, seed, awake, meals }, performance.now());
    requestDraw();
  }, [dots, cols, rows, seed, awake, meals, requestDraw]);

  // Reduced motion, followed live: no swell, breath, ring or pop.
  useLayoutEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const apply = () => {
      rendererRef.current?.setReducedMotion(query.matches);
      requestDraw();
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [requestDraw]);

  // Feeding: a mouse feeds by hovering, touch and pen by dragging.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Touch or pen held down (a mouse feeds by hovering, so its button is
    // never tracked: an up outside the canvas would leave it stuck).
    let down = false;
    const at = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    const draw = (needed: boolean) => {
      if (needed) requestDraw();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      down = true;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      draw(rendererRef.current?.pointerDown(...at(e)) ?? false);
    };
    const onMove = (e: PointerEvent) => {
      const active = e.pointerType === "mouse" || down;
      draw(rendererRef.current?.pointerMove(...at(e), active) ?? false);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      down = false;
      rendererRef.current?.pointerUp();
      draw(rendererRef.current?.pointerLeave() ?? false);
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !down) draw(rendererRef.current?.pointerLeave() ?? false);
    };
    const onCancel = () => {
      down = false;
      draw(rendererRef.current?.pointerLeave() ?? false);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointercancel", onCancel);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointercancel", onCancel);
    };
  }, [requestDraw]);

  // Size: the width sets the columns (through the store); the canvas covers
  // the wrapper, which is at least the floor's height.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const body = wrap.parentElement;
    const observer = new ResizeObserver(() => {
      // Columns come from the list's own width less a fixed scrollbar
      // allowance, so they never change as the list starts or stops
      // overflowing; the grid then centres in the canvas as it is.
      if (body) useHouseFloorStore.getState().setWidth(floorGridWidth(body.offsetWidth));
      const { width, height } = wrap.getBoundingClientRect();
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.setSize(width, height, window.devicePixelRatio || 1);
      // Resizing cleared the canvas: repaint now, not a frame later.
      renderer.draw(performance.now());
    });
    observer.observe(wrap);
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // Frames pause off screen; coming back paints, and resumes any fade.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let inView = true;
    const update = () => {
      const visible = inView && document.visibilityState !== "hidden";
      if (visible && !visibleRef.current) requestDraw();
      visibleRef.current = visible;
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            update();
          });
    observer?.observe(wrap);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [requestDraw]);

  return (
    <div
      ref={wrapRef}
      className={styles.floor}
      style={{ minHeight: floorHeight(rows) }}
      data-testid="house-floor"
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={floorLabel(dots, floorSize, phase)}
        data-state={phase}
        data-meals={meals}
        data-dots={dots}
        data-floor-size={floorSize}
      />
    </div>
  );
}
