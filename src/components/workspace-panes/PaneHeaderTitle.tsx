import { useAppStore } from "../../store/app-store";
import { paneHeaderTitle } from "../../lib/pane-title";

type PaneHeaderTitleProps = {
  paneId: string;
  className?: string;
};

/**
 * A pane header's title text. The title is cleaned in the selector, so a
 * spinner frame that leaves it unchanged re-renders nothing.
 */
export function PaneHeaderTitle(props: PaneHeaderTitleProps) {
  const { paneId, className } = props;

  const title = useAppStore((s) => paneHeaderTitle(s, paneId));

  return <span className={className}>{title}</span>;
}
