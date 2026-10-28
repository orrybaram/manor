import * as ContextMenu from "@radix-ui/react-context-menu";
import ArrowRightLeft from "lucide-react/dist/esm/icons/arrow-right-left";
import { useProjectStore } from "../../store/project-store";
import { openMoveToWorkspacePicker, type MoveToWorkspaceRequest } from "../../store/move-to-workspace-store";
import { workspaceMoveTargets } from "../../lib/workspace-move-targets";
import { hasOwnClaim } from "../../lib/detach";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import type { WorkspaceKey } from "../../lib/workspace-key";
import styles from "./MoveToWorkspacePicker.module.css";

type Props = {
  /** The workspace the tab or pane is in. */
  from: WorkspaceKey | null | undefined;
  target: MoveToWorkspaceRequest["target"];
  /** The menu's own item class, so it looks like its neighbours. */
  className: string;
  /** Lucide icon beside the label, as the pane menus have; tab menus don't. */
  withIcon?: boolean;
};

/**
 * "Move to Workspace…" in a pane's or a tab's context menu: opens the picker
 * where the menu was opened. Disabled, saying why, when the project has no
 * other workspace on this host.
 *
 * Desk only — a phone has no new UI for this. And not in a detached window,
 * which shows one claimed tab: the move would close it and leave nothing to
 * follow, so it is made from the main window.
 */
export function MoveToWorkspaceMenuItem({ from, target, className, withIcon = false }: Props) {
  const desk = useLayoutMode() === "desk";
  const hasTargets = useProjectStore((s) =>
    from ? workspaceMoveTargets(s.projects, from).length > 0 : false,
  );
  if (!desk || !from || hasOwnClaim()) return null;

  if (!hasTargets) {
    return (
      <ContextMenu.Item className={`${className} ${styles.menuItemDisabled}`} disabled>
        {withIcon && <ArrowRightLeft size={14} />}
        <span className={styles.menuItemText}>
          Move to Workspace…
          <span className={styles.menuItemHint}>No other workspaces in this project</span>
        </span>
      </ContextMenu.Item>
    );
  }
  return (
    <ContextMenu.Item
      className={className}
      data-testid="move-to-workspace-item"
      onSelect={() => openMoveToWorkspacePicker(from, target)}
    >
      {withIcon && <ArrowRightLeft size={14} />}
      Move to Workspace…
    </ContextMenu.Item>
  );
}
