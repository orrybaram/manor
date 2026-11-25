import {
  formatNavCount,
  needsYouPhrase,
  useNeedsYouCount,
} from "../../../hooks/useNeedsYouCount";
import styles from "./NeedsYouBadge.module.css";

/**
 * The Dashboard row's Needs you count: a solid pill at the row's end, and
 * ", 7 need you" for the row's accessible name. Nothing at 0. Its own
 * component so the count's stores re-render only this, not the sidebar.
 */
export function NeedsYouPill() {
  const count = useNeedsYouCount();
  if (count === 0) return null;
  return (
    <>
      <span
        className={`${styles.badge} ${styles.pill}`}
        data-testid="needs-you-count"
        aria-hidden="true"
      >
        {formatNavCount(count)}
      </span>
      <span className="sr-only">, {needsYouPhrase(count)}</span>
    </>
  );
}

type NeedsYouCornerBadgeProps = {
  count: number;
};

/**
 * The same count on an icon button's top-right corner, ringed in the frame
 * colour. Decorative: the button's own label carries the count.
 */
export function NeedsYouCornerBadge(props: NeedsYouCornerBadgeProps) {
  const { count } = props;
  if (count === 0) return null;
  return (
    <span
      className={`${styles.badge} ${styles.corner}`}
      data-testid="needs-you-count"
      aria-hidden="true"
    >
      {formatNavCount(count)}
    </span>
  );
}
