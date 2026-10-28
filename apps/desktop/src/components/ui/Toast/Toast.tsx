import { useRef } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { setToastStackHovered, useToasts } from "../../../toast";
import { ToastItem } from "./ToastItem";
import styles from "./Toast.module.css";

export function ToastContainer() {
  const toasts = useToasts();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stopWatchingRef = useRef<(() => void) | null>(null);

  // `mouseleave` never fires when the toast under the pointer is removed, so
  // while hovered, any pointer arrival outside the stack also ends the hold.
  function stopHover() {
    stopWatchingRef.current?.();
    stopWatchingRef.current = null;
    setToastStackHovered(false);
  }

  function startHover() {
    setToastStackHovered(true);
    if (stopWatchingRef.current) return;
    const onPointerOver = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el || !(e.target instanceof Node) || !el.contains(e.target)) stopHover();
    };
    document.addEventListener("pointerover", onPointerOver, true);
    stopWatchingRef.current = () =>
      document.removeEventListener("pointerover", onPointerOver, true);
  }

  useMountEffect(() => stopHover);

  if (toasts.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onMouseEnter={startHover}
      onMouseLeave={stopHover}
    >
      {toasts.map((t) => (
        <ToastItem key={`${t.id}-${t.status}`} toast={t} />
      ))}
    </div>
  );
}
