import type { CSSProperties, ReactNode } from "react";
import styles from "./StatTiles.module.css";

type StatTileProps = {
  label: string;
  /** The tile's accent: label dot, bold foot text, chart. */
  color: string;
  value: ReactNode;
  /** Dim text beside the big number ("oldest 2d"). */
  aside?: ReactNode;
  foot?: ReactNode;
  children?: ReactNode;
};

/** One of the four stat tiles (ADR-198 §1.3): mockup `.stat`. */
export function StatTile(props: StatTileProps) {
  const { label, color, value, aside, foot, children } = props;

  return (
    <div className={styles.tile} style={{ "--c": color } as CSSProperties}>
      <div className={styles.label}>
        <i className={styles.dot} />
        {label}
      </div>
      <div className={styles.big}>
        <span className={styles.num}>{value}</span>
        {aside != null && <small className={styles.aside}>{aside}</small>}
      </div>
      {foot != null && <div className={styles.foot}>{foot}</div>}
      {children}
    </div>
  );
}
