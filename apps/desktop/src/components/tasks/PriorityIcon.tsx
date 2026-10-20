import styles from "./TasksView.module.css";

/** Linear's priority glyph: an alert square for Urgent, else 3 bars — High 3 lit, Medium 2, Low 1. */
export function PriorityIcon(props: { value: number }) {
  const { value } = props;

  if (value === 1) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={styles.priorityUrgent}
        aria-hidden
      >
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path
          d="M8 4.5v4.5"
          stroke="var(--bg)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.75" r="1.1" fill="var(--bg)" />
      </svg>
    );
  }
  const lit = 5 - value;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={styles.priorityBars}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 5}
          y={10 - i * 4}
          width="3"
          height={5 + i * 4}
          rx="1"
          fill="currentColor"
          opacity={i < lit ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}
