import type { ReactNode } from "react";
import styles from "./Panel.module.css";

type PanelProps = {
  title: string;
  /** Dim text after the title ("Last 3 hours"). */
  sub?: ReactNode;
  /** Right-aligned header content: a legend, a "View all" link. */
  right?: ReactNode;
  /** Extra class for placement. */
  className?: string;
  children: ReactNode;
};

/**
 * A titled dashboard section (ADR-198 §1): the soft panel every Studio
 * section sits in — Needs you, and the activity / pipeline / Up next slots.
 */
export function Panel(props: PanelProps) {
  const { title, sub, right, className, children } = props;

  return (
    <section className={[styles.panel, className].filter(Boolean).join(" ")} aria-label={title}>
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {sub != null && <span className={styles.sub}>{sub}</span>}
        {right != null && <div className={styles.right}>{right}</div>}
      </div>
      {children}
    </section>
  );
}
