import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { HouseFloor as HouseFloorModel } from "../../../store/house-floor-store";
import { useHouseFloorStore } from "../../../store/house-floor-store";
import { useThemeStore, type Theme } from "../../../store/theme-store";
import { floorHeight, floorLabel } from "./floor-layout";
import { FloorRenderer, frameLoop, type FloorColors, type FrameLoop } from "./floor-renderer";
import styles from "./HouseFloor.module.css";

function floorColors(theme: Theme | null): FloorColors {
  if (theme) return { dot: theme.foreground, gold: theme.yellow };
  // Before the theme loads: whatever the CSS variables hold.
  const css = getComputedStyle(document.documentElement);
  return {
    dot: css.getPropertyValue("--fg").trim() || "#e9e3d3",
    gold: css.getPropertyValue("--yellow").trim() || "#ffe800",
  };
}

/**
 * The house floor at the end of the sidebar's Agents list: a whole-rows grid
 * of sockets that fills with dots as things end. It is at least tall enough
 * for every row, and grows to fill any room the agent rows leave, with the
 * floor sitting at its bottom.
 *
 * Drawing happens in frames only while something moves (a dot fading in);
 * otherwise a change of dots, theme or size paints once. Frames stop while
 * the window is hidden or the floor is scrolled out of view.
 */
export function HouseFloor({ floor }: { floor: HouseFloorModel }) {
  const { dots, floorSize, cols, rows, seed, awake } = floor;
  const theme = useThemeStore((s) => s.theme);
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
    const renderer = new FloorRenderer(canvas);
    const loop = frameLoop(renderer, () => visibleRef.current);
    rendererRef.current = renderer;
    loopRef.current = loop;
    return () => {
      loop.stop();
      rendererRef.current = null;
      loopRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    rendererRef.current?.setColors(floorColors(theme));
    requestDraw();
  }, [theme, requestDraw]);

  useLayoutEffect(() => {
    rendererRef.current?.setModel({ dots, cols, rows, seed, awake }, performance.now());
    requestDraw();
  }, [dots, cols, rows, seed, awake, requestDraw]);

  // Size: the width sets the columns (through the store); the canvas covers
  // the wrapper, which is at least the floor's height.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      useHouseFloorStore.getState().setWidth(width);
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.setSize(width, height, window.devicePixelRatio || 1);
      // Resizing cleared the canvas: repaint now, not a frame later.
      renderer.draw(performance.now());
    });
    observer.observe(wrap);
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

  const state = awake ? "awake" : "filling";
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
        aria-label={floorLabel(dots, floorSize, awake)}
        data-state={state}
        data-dots={dots}
        data-floor-size={floorSize}
      />
    </div>
  );
}
