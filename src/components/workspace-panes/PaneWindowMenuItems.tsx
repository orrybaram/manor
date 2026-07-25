import * as ContextMenu from "@radix-ui/react-context-menu";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import CornerUpLeft from "lucide-react/dist/esm/icons/corner-up-left";
import {
  countPanesInWindow,
  movePaneToNewWindow,
  movePaneToMainWindow,
} from "../../lib/window-handoff";
import styles from "./PaneLayout/PaneLayout.module.css";

/**
 * The window-placement entries shared by every pane context menu, so a pane can
 * be popped out (or sent back) without discovering the drag tear-off.
 *
 * A popout's sole pane offers no "new window" — tearing it out would leave this
 * window empty and it would close itself, which is a no-op with extra steps.
 */
export function PaneWindowMenuItems({ paneId }: { paneId: string }) {
  const isDetached = !!window.electronAPI?.isDetached;
  const isSolePaneOfPopout = isDetached && countPanesInWindow() === 1;

  return (
    <>
      {!isSolePaneOfPopout && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          onSelect={() => void movePaneToNewWindow(paneId)}
        >
          <ExternalLink size={14} />
          Move to New Window
        </ContextMenu.Item>
      )}
      {isDetached && (
        <ContextMenu.Item
          className={styles.contextMenuItem}
          onSelect={() => void movePaneToMainWindow(paneId)}
        >
          <CornerUpLeft size={14} />
          Move Back to Main Window
        </ContextMenu.Item>
      )}
    </>
  );
}
