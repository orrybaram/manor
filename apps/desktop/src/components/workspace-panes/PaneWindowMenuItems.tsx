import * as ContextMenu from "@radix-ui/react-context-menu";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import CornerUpLeft from "lucide-react/dist/esm/icons/corner-up-left";
import {
  hasOwnClaim,
  movePaneToNewWindow,
  panesInOwnClaim,
  returnToPrimaryWindow,
} from "../../lib/detach";
import { MoveToWorkspaceMenuItem } from "../move-to-workspace/MoveToWorkspaceMenuItem";
import type { WorkspaceKey } from "../../lib/workspace-key";
import styles from "./PaneLayout/PaneLayout.module.css";

/**
 * The window-placement entries shared by every pane context menu, so a pane can
 * be popped out (or sent back) without discovering the drag tear-off, or
 * sent to another workspace of its project.
 *
 * "New window" makes the pane a tab and opens a window claiming it; "back to the main window" is this window closing, which releases the
 * claim. A detached window's sole pane offers no "new window" — popping it out
 * would leave this window holding nothing, which closes it.
 */
export function PaneWindowMenuItems({
  paneId,
  workspaceKey,
}: {
  paneId: string;
  /** The workspace the pane is in; without it there is no "Move to Workspace…". */
  workspaceKey?: WorkspaceKey;
}) {
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
      <MoveToWorkspaceMenuItem
        from={workspaceKey}
        target={{ paneId }}
        className={styles.contextMenuItem}
        withIcon
      />
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
