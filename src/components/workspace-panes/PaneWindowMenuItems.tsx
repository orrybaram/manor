import * as ContextMenu from "@radix-ui/react-context-menu";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import CornerUpLeft from "lucide-react/dist/esm/icons/corner-up-left";
import {
  hasOwnClaim,
  movePaneToNewWindow,
  panesInOwnClaim,
  returnToPrimaryWindow,
} from "../../lib/detach";
import styles from "./PaneLayout/PaneLayout.module.css";

/**
 * The window-placement entries shared by every pane context menu, so a pane can
 * be popped out (or sent back) without discovering the drag tear-off.
 *
 * "New window" makes the pane a tab and opens a window claiming it (ADR-179
 * D4); "back to the main window" is this window closing, which releases the
 * claim. A detached window's sole pane offers no "new window" — popping it out
 * would leave this window holding nothing, which closes it.
 */
export function PaneWindowMenuItems({ paneId }: { paneId: string }) {
  const isDetached = hasOwnClaim();
  const isSolePaneOfPopout = isDetached && panesInOwnClaim() === 1;

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
          onSelect={() => returnToPrimaryWindow()}
        >
          <CornerUpLeft size={14} />
          Move Back to Main Window
        </ContextMenu.Item>
      )}
    </>
  );
}
