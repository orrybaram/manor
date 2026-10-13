import type { ReactNode, UIEventHandler } from "react";
import { PullIndicator } from "./PullIndicator";
import { usePullToRefresh } from "./usePullToRefresh";

type PullToRefreshProps = {
  /** Keep it stable: a new function re-attaches the touch listeners. */
  onRefresh: () => Promise<void>;
  /** The scroller's own class; it must scroll for the pull to start at its top. */
  className?: string;
  onScroll?: UIEventHandler<HTMLDivElement>;
  children: ReactNode;
};

/**
 * A scroller with pull-to-refresh (ADR-220 D5): the indicator, and the
 * scroller it rides over. The parent is the positioned box the indicator
 * sits in.
 */
export function PullToRefresh(props: PullToRefreshProps) {
  const { onRefresh, className, onScroll, children } = props;

  const { ref, pull, refreshing } = usePullToRefresh(onRefresh);

  return (
    <>
      <PullIndicator pull={pull} refreshing={refreshing} />
      <div ref={ref} className={className} onScroll={onScroll}>
        {children}
      </div>
    </>
  );
}
