import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./Collapse.module.css";

type CollapseProps = {
  open: boolean;
  children: ReactNode;
  /** Turn the height transition off, e.g. while a drag is sizing the body. */
  animate?: boolean;
};

/**
 * `mounting` renders the body at zero height for one frame so `opening` has a
 * starting point to transition from; `open` is settled and stops clipping.
 */
type Phase = "closed" | "mounting" | "opening" | "open" | "closing";

const DURATION_MS = 180;

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Animates a section's body open and closed by transitioning its grid row
 * between `0fr` and `1fr`, so the content keeps its natural height. Children
 * mount when opening and unmount once the close has finished, so a closed
 * section costs nothing to render.
 */
export function Collapse(props: CollapseProps) {
  const { open, children, animate = true } = props;
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const rootRef = useRef<HTMLDivElement>(null);
  const instant = !animate || prefersReducedMotion();

  if (open && (phase === "closed" || phase === "closing")) {
    setPhase(instant ? "open" : phase === "closed" ? "mounting" : "opening");
  } else if (!open && phase !== "closed" && phase !== "closing") {
    setPhase(instant ? "closed" : "closing");
  }

  useEffect(() => {
    if (phase === "mounting") {
      void rootRef.current?.offsetHeight;
      const frame = requestAnimationFrame(() => setPhase("opening"));
      return () => cancelAnimationFrame(frame);
    }
    if (phase === "opening" || phase === "closing") {
      // `transitionend` finishes the phase; this covers a body with no height
      // to transition, which never fires one.
      const next = phase === "opening" ? "open" : "closed";
      const timer = window.setTimeout(() => setPhase(next), DURATION_MS + 50);
      return () => window.clearTimeout(timer);
    }
  }, [phase]);

  if (phase === "closed") return null;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-state={phase === "opening" || phase === "open" ? "open" : "closed"}
      data-animate={animate ? undefined : "false"}
      data-settled={phase === "open" || undefined}
      style={{ "--collapse-duration": `${DURATION_MS}ms` } as React.CSSProperties}
      inert={!open || undefined}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase === "opening") setPhase("open");
        else if (phase === "closing") setPhase("closed");
      }}
    >
      <div className={styles.inner}>{children}</div>
    </div>
  );
}
