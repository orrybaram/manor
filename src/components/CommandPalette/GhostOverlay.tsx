import { useMemo } from "react";
import styles from "./CommandPalette.module.css";

function generateGhostStyles() {
  return Array.from({ length: 50 }, () => ({
    left: `${Math.random() * 90 + 5}%`,
    animationDelay: `${Math.random() * 2}s`,
    animationDuration: `${2 + Math.random() * 2}s`,
    fontSize: `${24 + Math.random() * 32}px`,
    ghostPeak: `${0.4 + Math.random() * 0.4}`,
    ghostRotate: `${Math.random() * 90 - 45}deg`,
    emoji: Math.random() < 0.2 ? "\u{1F987}" : "\u{1F47B}",
  }));
}

export function GhostOverlay() {
  const ghosts = useMemo(() => generateGhostStyles(), []);

  return (
    <div className={styles.ghostOverlay} aria-hidden>
      {ghosts.map((ghost, i) => (
        <span
          key={i}
          className={styles.ghost}
          style={{
            left: ghost.left,
            animationDelay: ghost.animationDelay,
            animationDuration: ghost.animationDuration,
            fontSize: ghost.fontSize,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ["--ghost-peak" as any]: ghost.ghostPeak,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ["--ghost-rotate" as any]: ghost.ghostRotate,
          }}
        >
          {ghost.emoji}
        </span>
      ))}
    </div>
  );
}
