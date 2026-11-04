import * as ContextMenu from "@radix-ui/react-context-menu";
import PanelBottom from "lucide-react/dist/esm/icons/panel-bottom";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import PanelRight from "lucide-react/dist/esm/icons/panel-right";
import PanelTop from "lucide-react/dist/esm/icons/panel-top";
import type { WorkspaceKey } from "../../lib/workspace-key";
import { useAppStore } from "../../store/app-store";
import { ConvertToSubmenu } from "./ConvertToSubmenu";
import { PaneWindowMenuItems } from "./PaneWindowMenuItems";
import { SplitWithSubmenu } from "./SplitWithSubmenu";
import styles from "./TerminalPane/TerminalPane.module.css";

type PaneMenuItemsProps = {
  paneId: string;
  workspaceKey?: WorkspaceKey;
  containerRef: React.RefObject<HTMLElement | null>;
};

/**
 * What a right-click in an agent pane offers for the pane itself, whichever
 * view it shows: split it, split with something, convert it, move it. The
 * terminal and the chat put their own items around these.
 */
export function PaneMenuItems({ paneId, workspaceKey, containerRef }: PaneMenuItemsProps) {
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);

  return (
    <>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => splitPaneAt(paneId, "horizontal", "second")}
      >
        <PanelRight size={14} />
        Split Right
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => splitPaneAt(paneId, "horizontal", "first")}
      >
        <PanelLeft size={14} />
        Split Left
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => splitPaneAt(paneId, "vertical", "second")}
      >
        <PanelBottom size={14} />
        Split Down
      </ContextMenu.Item>
      <ContextMenu.Item
        className={styles.contextMenuItem}
        onSelect={() => splitPaneAt(paneId, "vertical", "first")}
      >
        <PanelTop size={14} />
        Split Up
      </ContextMenu.Item>

      <ContextMenu.Separator className={styles.contextMenuSeparator} />

      <SplitWithSubmenu paneId={paneId} containerRef={containerRef} />

      <ContextMenu.Separator className={styles.contextMenuSeparator} />

      <ConvertToSubmenu paneId={paneId} />

      <ContextMenu.Separator className={styles.contextMenuSeparator} />

      <PaneWindowMenuItems paneId={paneId} workspaceKey={workspaceKey} />
    </>
  );
}
