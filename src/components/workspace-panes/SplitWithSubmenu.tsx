import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Bot from "lucide-react/dist/esm/icons/bot";
import { useAppStore } from "../../store/app-store";
import { getAgentCommand } from "../../agent-defaults";
import styles from "./PaneLayout/PaneLayout.module.css";

type SplitWithSubmenuProps = {
  paneId: string;
  containerRef: React.RefObject<HTMLElement | null>;
};

export function SplitWithSubmenu({ paneId, containerRef }: SplitWithSubmenuProps) {
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);

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
            onSelect={() => splitPaneAt(paneId, getDir(), "second")}
          >
            <SquareTerminal size={14} />
            Terminal
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneAt(paneId, getDir(), "second", "browser")}
          >
            <Globe size={14} />
            Browser
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => splitPaneAt(paneId, getDir(), "second", "diff")}
          >
            <GitCompareArrows size={14} />
            Diff
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              const command = getAgentCommand(useAppStore.getState().activeWorkspacePath);
              splitPaneAt(paneId, getDir(), "second", "task", command);
            }}
          >
            <Bot size={14} />
            Task
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
