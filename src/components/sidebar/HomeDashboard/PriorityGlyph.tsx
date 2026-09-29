import styles from "./UpNextPanel.module.css";

/** Bars filled per Linear priority: High 3, Medium 2, Low 1; none 0. */
const FILLED: Record<number, number> = { 2: 3, 3: 2, 4: 1 };
const LABEL: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

type PriorityGlyphProps = {
  /** Linear priority: 1 Urgent … 4 Low, 0 / absent none. */
  priority?: number;
};

/** Linear-style priority mark for an Up next row (ADR-198 §2). */
export function PriorityGlyph(props: PriorityGlyphProps) {
  const { priority = 0 } = props;
  const label = LABEL[priority] ?? "No priority";

  if (priority === 1) {
    return (
      <span className={styles.urgent} role="img" aria-label={label}>
        !
      </span>
    );
  }

  const filled = FILLED[priority] ?? 0;
  return (
    <span className={styles.prio} role="img" aria-label={label}>
      {[1, 2, 3].map((bar) => (
        <i key={bar} data-on={bar <= filled ? "" : undefined} />
      ))}
    </span>
  );
}
