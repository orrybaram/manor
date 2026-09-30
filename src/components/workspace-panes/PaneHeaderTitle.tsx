import { useAppStore } from "../../store/app-store";
import { paneHeaderTitle } from "../../lib/pane-title";

type PaneHeaderTitleProps = {
  paneId: string;
  className?: string;
};

/**
 * A pane header's title text. The only subscriber to the pane's raw live
 * title, so each spinner frame an agent writes re-renders just this span,
 * not the pane around it.
 */
export function PaneHeaderTitle(props: PaneHeaderTitleProps) {
  const { paneId, className } = props;

  const title = useAppStore((s) =>
    paneHeaderTitle(s.paneTitle[paneId], s.paneCwd[paneId]),
  );

  return <span className={className}>{title}</span>;
}
