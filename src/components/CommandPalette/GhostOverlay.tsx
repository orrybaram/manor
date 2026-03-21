import styles from "./CommandPalette.module.css";

export function GhostOverlay() {
  return (
    <div className={styles.ghostOverlay} aria-hidden>
      {Array.from({ length: 50 }, (_, i) => (
        <span
          key={i}
          className={styles.ghost}
          style={{
            left: `${Math.random() * 90 + 5}%`,
            animationDelay: `${Math.random() * 2}s`,
            animationDuration: `${2 + Math.random() * 2}s`,
            fontSize: `${24 + Math.random() * 32}px`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ["--ghost-peak" as any]: `${0.4 + Math.random() * 0.4}`,
            ["--ghost-rotate" as any]: `${Math.random() * 90 - 45}deg`,
          }}
        >
          {Math.random() < 0.2 ? "🦇" : "👻"}
        </span>
      ))}
    </div>
  );
}
