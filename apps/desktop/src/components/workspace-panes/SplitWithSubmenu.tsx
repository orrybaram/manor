import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Bot from "lucide-react/dist/esm/icons/bot";
import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { getAgentCommand } from "../../agent-defaults";
import { splitPaneWith } from "../../lib/pane-actions";
import styles from "./PaneLayout/PaneLayout.module.css";

type SplitWithSubmenuProps = {
  paneId: string;
  containerRef: React.RefObject<HTMLElement | null>;
};

export function SplitWithSubmenu({ paneId, containerRef }: SplitWithSubmenuProps) {
  const getDir = () => {
    const el = containerRef.current;
    return el && el.offsetWidth >= el.offsetHeight ? "horizontal" : "vertical";
  };

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={styles.contextMenuItem}>
        Split with
        <ChevronRight size={14} style={{ marginLeft: "auto" }} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneWith(paneId, getDir())}
          >
            <SquareTerminal size={14} />
            Terminal
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneWith(paneId, getDir(), "browser")}
          >
            <Globe size={14} />
            Browser
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneWith(paneId, getDir(), "scm")}
          >
            <GitBranch size={14} />
            Source Control
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              const command = getAgentCommand(selectActiveWorkspaceKey(useAppStore.getState()));
              splitPaneWith(paneId, getDir(), "agent", command);
            }}
          >
            <Bot size={14} />
            Agent
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
