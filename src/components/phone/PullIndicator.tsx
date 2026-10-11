import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import styles from "./PullIndicator.module.css";

type PullIndicatorProps = {
  /** How far the pull has travelled, in px (`usePullToRefresh`). */
  pull: number;
  refreshing: boolean;
};

/** The spinner a pull-to-refresh drags down from the top of its scroller. */
export function PullIndicator(props: PullIndicatorProps) {
  const { pull, refreshing } = props;

  if (pull <= 0 && !refreshing) return null;
  return (
    <div
      className={styles.indicator}
      data-testid="pull-indicator"
      data-refreshing={refreshing || undefined}
      style={{ transform: `translateY(${pull}px)`, opacity: Math.min(pull / 48, 1) }}
      aria-hidden
    >
      <RefreshCw
        size={16}
        className={styles.icon}
        style={refreshing ? undefined : { transform: `rotate(${pull * 3}deg)` }}
      />
    </div>
  );
}
