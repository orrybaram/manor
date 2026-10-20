import type { HTMLAttributes } from "react";
import styles from "./CountBadge.module.css";

type CountBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  count: number;
  /**
   * `xs` sits inside small uppercase headers (a sidebar host section),
   * `sm` next to 11–12px labels (the Ports header), `md` in menus and
   * larger headings.
   */
  size?: "xs" | "sm" | "md";
  /** `neutral` for a tally; `accent` when the count is the point, e.g. a drag. */
  tone?: "neutral" | "accent";
};

/**
 * A number in a small rounded chip. The caller spaces and positions it via
 * `className`; the badge only draws itself.
 */
export function CountBadge(props: CountBadgeProps) {
  const { count, size = "sm", tone = "neutral", className, ...rest } = props;
  return (
    <span
      {...rest}
      className={`${styles.badge} ${styles[size]} ${styles[tone]} ${className ?? ""}`}
    >
      {count}
    </span>
  );
}
